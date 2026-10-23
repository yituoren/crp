import { all, get, run, now } from './db.js';

// 记录的底层写入与自动联动：进度接口和赛段自动发车共用

export function prevEndTime(episodeId: number, teamId: number, sort: number): string | null {
  return get(
    `SELECT p.completed_at FROM progress p JOIN legs l ON l.id = p.leg_id
     WHERE p.episode_id = ? AND p.team_id = ? AND l.sort < ? AND l.type != 'BR' AND p.completed_at IS NOT NULL ORDER BY l.sort DESC, l.id DESC LIMIT 1`,
    episodeId, teamId, sort,
  )?.completed_at ?? null;
}
export function emptyProgress() {
  return { arrived_at: null, completed_at: null, detour_choice: null, roadblock_by: null, ff_result: null, target_team_id: null, note: '' };
}
/**
 * 记录完成后的自动联动：
 *  - 下一个环节（尚未完成）的开始时间 = 本环节结束时间
 *  - 中间被跳过的环节（只有自动填的开始时间、没有完成）把开始时间清掉
 */
export function chainAfterComplete(episodeId: number, teamId: number, sort: number, endAt: string | null, userId: number, legType = '') {
  if (!endAt || legType === 'BR') return; // 支线结束不触发下一环节
  const nextLeg = get("SELECT id FROM legs WHERE episode_id = ? AND sort > ? AND type != 'BR' ORDER BY sort, id LIMIT 1", episodeId, sort);
  if (nextLeg) {
    const np = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, teamId, nextLeg.id) ?? emptyProgress();
    if (!np.completed_at) upsertProgress(episodeId, teamId, nextLeg.id, { ...np, arrived_at: endAt }, userId);
  }
  const prevDone = get(
    `SELECT l.sort FROM progress p JOIN legs l ON l.id = p.leg_id
     WHERE p.episode_id = ? AND p.team_id = ? AND l.sort < ? AND p.completed_at IS NOT NULL ORDER BY l.sort DESC LIMIT 1`,
    episodeId, teamId, sort,
  );
  const lower = prevDone?.sort ?? -1;
  for (const sk of all(
    `SELECT p.* FROM progress p JOIN legs l ON l.id = p.leg_id
     WHERE p.episode_id = ? AND p.team_id = ? AND l.sort > ? AND l.sort < ? AND l.type != 'BR' AND p.arrived_at IS NOT NULL AND p.completed_at IS NULL`,
    episodeId, teamId, lower, sort,
  )) upsertProgress(episodeId, teamId, sk.leg_id, { ...sk, arrived_at: null }, userId);
}
export function upsertProgress(episodeId: number, teamId: number, legId: number, p: any, userId: number) {
  run(
    `INSERT INTO progress(episode_id, team_id, leg_id, arrived_at, completed_at, detour_choice, roadblock_by, ff_result, target_team_id, note, recorded_by, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(episode_id, team_id, leg_id) DO UPDATE SET
       arrived_at = excluded.arrived_at, completed_at = excluded.completed_at, detour_choice = excluded.detour_choice,
       roadblock_by = excluded.roadblock_by, ff_result = excluded.ff_result, target_team_id = excluded.target_team_id, note = excluded.note,
       recorded_by = excluded.recorded_by, updated_at = excluded.updated_at`,
    episodeId, teamId, legId, p.arrived_at, p.completed_at, p.detour_choice, p.roadblock_by, p.ff_result, p.target_team_id ?? null, p.note ?? '', userId, now(),
  );
}


/** 某赛段的最终名次（队伍 id 顺序）：中继站签到（手工优先）+ 净罚时，退赛不排；没有成绩的队伍按队伍顺序排在后面 */
export function finalRanking(episodeId: number): number[] {
  const ep = get<{ event_id: number }>('SELECT event_id FROM episodes WHERE id = ?', episodeId);
  if (!ep) return [];
  const psLeg = get<{ id: number }>("SELECT id FROM legs WHERE episode_id = ? AND type = 'PS' ORDER BY sort DESC LIMIT 1", episodeId);
  const teams = all<{ id: number; status: string }>('SELECT id, status FROM teams WHERE event_id = ? ORDER BY sort, id', ep.event_id);
  const manual = new Map(all<{ team_id: number; checkin_at: string | null }>('SELECT team_id, checkin_at FROM pitstop_results WHERE episode_id = ?', episodeId).map((r) => [r.team_id, r.checkin_at]));
  const auto = new Map<number, string | null>();
  if (psLeg) for (const r of all<{ team_id: number; completed_at: string | null }>('SELECT team_id, completed_at FROM progress WHERE episode_id = ? AND leg_id = ?', episodeId, psLeg.id)) auto.set(r.team_id, r.completed_at);
  const pen = new Map(all<{ team_id: number; m: number }>('SELECT team_id, SUM(minutes) AS m FROM penalties WHERE episode_id = ? GROUP BY team_id', episodeId).map((r) => [r.team_id, r.m]));
  const ranked = teams
    .filter((t) => t.status !== 'withdrawn')
    .map((t) => { const c = manual.get(t.id) ?? auto.get(t.id) ?? null; return { id: t.id, ms: c ? new Date(c).getTime() + (pen.get(t.id) ?? 0) * 60000 : null }; })
    .filter((x) => x.ms !== null)
    .sort((a, b) => a.ms! - b.ms! || a.id - b.id)
    .map((x) => x.id);
  const seen = new Set(ranked);
  return [...ranked, ...teams.filter((t) => !seen.has(t.id)).map((t) => t.id)];
}
