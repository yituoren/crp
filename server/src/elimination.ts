import { all, get, run } from './db.js';

/**
 * Automatic elimination: for every leg flagged as eliminating, once every team still racing has an end time
 * on that leg, the last N teams to arrive (N = the leg's elimination count) are eliminated. Pit stops sort by
 * check-in time + net penalty. The result is reversible: it is recomputed after records are reverted or edited,
 * so teams come back or get eliminated again. Withdrawn teams are excluded.
 */
type LegRow = { id: number; episode_id: number; type: string; sort: number; can_eliminate: number; eliminate_count: number };

/** Leg order across the whole event: episodes by sort, legs by sort */
export function legOrder(eventId: number): LegRow[] {
  return all<LegRow>(
    `SELECT l.id, l.episode_id, l.type, l.sort, l.can_eliminate, l.eliminate_count FROM legs l JOIN episodes e ON e.id = l.episode_id
     WHERE e.event_id = ? ORDER BY e.sort, e.id, l.sort, l.id`, eventId,
  );
}

/** A team's "arrival time" on a leg: pit stop = check-in (manual check-in wins) + the episode's net penalty; otherwise the end time */
function arrivalMs(teamId: number, leg: LegRow): number | null {
  const p = get<{ completed_at: string | null }>('SELECT completed_at FROM progress WHERE team_id = ? AND leg_id = ?', teamId, leg.id);
  let base = p?.completed_at ?? null;
  if (leg.type === 'PS') {
    const r = get<{ checkin_at: string | null }>('SELECT checkin_at FROM pitstop_results WHERE episode_id = ? AND team_id = ?', leg.episode_id, teamId);
    base = r?.checkin_at ?? base;
    if (!base) return null;
    const pen = get<{ m: number | null }>('SELECT SUM(minutes) AS m FROM penalties WHERE episode_id = ? AND team_id = ?', leg.episode_id, teamId)?.m ?? 0;
    return new Date(base).getTime() + pen * 60000;
  }
  return base ? new Date(base).getTime() : null;
}

/** Recompute elimination status for the whole event; returns whether anything changed */
export function recomputeEliminations(eventId: number): boolean {
  const legs = legOrder(eventId);
  const teams = all<{ id: number; status: string; eliminated_leg_id: number | null; locked_from_leg_id: number | null }>(
    'SELECT id, status, eliminated_leg_id, locked_from_leg_id FROM teams WHERE event_id = ? ORDER BY sort, id', eventId,
  );
  const alive = new Set(teams.filter((t) => t.status !== 'withdrawn').map((t) => t.id));
  const elimAt = new Map<number, number>();
  legs.forEach((leg, i) => {
    if (!leg.can_eliminate || leg.eliminate_count <= 0) return;
    const participants = [...alive];
    if (participants.length <= leg.eliminate_count) return; // No more teams left than the elimination count: skip, otherwise everyone would be out
    const times = participants.map((id) => ({ id, t: arrivalMs(id, leg) }));
    if (times.some((x) => x.t === null)) return; // Some teams have not arrived yet: not decided
    times.sort((a, b) => (b.t! - a.t!) || (b.id - a.id)); // latest arrivals first
    for (const x of times.slice(0, leg.eliminate_count)) { alive.delete(x.id); elimAt.set(x.id, leg.id); }
    void i;
  });
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
