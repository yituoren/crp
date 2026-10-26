import { all, get, run, tx } from './db.js';
import { audit, notify } from './util.js';
import type { AuthUser } from './auth.js';
import { teamLabelMap } from './routes/teams.js';
import { emptyProgress, finalRanking, upsertProgress } from './progressCore.js';

export const SYSTEM_USER: AuthUser = { id: 0, username: 'system', displayName: '系统', role: 'admin' };

export type EpisodeRow = { id: number; event_id: number; code: string; sort: number; status: string; budget: number; started_at: string | null; start_at: string | null; depart_base: string | null; inherit_rank: number; start_gap_min: number };

/** Start an episode: mark it running, record the start time and issue the episode budget to every alive team (once). Returns the names of the teams that received money */
export function startEpisodeNow(ep: EpisodeRow, user: AuthUser, t: string): string[] {
  const issued: string[] = [];
  const labels = teamLabelMap();
  tx(() => {
    // departure base = this start moment (the set time for a scheduled start); departures are then recorded per the plan
    run("UPDATE episodes SET status = 'running', started_at = COALESCE(started_at, ?), depart_base = COALESCE(depart_base, ?) WHERE id = ?", t, t, ep.id);
    if (!ep.started_at && ep.budget > 0) {
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

/** Automatic departure: when due, record the start time of the episode's first leg for the team (for the Starting Line the start is the departure; the follow records completion later). Existing records are left alone */
export function recordDeparture(ep: EpisodeRow, teamId: number, at: string): boolean {
  const first = get<{ id: number; sort: number; type: string }>("SELECT id, sort, type FROM legs WHERE episode_id = ? AND type != 'SQ' ORDER BY sort, id LIMIT 1", ep.id);
  if (!first) return false;
  const cur = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', ep.id, teamId, first.id) ?? emptyProgress();
  if (cur.arrived_at) return false;
  upsertProgress(ep.id, teamId, first.id, { ...cur, arrived_at: at }, SYSTEM_USER.id);
  audit(SYSTEM_USER, 'progress:auto_start', 'progress', `${ep.id}/${teamId}/${first.id}`, cur, { at });
  return true;
}
