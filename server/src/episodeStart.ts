import { all, get, run, tx } from './db.js';
import { audit, notify } from './util.js';
import type { AuthUser } from './auth.js';
import { teamLabelMap } from './routes/teams.js';
import { emptyProgress, finalRanking, upsertProgress } from './progressCore.js';

export const SYSTEM_USER: AuthUser = { id: 0, username: 'system', displayName: '系统', role: 'admin' };

export type EpisodeRow = { id: number; event_id: number; code: string; sort: number; status: string; budget: number; started_at: string | null; start_at: string | null; depart_base: string | null; inherit_rank: number; start_gap_min: number; continuous_wait_min: number | null };

export const isContinuous = (ep: EpisodeRow) => ep.continuous_wait_min !== null && ep.continuous_wait_min !== undefined;

/**
 * Start an episode: mark it running, record the start time and issue the episode budget to every alive team (once).
 * A continuous episode issues the budget per team at its departure instead (see recordDeparture). Returns the names of the teams that received money
 */
export function startEpisodeNow(ep: EpisodeRow, user: AuthUser, t: string): string[] {
  const issued: string[] = [];
  const labels = teamLabelMap();
  tx(() => {
    // departure base = this start moment (the set time for a scheduled start); departures are then recorded per the plan
    run("UPDATE episodes SET status = 'running', started_at = COALESCE(started_at, ?), depart_base = COALESCE(depart_base, ?) WHERE id = ?", t, t, ep.id);
    if (!ep.started_at && ep.budget > 0 && !isContinuous(ep)) {
      for (const team of all("SELECT id, name, currency FROM teams WHERE status = 'alive' AND event_id = ? ORDER BY sort, id", ep.event_id)) {
        const balance = team.currency + ep.budget;
        run('UPDATE teams SET currency = ? WHERE id = ?', balance, team.id);
        run(
          'INSERT INTO currency_ledger(episode_id, team_id, delta, balance_after, reason, operator_id, operator_name, created_at) VALUES (?,?,?,?,?,?,?,?)',
          ep.id, team.id, ep.budget, balance, `${ep.code} 补充经费`, user.id, user.displayName, t,
        );
        issued.push(labels.get(team.id) ?? team.name);
      }
    }
  });
  audit(user, 'start', 'episode', ep.id, { status: ep.status, started_at: ep.started_at }, { issuedBudgetTo: issued, at: t });
  notify('episodes'); notify('teams'); notify('ledger', ep.id);
  return issued;
}

/** The one start rule for every episode (manual, scheduled or continuous): it may start once the previous episode has started; episodes may overlap */
export function startBlockedReason(ep: EpisodeRow): string | null {
  const prev = previousEpisode(ep);
  return prev && prev.status === 'pending' ? `${prev.code} 还没有开始，不能开始 ${ep.code}` : null;
}

/** The previous episode in order */
export function previousEpisode(ep: EpisodeRow) {
  return get<EpisodeRow>('SELECT * FROM episodes WHERE event_id = ? AND (sort < ? OR (sort = ? AND id < ?)) ORDER BY sort DESC, id DESC LIMIT 1', ep.event_id, ep.sort, ep.sort, ep.id) ?? null;
}

/**
 * Departure plan: departure time per alive team, based on the actual start moment (scheduled start = the set time;
 * manual start = click time; not started = the set time).
 *  - Inheriting the previous ranking with a gap: in rank order, 1st departs at the base time, each next team one gap later
 *  - Otherwise every team departs at the base time
 */
export function departurePlan(ep: EpisodeRow): { teamId: number; at: string }[] {
  if (isContinuous(ep)) return continuousPlan(ep);
  const baseIso = ep.depart_base ?? ep.start_at;
  if (!baseIso) return [];
  const alive = all<{ id: number }>("SELECT id FROM teams WHERE event_id = ? AND status = 'alive' ORDER BY sort, id", ep.event_id).map((t) => t.id);
  const base = new Date(baseIso).getTime();
  const prev = ep.inherit_rank ? previousEpisode(ep) : null;
  if (!prev || ep.start_gap_min <= 0) return alive.map((teamId) => ({ teamId, at: baseIso }));
  const order = finalRanking(prev.id).filter((id) => alive.includes(id));
  for (const id of alive) if (!order.includes(id)) order.push(id);
  return order.map((teamId, i) => ({ teamId, at: new Date(base + i * ep.start_gap_min * 60000).toISOString() }));
}

/** Pit-stop check-in time per team in an episode: a manual check-in wins over the pit stop's end record */
function checkins(episodeId: number): Map<number, string> {
  const m = new Map<number, string>();
  const ps = get<{ id: number }>("SELECT id FROM legs WHERE episode_id = ? AND type = 'PS' ORDER BY sort DESC, id DESC LIMIT 1", episodeId);
  if (ps) for (const r of all<{ team_id: number; completed_at: string | null }>('SELECT team_id, completed_at FROM progress WHERE episode_id = ? AND leg_id = ?', episodeId, ps.id)) if (r.completed_at) m.set(r.team_id, r.completed_at);
  for (const r of all<{ team_id: number; checkin_at: string | null }>('SELECT team_id, checkin_at FROM pitstop_results WHERE episode_id = ?', episodeId)) if (r.checkin_at) m.set(r.team_id, r.checkin_at);
  return m;
}
/** Continuous episode: every alive team that has checked in at the previous episode's pit stop departs a fixed wait later; teams still racing there have no departure yet */
function continuousPlan(ep: EpisodeRow): { teamId: number; at: string }[] {
  const prev = previousEpisode(ep);
  if (!prev) return [];
  const wait = (ep.continuous_wait_min ?? 0) * 60000;
  const inAt = checkins(prev.id);
  return all<{ id: number }>("SELECT id FROM teams WHERE event_id = ? AND status = 'alive' ORDER BY sort, id", ep.event_id)
    .filter((t) => inAt.has(t.id))
    .map((t) => ({ teamId: t.id, at: new Date(new Date(inAt.get(t.id)!).getTime() + wait).toISOString() }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Automatic departure: when due, record the start time of the episode's first leg for the team (for the Starting Line the start is the departure; the follow records completion later). Existing records are left alone */
export function recordDeparture(ep: EpisodeRow, teamId: number, at: string): boolean {
  const first = get<{ id: number; sort: number; type: string }>("SELECT id, sort, type FROM legs WHERE episode_id = ? AND type != 'SQ' ORDER BY sort, id LIMIT 1", ep.id);
  if (!first) return false;
  const cur = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', ep.id, teamId, first.id) ?? emptyProgress();
  if (cur.arrived_at) return false;
  upsertProgress(ep.id, teamId, first.id, { ...cur, arrived_at: at }, SYSTEM_USER.id);
  audit(SYSTEM_USER, 'progress:auto_start', 'progress', `${ep.id}/${teamId}/${first.id}`, cur, { at });
  if (isContinuous(ep)) issueBudgetAtDeparture(ep, teamId, at);
  return true;
}

/** Continuous episode: the episode budget goes to each team when it departs (once per team; an episode reset clears it with the ledger) */
function issueBudgetAtDeparture(ep: EpisodeRow, teamId: number, at: string) {
  if (ep.budget <= 0) return;
  const reason = `${ep.code} 补充经费`;
  if (get('SELECT 1 FROM currency_ledger WHERE episode_id = ? AND team_id = ? AND reason = ? AND reverts_id IS NULL', ep.id, teamId, reason)) return;
  const team = get<{ currency: number }>('SELECT currency FROM teams WHERE id = ?', teamId);
  if (!team) return;
  const balance = team.currency + ep.budget;
  tx(() => {
    run('UPDATE teams SET currency = ? WHERE id = ?', balance, teamId);
    run('INSERT INTO currency_ledger(episode_id, team_id, delta, balance_after, reason, operator_id, operator_name, created_at) VALUES (?,?,?,?,?,?,?,?)',
      ep.id, teamId, ep.budget, balance, reason, SYSTEM_USER.id, SYSTEM_USER.displayName, at);
  });
  notify('teams'); notify('ledger', ep.id);
}
