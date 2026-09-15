import { Hono } from 'hono';
import { all, get, run, tx, now } from '../db.js';
import { hostOnly, canRecordProgress, canManagePenalty, isHostRole, isPitstopStation, type Env, isAdminRole } from '../auth.js';
import { audit, body, str, int, intParam, isoOrNull, notify, bad, notFound, forbidden } from '../util.js';
import { teamLabelMap } from './teams.js';

export const progressRoutes = new Hono<Env>();

/** 只有这些类型的环节是每支队伍都必须经过的；快进/减速带/回转/让路/对抗只有部分队伍会用 */
const MANDATORY_TYPES = new Set(['SL', 'TI', 'DT', 'RB', 'Union', 'Shuffle', 'Trap', 'PS']);

/**
 * 检查队伍在某环节打卡前，前面的必经环节是否都已完成。
 * 返回未完成的环节名列表（空数组 = 可以打卡）。成功快进后，快进之后的环节不再要求。
 */
export function missingPrerequisites(episodeId: number, teamId: number, legId: number): string[] {
  const legs = all('SELECT id, type, name, sort, record_mode FROM legs WHERE episode_id = ? ORDER BY sort, id', episodeId);
  const idx = legs.findIndex((l) => l.id === legId);
  if (idx <= 0) return [];
  const prog = new Map(all('SELECT leg_id, completed_at, ff_result FROM progress WHERE episode_id = ? AND team_id = ?', episodeId, teamId).map((p) => [p.leg_id, p]));
  const missing: string[] = [];
  for (let i = 0; i < idx; i++) {
    const l = legs[i]!;
    const p = prog.get(l.id);
    if (l.type === 'FF' && p?.ff_result === 'success') return []; // 成功快进：直接放行
    if (l.record_mode === 'none' || !MANDATORY_TYPES.has(l.type)) continue;
    if (!p?.completed_at) missing.push(l.name);
  }
  return missing;
}

export function listProgress(episodeId: number) {
  return all('SELECT * FROM progress WHERE episode_id = ? ORDER BY id', episodeId);
}
export function listPenalties(episodeId: number) {
  const labels = teamLabelMap();
  return all(
    `SELECT p.*, t.name AS team_name, u.display_name AS applied_by_name, l.name AS leg_name
     FROM penalties p JOIN teams t ON t.id = p.team_id LEFT JOIN users u ON u.id = p.applied_by LEFT JOIN legs l ON l.id = p.leg_id
     WHERE p.episode_id = ? ORDER BY p.id DESC`,
    episodeId,
  ).map((r) => ({ ...r, team_name: labels.get(r.team_id) ?? r.team_name }));
}

progressRoutes.get('/episodes/:id/progress', (c) => {
  const episodeId = intParam(c, 'id');
  return c.json({ progress: listProgress(episodeId), penalties: listPenalties(episodeId), pitstop: pitstopRows(episodeId) });
});

/**
 * 记录动作。action:
 *  arrive | complete | undo_arrive | undo_complete | detour | roadblock | ff | note
 */
progressRoutes.post('/progress', async (c) => {
  const user = c.get('user');
  const b = await body(c);
  const episodeId = int(b.episodeId), teamId = int(b.teamId), legId = int(b.legId);
  let action = String(b.action ?? '');
  if (!episodeId || !teamId || !legId) throw bad('缺少赛段/队伍/环节');
  const leg = get('SELECT * FROM legs WHERE id = ? AND episode_id = ?', legId, episodeId);
  if (!leg) throw notFound('环节不存在');
  if (leg.record_mode === 'none' && ['arrive', 'complete', 'single'].includes(action)) throw bad('本环节不记录时间');
  if (leg.record_mode === 'single' && ['arrive', 'complete'].includes(action)) action = 'single';
  const episode = get('SELECT status, code FROM episodes WHERE id = ?', episodeId)!;
  if (!isAdminRole(user.role)) {
    if (episode.status === 'pending') throw bad(`${episode.code} 尚未开始，开始赛段后才能记录`);
    if (episode.status === 'finished') throw bad(`${episode.code} 已结束，记录已锁定${isHostRole(user.role) ? '，如需修正请使用“修改记录”' : ''}`);
  }
  if (['arrive', 'complete', 'single'].includes(action)) {
    const missing = missingPrerequisites(episodeId, teamId, legId);
    if (missing.length) throw bad(`该队伍还没有完成前面的环节：${missing.join('、')}`);
  }
  if (['target', 'detour', 'roadblock', 'ff'].includes(action)) {
    const cur = get('SELECT arrived_at, completed_at FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, teamId, legId);
    if (!cur?.arrived_at) throw bad('请先记录开始，再填写环节信息');
    if (cur.completed_at) throw bad('已记录完成，环节信息请通过“修改记录”修改');
  }
  if (['undo_arrive', 'undo_complete'].includes(action)) {
    const later = all(
      `SELECT l.name FROM progress p JOIN legs l ON l.id = p.leg_id
       WHERE p.episode_id = ? AND p.team_id = ? AND (l.sort > (SELECT sort FROM legs WHERE id = ?)) AND (p.arrived_at IS NOT NULL OR p.completed_at IS NOT NULL)`,
      episodeId, teamId, legId,
    );
    if (later.length) throw bad(`后面的环节已有记录（${later.map((r) => r.name).join('、')}），请先撤销后面的`);
  }
  const team = get('SELECT * FROM teams WHERE id = ?', teamId);
  if (!team) throw notFound('队伍不存在');
  if (!canRecordProgress(user, episodeId, teamId, legId)) throw forbidden('你没有该队伍/站点的记录权限');
  if (team.status !== 'alive' && !isHostRole(user.role)) throw forbidden('该队伍已淘汰，只有主办可以修改记录');
  if (['undo_arrive', 'undo_complete'].includes(action) && !isHostRole(user.role)) throw forbidden('撤销记录仅主办可操作');

  const before = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, teamId, legId);
  // 记录时间：前端弹表单让人确认/修改，默认服务器当前时间；不允许填未来时间
  let t = now();
  const at = isoOrNull(b.at);
  if (at) {
    if (new Date(at).getTime() > Date.now() + 2 * 60 * 1000) throw bad('记录时间不能晚于当前时间');
    t = at;
  }
  const cur = before ?? {
    arrived_at: null, completed_at: null, detour_choice: null, roadblock_by: null, ff_result: null, target_team_id: null, note: '',
  };
  const next = { ...cur };
  let already = false; // 幂等：重复点击/断网重试不报错，保留第一次的时间
  switch (action) {
    case 'arrive':
      if (cur.arrived_at) already = true;
      else next.arrived_at = t;
      break;
    case 'complete':
      if (cur.completed_at) already = true;
      else {
        // 有附加信息的环节，必须先填完才能记录完成
        if (leg.type === 'DT' && !cur.detour_choice) throw bad('请先填写绕道选择');
        if (leg.type === 'RB' && !cur.roadblock_by) throw bad('请先填写路障完成人');
        if (leg.type === 'FF' && !cur.ff_result) throw bad('请先填写快进结果');
        if (cur.arrived_at && t < cur.arrived_at) throw bad(`完成时间不能早于开始时间（${cur.arrived_at}）`);
        next.completed_at = t;
        if (!next.arrived_at) next.arrived_at = t;
      }
      break;
    case 'single': // 只记一次：出发 / 打卡 / 签到
      if (cur.completed_at) already = true;
      else { next.arrived_at = t; next.completed_at = t; }
      break;
    case 'undo_arrive':
      next.arrived_at = null;
      next.completed_at = null;
      break;
    case 'target': {
      const tid = int(b.value, 0);
      if (tid && !get('SELECT 1 FROM teams WHERE id = ?', tid)) throw notFound('目标队伍不存在');
      next.target_team_id = tid || null;
      break;
    }
    case 'undo_complete':
      next.completed_at = null;
      break;
    case 'detour':
      next.detour_choice = str(b.value, 100) || null;
      break;
    case 'roadblock':
      next.roadblock_by = str(b.value, 100) || null;
      break;
    case 'ff':
      next.ff_result = ['success', 'fail'].includes(b.value) ? b.value : null;
      break;
    case 'note':
      next.note = str(b.value, 1000);
      break;
    default:
      throw bad('未知动作');
  }
  if (!already) {
    upsertProgress(episodeId, teamId, legId, next, user.id);
    audit(user, `progress:${action}`, 'progress', `${episodeId}/${teamId}/${legId}`, before, next);
    notify('progress', episodeId);
  }
  const progress = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, teamId, legId);
  return c.json({ progress, already });
});

function upsertProgress(episodeId: number, teamId: number, legId: number, p: any, userId: number) {
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

/** 修改记录：主办任意；跟队可改所跟队伍在进行中赛段的已有记录（不能清空时间、不能填未来） */
progressRoutes.put('/progress/:episodeId/:teamId/:legId', async (c) => {
  const episodeId = intParam(c, 'episodeId'), teamId = intParam(c, 'teamId'), legId = intParam(c, 'legId');
  const user = c.get('user');
  if (!get('SELECT 1 FROM legs WHERE id = ? AND episode_id = ?', legId, episodeId)) throw notFound('环节不存在');
  const b = await body(c);
  const before = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, teamId, legId);
  const next = {
    arrived_at: isoOrNull(b.arrivedAt),
    completed_at: isoOrNull(b.completedAt),
    detour_choice: str(b.detourChoice, 100) || null,
    roadblock_by: str(b.roadblockBy, 100) || null,
    ff_result: ['success', 'fail'].includes(b.ffResult) ? b.ffResult : null,
    target_team_id: int(b.targetTeamId, 0) || null,
    note: str(b.note, 1000),
  };
  if (next.completed_at && !next.arrived_at) next.arrived_at = next.completed_at;
  const episodeRow = get('SELECT status, code FROM episodes WHERE id = ?', episodeId)!;
  if (episodeRow.status === 'pending' && !isAdminRole(user.role)) throw bad(`${episodeRow.code} 尚未开始，开始赛段后才能操作`);
  if (!isHostRole(user.role)) {
    if (episodeRow.status === 'finished') throw forbidden(`${episodeRow.code} 已结束，只有主办可以修改记录`);
    if (!canRecordProgress(user, episodeId, teamId, legId)) throw forbidden('只能修改所跟队伍的记录');
    if (!before) throw bad('还没有记录，请先记录');
    if ((before.arrived_at && !next.arrived_at) || (before.completed_at && !next.completed_at)) throw bad('跟队不能清空已有时间，如需撤销请联系主办');
    const limit = Date.now() + 2 * 60 * 1000;
    for (const t of [next.arrived_at, next.completed_at]) if (t && new Date(t).getTime() > limit) throw bad('记录时间不能晚于当前时间');
  }
  if (next.arrived_at && next.completed_at && next.completed_at < next.arrived_at) throw bad('完成时间不能早于开始时间');
  upsertProgress(episodeId, teamId, legId, next, user.id);
  audit(user, 'progress:edit', 'progress', `${episodeId}/${teamId}/${legId}`, before, next);
  notify('progress', episodeId);
  return c.json({ ok: true });
});

// ---------- 罚时 ----------
/** 补罚时：minutes 为正是增加罚时，为负是减少罚时。主办与本赛段站点人员可操作 */
progressRoutes.post('/episodes/:id/penalties', async (c) => {
  const episodeId = intParam(c, 'id');
  const user = c.get('user');
  if (!canManagePenalty(user, episodeId)) throw forbidden('只有主办或本赛段的站点人员可以补罚时');
  const b = await body(c);
  const teamId = int(b.teamId), minutes = int(b.minutes);
  if (!teamId || !minutes) throw bad('缺少队伍或罚时分钟数');
  if (!get('SELECT 1 FROM teams WHERE id = ?', teamId)) throw notFound('队伍不存在');
  const epRow = get('SELECT status, code FROM episodes WHERE id = ?', episodeId);
  if (!epRow) throw notFound('赛段不存在');
  if (epRow.status === 'pending' && !isAdminRole(user.role)) throw bad(`${epRow.code} 尚未开始，开始赛段后才能操作罚时`);
  if (epRow.status === 'finished' && !isHostRole(user.role)) throw forbidden(`${epRow.code} 已结束，只有主办可以操作罚时`);
  const legId = int(b.legId, 0) || null;
  if (legId && !get('SELECT 1 FROM legs WHERE id = ? AND episode_id = ?', legId, episodeId)) throw notFound('环节不存在');
  if (!legId && !isHostRole(user.role)) throw forbidden('“其他”环节的罚时/补时只能由主办操作，请选择具体环节');
  const r = run(
    'INSERT INTO penalties(episode_id, team_id, minutes, reason, applied_by, applied_at, leg_id) VALUES (?,?,?,?,?,?,?)',
    episodeId, teamId, minutes, str(b.reason, 200), user.id, now(), legId,
  );
  audit(user, 'create', 'penalty', Number(r.lastInsertRowid), undefined, { episodeId, teamId, minutes, reason: b.reason });
  notify('progress', episodeId);
  return c.json({ id: Number(r.lastInsertRowid) });
});

/** 撤销一条罚时/补时：有权添加的人就有权撤销（主办任意；站点本赛段带环节的记录） */
progressRoutes.post('/penalties/:id/revert', (c) => {
  const id = intParam(c, 'id');
  const user = c.get('user');
  const orig = get('SELECT * FROM penalties WHERE id = ?', id);
  if (!orig) throw notFound('罚时记录不存在');
  if (!canManagePenalty(user, orig.episode_id)) throw forbidden('没有这条记录的撤销权限');
  if (!orig.leg_id && !isHostRole(user.role)) throw forbidden('“其他”环节的记录只能由主办撤销');
  if (!isHostRole(user.role) && get('SELECT status FROM episodes WHERE id = ?', orig.episode_id)?.status === 'finished') throw forbidden('赛段已结束，只有主办可以撤销');
  if (orig.reverted) throw bad('这条记录已经撤销过了');
  if (orig.reverts_id) throw bad('撤销记录本身不能再撤销');
  const newId = tx(() => {
    run('UPDATE penalties SET reverted = 1 WHERE id = ?', id);
    const r = run(
      'INSERT INTO penalties(episode_id, team_id, minutes, reason, applied_by, applied_at, reverts_id, leg_id) VALUES (?,?,?,?,?,?,?,?)',
      orig.episode_id, orig.team_id, -orig.minutes, `撤销：${orig.reason || (orig.minutes > 0 ? '罚时' : '补充时间')}`, user.id, now(), id, orig.leg_id ?? null,
    );
    return Number(r.lastInsertRowid);
  });
  audit(user, 'penalty_revert', 'penalty', id, { minutes: orig.minutes }, { revertId: newId });
  notify('progress', orig.episode_id);
  return c.json({ id: newId });
});

// ---------- 终点结算 ----------
export function pitstopRows(episodeId: number) {
  const psLeg = get('SELECT id FROM legs WHERE episode_id = ? AND type = ? ORDER BY sort DESC LIMIT 1', episodeId, 'PS');
  const labels = teamLabelMap();
  const teams = all<any>('SELECT id, code, name, status FROM teams ORDER BY sort, id').map((t): any => ({ ...t, name: labels.get(t.id) ?? t.name }));
  const results = new Map(all('SELECT * FROM pitstop_results WHERE episode_id = ?', episodeId).map((r) => [r.team_id, r]));
  const penalties = new Map<number, number>();
  for (const p of all('SELECT team_id, SUM(minutes) AS m FROM penalties WHERE episode_id = ? GROUP BY team_id', episodeId)) penalties.set(p.team_id, p.m);
  const psProgress = new Map<number, string | null>();
  if (psLeg) for (const p of all('SELECT team_id, completed_at FROM progress WHERE episode_id = ? AND leg_id = ?', episodeId, psLeg.id)) psProgress.set(p.team_id, p.completed_at);
  const rows = teams.map((t) => {
    const r = results.get(t.id);
    const checkin = r?.checkin_at ?? psProgress.get(t.id) ?? null;
    const pen = penalties.get(t.id) ?? 0;
    const finalMs = checkin ? new Date(checkin).getTime() + pen * 60000 : null;
    return {
      team_id: t.id, team_code: t.code, team_name: t.name, team_status: t.status,
      checkin_at: checkin, checkin_source: r?.checkin_at ? 'manual' : psProgress.get(t.id) ? 'progress' : null,
      penalty_minutes: pen, final_time: finalMs ? new Date(finalMs).toISOString() : null,
      rank: null as number | null, eliminated: !!r?.eliminated, note: r?.note ?? '',
    };
  });
  // 名次实时计算：有最终成绩且未退赛的队伍按最终成绩排序；签到、罚时、补时一变名次就变
  rows
    .filter((r) => r.final_time && r.team_status !== 'withdrawn')
    .sort((a, b) => a.final_time!.localeCompare(b.final_time!))
    .forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

progressRoutes.get('/episodes/:id/pitstop', (c) => c.json({ pitstop: pitstopRows(intParam(c, 'id')) }));

progressRoutes.put('/episodes/:id/pitstop/:teamId', async (c) => {
  const episodeId = intParam(c, 'id'), teamId = intParam(c, 'teamId');
  const user = c.get('user');
  let b = await body(c);
  if (!isHostRole(user.role)) {
    // 中继站的站点人员只能操作“本段淘汰”，其他字段忽略
    if (!isPitstopStation(user, episodeId)) throw forbidden('只有主办或本赛段中继站的站点人员可以标记淘汰');
    if (b.eliminated === undefined) throw bad('中继站站点只能修改淘汰状态');
    b = { eliminated: !!b.eliminated };
  }
  const before = get('SELECT * FROM pitstop_results WHERE episode_id = ? AND team_id = ?', episodeId, teamId);
  const checkin = b.checkinAt === undefined ? (before?.checkin_at ?? null) : isoOrNull(b.checkinAt);
  const rank = before?.rank ?? null; // 名次自动计算，不再手工设置
  const eliminated = b.eliminated === undefined ? !!before?.eliminated : !!b.eliminated;
  const note = b.note === undefined ? (before?.note ?? '') : str(b.note, 300);
  tx(() => {
    run(
      `INSERT INTO pitstop_results(episode_id, team_id, checkin_at, rank, eliminated, note) VALUES (?,?,?,?,?,?)
       ON CONFLICT(episode_id, team_id) DO UPDATE SET checkin_at = excluded.checkin_at, rank = excluded.rank, eliminated = excluded.eliminated, note = excluded.note`,
      episodeId, teamId, checkin, rank, eliminated ? 1 : 0, note,
    );
    if (b.eliminated !== undefined) run('UPDATE teams SET status = ? WHERE id = ?', eliminated ? 'eliminated' : 'alive', teamId);
  });
  audit(user, 'update', 'pitstop', `${episodeId}/${teamId}`, before, { checkin, rank, eliminated, note });
  notify('pitstop', episodeId);
  notify('progress', episodeId);
  if (b.eliminated !== undefined) notify('teams');
  return c.json({ pitstop: pitstopRows(episodeId) });
});
