import { all, get, run, now } from './db.js';

// Low-level progress writes and chaining, shared by the progress routes and automatic departures

export function prevEndTime(episodeId: number, teamId: number, sort: number): string | null {
  return get(
    `SELECT p.completed_at FROM progress p JOIN legs l ON l.id = p.leg_id
     WHERE p.episode_id = ? AND p.team_id = ? AND l.sort < ? AND l.type != 'SQ' AND p.completed_at IS NOT NULL ORDER BY l.sort DESC, l.id DESC LIMIT 1`,
    episodeId, teamId, sort,
  )?.completed_at ?? null;
}
/**
 * Start time of a leg chained from the previous end: a twist effect in force that delays this leg's start (missile) adds its minutes,
 * and its wait window follows the new time
 */
export function chainedStart(episodeId: number, teamId: number, legId: number, endAt: string | null, apply = true): string | null {
  if (!endAt) return null;
  // waits there run one after another (e.g. 让路, then 让行)
  let t = endAt;
  for (const ef of all<{ id: number; wait_min: number }>("SELECT id, wait_min FROM twist_effects WHERE episode_id = ? AND target_team_id = ? AND leg_id = ? AND status = 'hit' AND mode = 'delay_start' ORDER BY id", episodeId, teamId, legId)) {
    const until = new Date(new Date(t).getTime() + ef.wait_min * 60000).toISOString();
    if (apply) run('UPDATE twist_effects SET wait_from = ?, wait_until = ? WHERE id = ?', t, until, ef.id);
    t = until;
  }
  return t;
}
export function emptyProgress() {
  return { arrived_at: null, completed_at: null, detour_choice: null, roadblock_by: null, ff_result: null, target_team_id: null, note: '', settle_min: 0 };
}
/**
 * Chaining after a completion:
 *  - the next (not yet completed) leg's start time = this leg's end time
 *  - skipped legs in between (auto-filled start, no completion) get their start time cleared
 */
export function chainAfterComplete(episodeId: number, teamId: number, sort: number, endAt: string | null, userId: number, legType = '') {
  if (!endAt || legType === 'SQ') return; // finishing a side quest does not chain the next leg
  const nextLeg = get("SELECT id FROM legs WHERE episode_id = ? AND sort > ? AND type != 'SQ' ORDER BY sort, id LIMIT 1", episodeId, sort);
  if (nextLeg) {
    const np = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, teamId, nextLeg.id) ?? emptyProgress();
    if (!np.completed_at) upsertProgress(episodeId, teamId, nextLeg.id, { ...np, arrived_at: chainedStart(episodeId, teamId, nextLeg.id, endAt) }, userId);
  }
  const prevDone = get(
    `SELECT l.sort FROM progress p JOIN legs l ON l.id = p.leg_id
     WHERE p.episode_id = ? AND p.team_id = ? AND l.sort < ? AND p.completed_at IS NOT NULL ORDER BY l.sort DESC LIMIT 1`,
    episodeId, teamId, sort,
  );
  const lower = prevDone?.sort ?? -1;
  for (const sk of all(
    `SELECT p.* FROM progress p JOIN legs l ON l.id = p.leg_id
     WHERE p.episode_id = ? AND p.team_id = ? AND l.sort > ? AND l.sort < ? AND l.type != 'SQ' AND p.arrived_at IS NOT NULL AND p.completed_at IS NULL`,
    episodeId, teamId, lower, sort,
  )) upsertProgress(episodeId, teamId, sk.leg_id, { ...sk, arrived_at: null }, userId);
}
export function upsertProgress(episodeId: number, teamId: number, legId: number, p: any, userId: number) {
  run(
    `INSERT INTO progress(episode_id, team_id, leg_id, arrived_at, completed_at, detour_choice, roadblock_by, ff_result, target_team_id, note, recorded_by, updated_at, settle_min)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(episode_id, team_id, leg_id) DO UPDATE SET
       arrived_at = excluded.arrived_at, completed_at = excluded.completed_at, detour_choice = excluded.detour_choice,
       roadblock_by = excluded.roadblock_by, ff_result = excluded.ff_result, target_team_id = excluded.target_team_id, note = excluded.note,
       recorded_by = excluded.recorded_by, updated_at = excluded.updated_at, settle_min = excluded.settle_min`,
    episodeId, teamId, legId, p.arrived_at, p.completed_at, p.detour_choice, p.roadblock_by, p.ff_result, p.target_team_id ?? null, p.note ?? '', userId, now(),
    p.arrived_at ? (p.settle_min ?? 0) : 0, // no start, nothing waited out
  );
}

/** Task start on a leg: its start time (after any twist wait) + the penalties waited out there (sudden death) */
export function taskStartMs(p: { arrived_at?: string | null; settle_min?: number | null } | null | undefined): number | null {
  return p?.arrived_at ? new Date(p.arrived_at).getTime() + (p.settle_min ?? 0) * 60000 : null;
}

// ---------- Penalty settlement ----------
/**
 * Penalties and credits are settled at the next settlement point after the leg they are recorded on:
 *  - a sudden-death leg, before the team starts its task there: the net of the earlier legs not settled yet. A net penalty is
 *    waited out on the spot (progress.settle_min, added to the leg's start); a net credit cannot start the team earlier: it counts
 *    in that leg's ranking and stays open for the next settlement. Once the team finished the leg what it waited out is fixed;
 *    later changes on earlier legs go to the next settlement
 *  - the pit stop check-in settles everything not waited out, the 「其他」 (no leg) ones included
 */
type SettleLeg = { id: number; can_eliminate: number; eliminate_count: number };
const isSuddenDeath = (l: SettleLeg) => !!l.can_eliminate && l.eliminate_count > 0;
type SettleProgress = { leg_id: number; arrived_at: string | null; completed_at: string | null; settle_min: number };

/** A team's settlement in an episode: minutes to wait out per leg, and the open net (not settled yet) on reaching each leg */
export function settlementOf(episodeId: number, teamId: number): { wait: Map<number, number>; openBefore: Map<number, number> } {
  const legs = all<SettleLeg>('SELECT id, can_eliminate, eliminate_count FROM legs WHERE episode_id = ? ORDER BY sort, id', episodeId);
  const net = new Map(all<{ leg_id: number; m: number }>('SELECT leg_id, SUM(minutes) AS m FROM penalties WHERE episode_id = ? AND team_id = ? AND leg_id IS NOT NULL GROUP BY leg_id', episodeId, teamId).map((r) => [r.leg_id, r.m ?? 0]));
  const prog = new Map(all<SettleProgress>('SELECT leg_id, arrived_at, completed_at, settle_min FROM progress WHERE episode_id = ? AND team_id = ?', episodeId, teamId).map((p) => [p.leg_id, p]));
  const wait = new Map<number, number>(), openBefore = new Map<number, number>();
  let open = 0;
  for (const l of legs) {
    const p = prog.get(l.id);
    openBefore.set(l.id, open);
    // a finished leg keeps what was waited out; a sudden-death leg the team is on waits out the open net penalty; nothing else waits
    const w = p?.completed_at ? p.settle_min : p?.arrived_at && isSuddenDeath(l) ? Math.max(0, open) : 0;
    wait.set(l.id, w);
    open += (net.get(l.id) ?? 0) - w;
  }
  return { wait, openBefore };
}

/** Bring the stored waits of the event's unfinished episodes up to date; returns the episodes that changed */
export function settleEvent(eventId: number): Set<number> {
  const changed = new Set<number>();
  for (const r of all<{ episode_id: number; team_id: number }>(
    "SELECT DISTINCT p.episode_id, p.team_id FROM progress p JOIN episodes e ON e.id = p.episode_id WHERE e.event_id = ? AND e.status != 'finished'", eventId,
  )) {
    const { wait } = settlementOf(r.episode_id, r.team_id);
    for (const p of all<SettleProgress>('SELECT leg_id, arrived_at, completed_at, settle_min FROM progress WHERE episode_id = ? AND team_id = ?', r.episode_id, r.team_id)) {
      const w = wait.get(p.leg_id) ?? 0;
      if (w !== p.settle_min) { run('UPDATE progress SET settle_min = ? WHERE episode_id = ? AND team_id = ? AND leg_id = ?', w, r.episode_id, r.team_id, p.leg_id); changed.add(r.episode_id); }
    }
  }
  return changed;
}

/** Net minutes per team settled at the pit stop check-in: the episode's net less what was waited out at sudden-death legs */
export function pitstopNet(episodeId: number): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of all<{ team_id: number; m: number }>('SELECT team_id, SUM(minutes) AS m FROM penalties WHERE episode_id = ? GROUP BY team_id', episodeId)) m.set(r.team_id, r.m ?? 0);
  for (const r of all<{ team_id: number; w: number }>('SELECT team_id, SUM(settle_min) AS w FROM progress WHERE episode_id = ? GROUP BY team_id', episodeId)) if (r.w) m.set(r.team_id, (m.get(r.team_id) ?? 0) - r.w);
  return m;
}

/** The leg a team is on in an episode: the furthest leg it has a record on (side quests count as their main leg); null before it starts */
export function currentLegOf(episodeId: number, teamId: number): number | null {
  return get<{ id: number }>(
    `SELECT l.id FROM progress p JOIN legs l ON l.id = p.leg_id WHERE p.episode_id = ? AND p.team_id = ? AND l.type != 'SQ'
     AND (p.arrived_at IS NOT NULL OR p.completed_at IS NOT NULL) ORDER BY l.sort DESC, l.id DESC LIMIT 1`, episodeId, teamId,
  )?.id ?? null;
}

/** Final ranking of an episode (team ids in order): pit-stop check-in (manual wins) + the net penalty settled there; withdrawn teams are not ranked; teams without a result follow in team order */
export function finalRanking(episodeId: number): number[] {
  const ep = get<{ event_id: number }>('SELECT event_id FROM episodes WHERE id = ?', episodeId);
  if (!ep) return [];
  const psLeg = get<{ id: number }>("SELECT id FROM legs WHERE episode_id = ? AND type = 'PS' ORDER BY sort DESC LIMIT 1", episodeId);
  const teams = all<{ id: number; status: string }>('SELECT id, status FROM teams WHERE event_id = ? ORDER BY sort, id', ep.event_id);
  const manual = new Map(all<{ team_id: number; checkin_at: string | null }>('SELECT team_id, checkin_at FROM pitstop_results WHERE episode_id = ?', episodeId).map((r) => [r.team_id, r.checkin_at]));
  const auto = new Map<number, string | null>();
  if (psLeg) for (const r of all<{ team_id: number; completed_at: string | null }>('SELECT team_id, completed_at FROM progress WHERE episode_id = ? AND leg_id = ?', episodeId, psLeg.id)) auto.set(r.team_id, r.completed_at);
  const pen = pitstopNet(episodeId);
  const ranked = teams
    .filter((t) => t.status !== 'withdrawn')
    .map((t) => { const c = manual.get(t.id) ?? auto.get(t.id) ?? null; return { id: t.id, ms: c ? new Date(c).getTime() + (pen.get(t.id) ?? 0) * 60000 : null }; })
    .filter((x) => x.ms !== null)
    .sort((a, b) => a.ms! - b.ms! || a.id - b.id)
    .map((x) => x.id);
  const seen = new Set(ranked);
  return [...ranked, ...teams.filter((t) => !seen.has(t.id)).map((t) => t.id)];
}
