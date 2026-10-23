import { all, get, run } from './db.js';

/**
 * 自动淘汰：每个“可淘汰”环节，当所有仍在比赛的队伍都记录了该环节的结束时间后，
 * 最后到达的 N 支队伍（N = 环节的淘汰人数）自动淘汰。中继站按签到时间 + 净罚时排序。
 * 结果可逆：记录被撤销或修改后重新计算，队伍会恢复或重新被淘汰。退赛的队伍不参与计算。
 */
type LegRow = { id: number; episode_id: number; type: string; sort: number; can_eliminate: number; eliminate_count: number };

/** 全比赛的环节顺序：赛段按 sort，环节按 sort */
export function legOrder(eventId: number): LegRow[] {
  return all<LegRow>(
    `SELECT l.id, l.episode_id, l.type, l.sort, l.can_eliminate, l.eliminate_count FROM legs l JOIN episodes e ON e.id = l.episode_id
     WHERE e.event_id = ? ORDER BY e.sort, e.id, l.sort, l.id`, eventId,
  ).map((l) => (l.type === 'PS' ? { ...l, can_eliminate: 1, eliminate_count: l.eliminate_count > 0 ? l.eliminate_count : 2 } : l));
}

/** 某队在某环节的“到达时间”：中继站 = 签到（手工签到优先）+ 本赛段净罚时；其他 = 结束时间 */
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

/** 重新计算整场比赛的淘汰状态；返回是否有变化 */
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
    if (participants.length <= leg.eliminate_count) return; // 剩余队伍不多于淘汰数：不淘汰，避免全军覆没
    const times = participants.map((id) => ({ id, t: arrivalMs(id, leg) }));
    if (times.some((x) => x.t === null)) return; // 还有队伍没到，先不算
    times.sort((a, b) => (b.t! - a.t!) || (b.id - a.id)); // 最晚到的在前
    for (const x of times.slice(0, leg.eliminate_count)) { alive.delete(x.id); elimAt.set(x.id, leg.id); }
    void i;
  });
  const nextLegId = (legId: number) => { const i = legs.findIndex((l) => l.id === legId); return i >= 0 && i + 1 < legs.length ? legs[i + 1]!.id : -1; }; // -1 = 没有后续环节，不锁
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

/** 某队在某环节是否已锁定（淘汰/退赛之后的环节不能再记录） */
export function isLegLocked(eventId: number, team: { locked_from_leg_id: number | null }, legId: number): boolean {
  if (!team.locked_from_leg_id) return false;
  const legs = legOrder(eventId);
  const from = legs.findIndex((l) => l.id === team.locked_from_leg_id);
  const cur = legs.findIndex((l) => l.id === legId);
  return from >= 0 && cur >= from;
}

/** 退赛：之前的记录保留，从“最后一个有记录的环节”之后开始锁定；没有记录则从第一个环节锁定 */
export function lockFromAfterLastRecord(eventId: number, teamId: number): number | null {
  const legs = legOrder(eventId);
  if (!legs.length) return null;
  // 只看“结束时间”：下一环节的开始时间是自动接上来的，不算该队到过那个环节
  const recorded = new Set(all<{ leg_id: number }>('SELECT leg_id FROM progress WHERE team_id = ? AND completed_at IS NOT NULL', teamId).map((r) => r.leg_id));
  let last = -1;
  legs.forEach((l, i) => { if (recorded.has(l.id)) last = i; });
  return last + 1 < legs.length ? legs[last + 1]!.id : null;
}
