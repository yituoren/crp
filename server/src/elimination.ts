import { all, get, run } from './db.js';

/**
 * Automatic elimination, two kinds:
 * - Sudden death on a leg flagged as eliminating: once every team still racing has arrived at that leg, the last N
 *   to arrive are eliminated (finishing the task does not matter). Arrival = start time + the net penalty recorded on
 *   the episode's earlier legs; every leg type, the pit stop included, works the same way.
 * - Episode elimination (set on the episode): once every team still racing has checked in at the pit stop, the last N
 *   by check-in + the episode's net penalty are eliminated (recorded on the pit stop, or the last leg without one).
 * Results are recomputed after any record changes, so teams come back or get eliminated again, until the episode is
 * finished: a finished episode keeps the eliminations it had. Withdrawn teams are excluded.
 */
type LegRow = { id: number; episode_id: number; type: string; sort: number; can_eliminate: number; eliminate_count: number };
type EpisodeRow = { id: number; status: string; eliminate_count: number };

/** Leg order across the whole event: episodes by sort, legs by sort */
export function legOrder(eventId: number): LegRow[] {
  return all<LegRow>(
    `SELECT l.id, l.episode_id, l.type, l.sort, l.can_eliminate, l.eliminate_count FROM legs l JOIN episodes e ON e.id = l.episode_id
     WHERE e.event_id = ? ORDER BY e.sort, e.id, l.sort, l.id`, eventId,
  );
}

/** A team's arrival on a leg: its start time (chained from the previous leg's end, falling back to its end time) + the net penalty on the episode's earlier legs */
function arrivalMs(teamId: number, leg: LegRow): number | null {
  const p = get<{ arrived_at: string | null; completed_at: string | null }>('SELECT arrived_at, completed_at FROM progress WHERE team_id = ? AND leg_id = ?', teamId, leg.id);
  const base = p?.arrived_at ?? p?.completed_at ?? null;
  if (!base) return null;
  const pen = get<{ m: number | null }>(
    'SELECT SUM(p.minutes) AS m FROM penalties p JOIN legs l ON l.id = p.leg_id WHERE p.episode_id = ? AND p.team_id = ? AND (l.sort < ? OR (l.sort = ? AND l.id < ?))',
    leg.episode_id, teamId, leg.sort, leg.sort, leg.id,
  )?.m ?? 0;
  return new Date(base).getTime() + pen * 60000;
}

/** The leg where an episode ends: its pit stop, or the last leg when there is none */
function endLeg(legs: LegRow[]): LegRow | null {
  return [...legs].reverse().find((l) => l.type === 'PS') ?? legs[legs.length - 1] ?? null;
}

/** A team's check-in for episode elimination: manual check-in, else the end of the end leg; + the episode's net penalty */
function checkinMs(teamId: number, episodeId: number, end: LegRow): number | null {
  const r = get<{ checkin_at: string | null }>('SELECT checkin_at FROM pitstop_results WHERE episode_id = ? AND team_id = ?', episodeId, teamId);
  const base = r?.checkin_at ?? get<{ completed_at: string | null }>('SELECT completed_at FROM progress WHERE team_id = ? AND leg_id = ?', teamId, end.id)?.completed_at ?? null;
  if (!base) return null;
  const pen = get<{ m: number | null }>('SELECT SUM(minutes) AS m FROM penalties WHERE episode_id = ? AND team_id = ?', episodeId, teamId)?.m ?? 0;
  return new Date(base).getTime() + pen * 60000;
}

/** Eliminate the last `count` of the participants by `time`, once all of them have a time; skipped when no more teams are left than the count */
function cut(alive: Set<number>, elimAt: Map<number, number>, count: number, legId: number, time: (id: number) => number | null) {
  const participants = [...alive];
  if (count <= 0 || participants.length <= count) return;
  const times = participants.map((id) => ({ id, t: time(id) }));
  if (times.some((x) => x.t === null)) return; // some teams have not arrived yet: not decided
  times.sort((a, b) => (b.t! - a.t!) || (b.id - a.id)); // latest first
  for (const x of times.slice(0, count)) { alive.delete(x.id); elimAt.set(x.id, legId); }
}

/** Recompute elimination status for the whole event; returns whether anything changed */
export function recomputeEliminations(eventId: number): boolean {
  const legs = legOrder(eventId);
  const episodes = all<EpisodeRow>('SELECT id, status, eliminate_count FROM episodes WHERE event_id = ? ORDER BY sort, id', eventId);
  const teams = all<{ id: number; status: string; eliminated_leg_id: number | null; locked_from_leg_id: number | null }>(
    'SELECT id, status, eliminated_leg_id, locked_from_leg_id FROM teams WHERE event_id = ? ORDER BY sort, id', eventId,
  );
  const alive = new Set(teams.filter((t) => t.status !== 'withdrawn').map((t) => t.id));
  const elimAt = new Map<number, number>();
  for (const ep of episodes) {
    const epLegs = legs.filter((l) => l.episode_id === ep.id);
    if (ep.status === 'finished') {
      // locked: keep the eliminations recorded while it ran
      const ids = new Set(epLegs.map((l) => l.id));
      for (const t of teams) if (t.status === 'eliminated' && t.eliminated_leg_id && ids.has(t.eliminated_leg_id) && alive.has(t.id)) { alive.delete(t.id); elimAt.set(t.id, t.eliminated_leg_id); }
      continue;
    }
    for (const leg of epLegs) if (leg.can_eliminate) cut(alive, elimAt, leg.eliminate_count, leg.id, (id) => arrivalMs(id, leg));
    const end = endLeg(epLegs);
    if (end) cut(alive, elimAt, ep.eliminate_count, end.id, (id) => checkinMs(id, ep.id, end));
  }
  const nextLegId = (legId: number) => { const i = legs.findIndex((l) => l.id === legId); return i >= 0 && i + 1 < legs.length ? legs[i + 1]!.id : -1; }; // -1 = no later leg, nothing to lock
  let changed = false;
  for (const t of teams) {
    if (t.status === 'withdrawn') continue;
    const legId = elimAt.get(t.id) ?? null;
    const status = legId ? 'eliminated' : 'alive';
    const locked = legId ? (nextLegId(legId) === -1 ? null : nextLegId(legId)) : null;
    if (status !== t.status || legId !== t.eliminated_leg_id || locked !== t.locked_from_leg_id) {
      run('UPDATE teams SET status = ?, eliminated_leg_id = ?, locked_from_leg_id = ? WHERE id = ?', status, legId, locked, t.id);
      changed = true;
    }
  }
  return changed;
}

/** Whether a leg is locked for a team (legs after elimination / withdrawal cannot be recorded) */
export function isLegLocked(eventId: number, team: { locked_from_leg_id: number | null }, legId: number): boolean {
  if (!team.locked_from_leg_id) return false;
  const legs = legOrder(eventId);
  const from = legs.findIndex((l) => l.id === team.locked_from_leg_id);
  const cur = legs.findIndex((l) => l.id === legId);
  return from >= 0 && cur >= from;
}

/** Withdrawal: earlier records stay; lock from the leg after the last recorded one, or from the first leg when nothing was recorded */
export function lockFromAfterLastRecord(eventId: number, teamId: number): number | null {
  const legs = legOrder(eventId);
  if (!legs.length) return null;
  // Only end times count: the next leg's start time is chained automatically and does not mean the team reached it
  const recorded = new Set(all<{ leg_id: number }>('SELECT leg_id FROM progress WHERE team_id = ? AND completed_at IS NOT NULL', teamId).map((r) => r.leg_id));
  let last = -1;
  legs.forEach((l, i) => { if (recorded.has(l.id)) last = i; });
  return last + 1 < legs.length ? legs[last + 1]!.id : null;
}
