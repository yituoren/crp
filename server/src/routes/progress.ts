import { Hono } from 'hono';
import { all, get, run, tx, now } from '../db.js';
import { hostOnly, canRecordProgress, canManagePenalty, isHostRole, type Env, isAdminRole } from '../auth.js';
import { recomputeEliminations } from '../elimination.js';
import { audit, body, str, int, intParam, isoOrNull, notify, bad, notFound, forbidden, editLockReason, currencyMode, fmtMoneyServer } from '../util.js';
import { teamLabelMap } from './teams.js';
import { addLedgerEntry, revertLedgerEntry } from './ledger.js';
import { episodeInEvent } from './episodes.js';
import { prevEndTime, emptyProgress, chainAfterComplete, upsertProgress } from '../progressCore.js';

export const progressRoutes = new Hono<Env>();

/** 只有这些类型的环节是每支队伍都必须经过的；快进/减速带/回转/让路/对抗只有部分队伍会用 */
const MANDATORY_TYPES = new Set(['SL', 'RI', 'TI', 'DT', 'RB', 'Union', 'Shuffle', 'Trap', 'PS']);

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
    if (!MANDATORY_TYPES.has(l.type)) continue;
    if (!p?.completed_at) missing.push(l.type === 'RI' ? `→ ${l.name}` : l.name);
  }
  return missing;
}

export function listCutoffUses(episodeId: number) {
  return all('SELECT * FROM cutoff_uses WHERE episode_id = ? ORDER BY used_at, id', episodeId);
}
/** 某队某种熔断下次可用的时间（毫秒）；null = 该队不在此环节进行中 */
function cutoffReadyAt(teamId: number, leg: { id: number; episode_id: number }, cf: { id: number; start_min: number; interval_min: number }): number | null {
  const p = get<{ arrived_at: string | null; completed_at: string | null }>('SELECT arrived_at, completed_at FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', leg.episode_id, teamId, leg.id);
  if (!p?.arrived_at || p.completed_at) return null;
  let ready = new Date(p.arrived_at).getTime() + cf.start_min * 60000;
  const last = get<{ used_at: string }>('SELECT used_at FROM cutoff_uses WHERE team_id = ? AND cutoff_id = ? ORDER BY used_at DESC, id DESC LIMIT 1', teamId, cf.id);
  if (last) ready = Math.max(ready, new Date(last.used_at).getTime() + cf.interval_min * 60000);
  return ready;
}

/** 使用一次熔断：主办任意队伍；跟队仅所跟队伍。队伍必须在该环节进行中且倒计时已到；货币模式按设置扣币 */
progressRoutes.post('/cutoffs/:id/use', async (c) => {
  const cutoffId = intParam(c, 'id');
  const user = c.get('user');
  const b = await body(c);
  const teamId = int(b.teamId, 0);
  const cf = get<any>('SELECT * FROM leg_cutoffs WHERE id = ?', cutoffId);
  if (!cf) throw notFound('熔断不存在');
  const leg = get<any>('SELECT * FROM legs WHERE id = ?', cf.leg_id);
  if (!leg) throw notFound('环节不存在');
  const episode = episodeInEvent(c, leg.episode_id);
  const team = get<{ id: number; status: string; currency: number; event_id: number }>('SELECT * FROM teams WHERE id = ?', teamId);
  if (!team || team.event_id !== c.get('event').id) throw notFound('队伍不存在');
  if (!isAdminRole(user.role) && episode.status === 'pending') throw bad(`${episode.code} 尚未开始`);
  { const r = editLockReason(user, episode as { status: string; code: string }, team); if (r) throw forbidden(r); }
  if (!canRecordProgress(user, episode.id, teamId, leg.id)) throw forbidden('只有主办或该队伍的跟队可以使用熔断');
  const ready = cutoffReadyAt(teamId, leg, cf);
  if (ready === null) throw bad('该队伍不在此环节进行中');
  const nowMs = Date.now();
  if (nowMs < ready - 2000) throw bad(`熔断尚未就绪，还需 ${Math.ceil((ready - nowMs) / 1000)} 秒`);
  let ledgerId: number | null = null;
  if (cf.cost > 0 && currencyMode() === 'coin') {
    if (team.currency < cf.cost) throw bad(`货币不足：需要 ${fmtMoneyServer(cf.cost)}，当前 ${fmtMoneyServer(team.currency)}`);
    ledgerId = addLedgerEntry({ episodeId: episode.id, teamId, delta: -cf.cost, reason: `熔断：${cf.name}`, legId: leg.id, kind: 'cutoff', user });
  }
  const r = run(
    'INSERT INTO cutoff_uses(episode_id, leg_id, team_id, cutoff_id, cutoff_name, used_at, used_by, used_by_name, ledger_id) VALUES (?,?,?,?,?,?,?,?,?)',
    episode.id, leg.id, teamId, cf.id, cf.name, now(), user.id, user.displayName, ledgerId,
  );
  audit(user, 'cutoff_use', 'team', teamId, undefined, { cutoff: cf.name, leg: leg.name, ledgerId });
  notify('progress', episode.id);
  if (ledgerId) { notify('ledger', episode.id); notify('teams'); }
  return c.json({ id: Number(r.lastInsertRowid) });
});

/** 删除一条熔断使用记录（主办）：扣过的币一并反向 */
progressRoutes.delete('/cutoff-uses/:id', hostOnly, (c) => {
  const id = intParam(c, 'id');
  const user = c.get('user');
  const u = get<any>('SELECT * FROM cutoff_uses WHERE id = ?', id);
  if (!u) throw notFound('使用记录不存在');
  const episode = episodeInEvent(c, u.episode_id);
  { const r = editLockReason(user, episode as { status: string; code: string }, get<{ status: string }>('SELECT status FROM teams WHERE id = ?', u.team_id)); if (r) throw forbidden(r); }
  if (u.ledger_id) revertLedgerEntry(u.ledger_id, user);
  run('DELETE FROM cutoff_uses WHERE id = ?', id);
  audit(user, 'cutoff_use_delete', 'team', u.team_id, u);
  notify('progress', episode.id);
  if (u.ledger_id) { notify('ledger', episode.id); notify('teams'); }
  return c.json({ ok: true });
});

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
  episodeInEvent(c, episodeId);
  return c.json({ progress: listProgress(episodeId), penalties: listPenalties(episodeId), pitstop: pitstopRows(episodeId), cutoffUses: listCutoffUses(episodeId) });
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
  episodeInEvent(c, episodeId);
  const leg = get<any>('SELECT * FROM legs WHERE id = ? AND episode_id = ?', legId, episodeId);
  if (!leg) throw notFound('环节不存在');
  if (action === 'single') action = 'complete'; // 旧客户端兼容：所有环节都记开始/结束
  const episode = get<{ status: string; code: string }>('SELECT status, code FROM episodes WHERE id = ?', episodeId)!;
  if (!isAdminRole(user.role) && episode.status === 'pending') throw bad(`${episode.code} 尚未开始，开始赛段后才能记录`);
  { const r = editLockReason(user, episode, null); if (r) throw forbidden(r); }
  if (['arrive', 'complete'].includes(action) && leg.type !== 'SQ') {
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
       WHERE p.episode_id = ? AND p.team_id = ? AND (l.sort > (SELECT sort FROM legs WHERE id = ?)) AND p.completed_at IS NOT NULL AND l.type != 'SQ'`,
      episodeId, teamId, legId,
    );
    if (later.length) throw bad(`后面的环节已有记录（${later.map((r) => r.name).join('、')}），请先撤销后面的`);
  }
  const team = get<{ id: number; status: string; locked_from_leg_id: number | null }>('SELECT * FROM teams WHERE id = ?', teamId);
  if (!team) throw notFound('队伍不存在');
  if (!canRecordProgress(user, episodeId, teamId, legId)) throw forbidden('你没有该队伍/站点的记录权限');
  // 淘汰 / 退赛的队伍：所有记录只有管理员能改
  { const r = editLockReason(user, null, team); if (r) throw forbidden(r); }
  if (['undo_arrive', 'undo_complete'].includes(action) && !isHostRole(user.role)) throw forbidden('撤销记录仅主办可操作');

  const before = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, teamId, legId);
  // 支线：只能在主线进行中进入；主线完成后普通幕后不能再改支线。主线：支线进行中不能记录完成
  if (leg.type === 'SQ' && ['arrive', 'complete'].includes(action)) {
    const parent = parentLegOf(leg);
    const pp = parent ? get('SELECT arrived_at, completed_at FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, teamId, parent.id) : null;
    if (!pp?.arrived_at) throw bad('主线还没有开始，不能进入支线');
    if (pp.completed_at && !isHostRole(user.role)) throw forbidden('主线已记录完成，支线不能再修改');
    if (action === 'complete' && !before?.arrived_at) throw bad('请先记录开始支线');
  }
  if (action === 'complete' && leg.type !== 'SQ') {
    const br = branchLegOf(leg);
    const bp = br ? get('SELECT arrived_at, completed_at FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, teamId, br.id) : null;
    if (bp?.arrived_at && !bp.completed_at) throw bad('支线进行中，请先记录结束支线');
  }
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
        if (leg.type === 'Union') {
          // 联合：双方互选之后才能完成；任一方记录，另一方同时记录
          if (!cur.target_team_id) throw bad('请先选择合作队伍');
          const mate = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, cur.target_team_id, legId);
          if (!mate || mate.target_team_id !== teamId) throw bad('合作队伍尚未选择本队，双方互选后才能记录完成');
        }
        // 开始时间自动 = 上一个已完成环节的结束时间（首个环节留空）；支线的开始时间来自“开始支线”，不自动接
        if (!next.arrived_at && leg.type !== 'SQ') next.arrived_at = prevEndTime(episodeId, teamId, leg.sort);
        if (next.arrived_at && t < next.arrived_at) throw bad(`完成时间不能早于开始时间（${next.arrived_at}）`);
        next.completed_at = t;
      }
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
    tx(() => {
      upsertProgress(episodeId, teamId, legId, next, user.id);
      if (action === 'complete') chainAfterComplete(episodeId, teamId, leg.sort, next.completed_at, user.id, leg.type);
      if (action === 'complete' && leg.type === 'Union' && next.target_team_id) {
        // 合作队伍同步记录完成（同一时间），之后两队各自继续
        const mate = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, next.target_team_id, legId);
        if (mate && !mate.completed_at) {
          const mateNext = { ...mate, arrived_at: mate.arrived_at ?? prevEndTime(episodeId, mate.team_id, leg.sort), completed_at: next.completed_at };
          upsertProgress(episodeId, mate.team_id, legId, mateNext, user.id);
          chainAfterComplete(episodeId, mate.team_id, leg.sort, next.completed_at, user.id);
          audit(user, 'progress:complete', 'progress', `${episodeId}/${mate.team_id}/${legId}`, mate, mateNext);
        }
      }
      if (action === 'undo_complete' && cur.completed_at) unchainAfterUndo(episodeId, teamId, leg.sort, cur.completed_at, user.id, leg.type);
    });
    audit(user, `progress:${action}`, 'progress', `${episodeId}/${teamId}/${legId}`, before, next);
    notify('progress', episodeId);
    if (recomputeEliminations(c.get('event').id)) notify('teams');
  }
  const progress = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, teamId, legId);
  return c.json({ progress, already });
});

/** 上一个已完成环节的结束时间；没有则 null（首个环节的开始时间留空） */
/** 支线紧跟在主线之后：主线 = 支线前一个环节；支线 = 主线后一个环节（若是支线） */
function parentLegOf(leg: { episode_id: number; sort: number; type: string }) {
  if (leg.type !== 'SQ') return null;
  return get<{ id: number; type: string }>('SELECT id, type FROM legs WHERE episode_id = ? AND sort < ? ORDER BY sort DESC, id DESC LIMIT 1', leg.episode_id, leg.sort) ?? null;
}
function branchLegOf(leg: { id: number; episode_id: number; sort: number; type: string }) {
  if (leg.type === 'SQ') return null;
  const next = get<{ id: number; type: string }>('SELECT id, type FROM legs WHERE episode_id = ? AND sort > ? ORDER BY sort, id LIMIT 1', leg.episode_id, leg.sort);
  return next?.type === 'SQ' ? next : null;
}
/** 撤销完成后：下一个环节若只是自动带上了这个开始时间，也一并清掉 */
function unchainAfterUndo(episodeId: number, teamId: number, sort: number, oldEnd: string, userId: number, legType = '') {
  if (legType === 'SQ') return;
  const nextLeg = get("SELECT id FROM legs WHERE episode_id = ? AND sort > ? AND type != 'SQ' ORDER BY sort, id LIMIT 1", episodeId, sort);
  if (!nextLeg) return;
  const np = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, teamId, nextLeg.id);
  if (np && !np.completed_at && np.arrived_at === oldEnd) upsertProgress(episodeId, teamId, nextLeg.id, { ...np, arrived_at: null }, userId);
}
/** 修改记录改了结束时间：下一个环节的开始时间若还是跟着旧值（或为空），同步成新值 */
function rechainAfterEdit(episodeId: number, teamId: number, sort: number, oldEnd: string | null, newEnd: string | null, userId: number, legType = '') {
  if (oldEnd === newEnd || legType === 'SQ') return;
  const nextLeg = get("SELECT id FROM legs WHERE episode_id = ? AND sort > ? AND type != 'SQ' ORDER BY sort, id LIMIT 1", episodeId, sort);
  if (!nextLeg) return;
  const np = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, teamId, nextLeg.id) ?? emptyProgress();
  if (np.completed_at) return;
  if (np.arrived_at && np.arrived_at !== oldEnd) return; // 下一环节的开始时间被人手动改过，不动
  upsertProgress(episodeId, teamId, nextLeg.id, { ...np, arrived_at: newEnd }, userId);
}

/** 修改记录：主办任意；跟队可改所跟队伍在进行中赛段的已有记录（不能清空时间、不能填未来） */
progressRoutes.put('/progress/:episodeId/:teamId/:legId', async (c) => {
  const episodeId = intParam(c, 'episodeId'), teamId = intParam(c, 'teamId'), legId = intParam(c, 'legId');
  episodeInEvent(c, episodeId);
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
  const episodeRow = get('SELECT status, code FROM episodes WHERE id = ?', episodeId)!;
  if (episodeRow.status === 'pending' && !isAdminRole(user.role)) throw bad(`${episodeRow.code} 尚未开始，开始赛段后才能操作`);
  const teamRow = get<{ id: number; status: string; locked_from_leg_id: number | null }>('SELECT * FROM teams WHERE id = ?', teamId);
  if (!teamRow) throw notFound('队伍不存在');
  { const r = editLockReason(user, episodeRow as { status: string; code: string }, teamRow); if (r) throw forbidden(r); }
  if (!isHostRole(user.role)) {
    if (!canRecordProgress(user, episodeId, teamId, legId)) throw forbidden('只能修改所跟队伍的记录');
    if (!before) throw bad('还没有记录，请先记录');
    if ((before.arrived_at && !next.arrived_at) || (before.completed_at && !next.completed_at)) throw bad('跟队不能清空已有时间，如需撤销请联系主办');
    const limit = Date.now() + 2 * 60 * 1000;
    for (const t of [next.arrived_at, next.completed_at]) if (t && new Date(t).getTime() > limit) throw bad('记录时间不能晚于当前时间');
  }
  if (next.arrived_at && next.completed_at && next.completed_at < next.arrived_at) throw bad('完成时间不能早于开始时间');
  const legRow = get<{ id: number; episode_id: number; sort: number; type: string }>('SELECT id, episode_id, sort, type FROM legs WHERE id = ?', legId)!;
  if (legRow.type === 'SQ' && !isHostRole(user.role)) {
    const parent = parentLegOf(legRow);
    const pp = parent ? get('SELECT completed_at FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, teamId, parent.id) : null;
    if (pp?.completed_at) throw forbidden('主线已记录完成，支线不能再修改');
  }
  tx(() => {
    upsertProgress(episodeId, teamId, legId, next, user.id);
    rechainAfterEdit(episodeId, teamId, legRow.sort, before?.completed_at ?? null, next.completed_at, user.id, legRow.type);
  });
  audit(user, 'progress:edit', 'progress', `${episodeId}/${teamId}/${legId}`, before, next);
  notify('progress', episodeId);
  if (recomputeEliminations(c.get('event').id)) notify('teams');
  return c.json({ ok: true });
});

// ---------- 罚时 ----------
/** 补罚时：minutes 为正是增加罚时，为负是减少罚时。主办与本赛段站点人员可操作 */
progressRoutes.post('/episodes/:id/penalties', async (c) => {
  const episodeId = intParam(c, 'id');
  episodeInEvent(c, episodeId);
  const user = c.get('user');
  const b = await body(c);
  const teamId = int(b.teamId), minutes = int(b.minutes);
  if (!teamId || !minutes) throw bad('缺少队伍或罚时分钟数');
  if (!canManagePenalty(user, episodeId, teamId)) throw forbidden('只有主办、本赛段站点人员或该队伍的跟队可以操作罚时');
  const teamRow = get<{ status: string }>('SELECT status FROM teams WHERE id = ?', teamId);
  if (!teamRow) throw notFound('队伍不存在');
  const epRow = get<{ status: string; code: string }>('SELECT status, code FROM episodes WHERE id = ?', episodeId);
  if (!epRow) throw notFound('赛段不存在');
  if (epRow.status === 'pending' && !isAdminRole(user.role)) throw bad(`${epRow.code} 尚未开始，开始赛段后才能操作罚时`);
  { const r = editLockReason(user, epRow, teamRow); if (r) throw forbidden(r); }
  const legId = int(b.legId, 0) || null;
  if (legId && !get('SELECT 1 FROM legs WHERE id = ? AND episode_id = ?', legId, episodeId)) throw notFound('环节不存在');
  if (!legId && !isHostRole(user.role)) throw forbidden('“其他”环节的罚时/补时只能由主办操作，请选择具体环节');
  const r = run(
    'INSERT INTO penalties(episode_id, team_id, minutes, reason, applied_by, applied_at, leg_id) VALUES (?,?,?,?,?,?,?)',
    episodeId, teamId, minutes, str(b.reason, 200), user.id, now(), legId,
  );
  audit(user, 'create', 'penalty', Number(r.lastInsertRowid), undefined, { episodeId, teamId, minutes, reason: b.reason });
  notify('progress', episodeId);
  if (recomputeEliminations(c.get('event').id)) notify('teams');
  return c.json({ id: Number(r.lastInsertRowid) });
});

/** 撤销一条罚时/补时：只有发出这条记录的本人和主办可以撤销 */
progressRoutes.post('/penalties/:id/revert', (c) => {
  const id = intParam(c, 'id');
  const user = c.get('user');
  const orig = get('SELECT * FROM penalties WHERE id = ?', id);
  if (!orig) throw notFound('罚时记录不存在');
  if (!isHostRole(user.role) && orig.applied_by !== user.id) throw forbidden('只有发出这条记录的本人或主办可以撤销');
  { const r = editLockReason(user, get<{ status: string; code: string }>('SELECT status, code FROM episodes WHERE id = ?', orig.episode_id), get<{ status: string }>('SELECT status FROM teams WHERE id = ?', orig.team_id)); if (r) throw forbidden(r); }
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
  if (recomputeEliminations(c.get('event').id)) notify('teams');
  return c.json({ id: newId });
});

// ---------- 终点结算 ----------
export function pitstopRows(episodeId: number) {
  const psLeg = get('SELECT id FROM legs WHERE episode_id = ? AND type = ? ORDER BY sort DESC LIMIT 1', episodeId, 'PS');
  const labels = teamLabelMap();
  const teams = all<any>('SELECT id, code, name, status, eliminated_leg_id FROM teams WHERE event_id = (SELECT event_id FROM episodes WHERE id = ?) ORDER BY sort, id', episodeId).map((t): any => ({ ...t, name: labels.get(t.id) ?? t.name }));
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
      rank: null as number | null, eliminated: !!psLeg && t.eliminated_leg_id === psLeg.id, note: r?.note ?? '',
    };
  });
  // 名次实时计算：有最终成绩且未退赛的队伍按最终成绩排序；签到、罚时、补时一变名次就变
  rows
    .filter((r) => r.final_time && r.team_status !== 'withdrawn')
    .sort((a, b) => a.final_time!.localeCompare(b.final_time!))
    .forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

progressRoutes.get('/episodes/:id/pitstop', (c) => { episodeInEvent(c, intParam(c, 'id')); return c.json({ pitstop: pitstopRows(intParam(c, 'id')) }); });

progressRoutes.put('/episodes/:id/pitstop/:teamId', hostOnly, async (c) => {
  const episodeId = intParam(c, 'id'), teamId = intParam(c, 'teamId');
  episodeInEvent(c, episodeId);
  const user = c.get('user');
  const b = await body(c);
  { const r = editLockReason(user, get<{ status: string; code: string }>('SELECT status, code FROM episodes WHERE id = ?', episodeId), get<{ status: string }>('SELECT status FROM teams WHERE id = ?', teamId)); if (r) throw forbidden(r); }
  const before = get('SELECT * FROM pitstop_results WHERE episode_id = ? AND team_id = ?', episodeId, teamId);
  const checkin = b.checkinAt === undefined ? (before?.checkin_at ?? null) : isoOrNull(b.checkinAt);
  const note = b.note === undefined ? (before?.note ?? '') : str(b.note, 300);
  run(
    `INSERT INTO pitstop_results(episode_id, team_id, checkin_at, rank, eliminated, note) VALUES (?,?,?,NULL,0,?)
     ON CONFLICT(episode_id, team_id) DO UPDATE SET checkin_at = excluded.checkin_at, note = excluded.note`,
    episodeId, teamId, checkin, note,
  );
  audit(user, 'update', 'pitstop', `${episodeId}/${teamId}`, before, { checkin, note });
  notify('pitstop', episodeId);
  notify('progress', episodeId);
  if (recomputeEliminations(c.get('event').id)) notify('teams');
  return c.json({ pitstop: pitstopRows(episodeId) });
});
