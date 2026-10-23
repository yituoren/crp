import { Hono, type Context } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, tx, now, UPLOAD_DIR, fromCents } from '../db.js';
import { hostOnly, canUploadToLeg, isAdminRole, type Env, type EventRow } from '../auth.js';
import { audit, body, str, int, intParam, notify, bad, notFound, forbidden, money, isoOrNull } from '../util.js';
import { startEpisodeNow, departurePlan, type EpisodeRow } from '../episodeStart.js';
import { recomputeEliminations, lockFromAfterLastRecord } from '../elimination.js';

export const LEG_TYPES = ['SL', 'RI', 'TI', 'DT', 'RB', 'FF', 'Union', 'Shuffle', 'UT', 'YD', 'SB', 'FO', 'Trap', 'SQ', 'PS'] as const;
export type RecordMode = 'none' | 'single' | 'full';
/** 各类型环节的默认行为：是否需要站点人员、记录方式 */
export const TYPE_DEFAULTS: Record<string, { staff: 0 | 1; mode: RecordMode }> = {
  SL: { staff: 1, mode: 'full' },   // 起跑线：记出发
  RI: { staff: 0, mode: 'full' },     // 路线信息：不排人不记时
  TI: { staff: 1, mode: 'full' },
  DT: { staff: 1, mode: 'full' },
  RB: { staff: 1, mode: 'full' },
  FF: { staff: 1, mode: 'full' },     // 快进 Fast Forward
  Union: { staff: 1, mode: 'full' },
  Shuffle: { staff: 1, mode: 'full' },  // 洗牌：全员到齐后重新出发，记到达/出发
  UT: { staff: 1, mode: 'full' },   // 回转点：打卡 + 施加对象
  YD: { staff: 1, mode: 'full' },   // 让路点：打卡 + 施加对象
  SB: { staff: 1, mode: 'full' },     // 减速带
  FO: { staff: 1, mode: 'full' },     // 对抗 Face Off
  Trap: { staff: 1, mode: 'full' },
  SQ: { staff: 1, mode: 'full' },     // 支线：紧跟在一个主线环节之后，主线进行中可随时进入，支线计时期间主线暂停
  PS: { staff: 1, mode: 'full' },   // 中继站：记签到
};

/** 支线必须紧跟在一个普通主线环节之后（不能跟在起跑线、中继站或另一条支线后面） */
export function validateBranchPlacement(episodeId: number) {
  const legs = all<{ id: number; type: string; name: string }>('SELECT id, type, name FROM legs WHERE episode_id = ? ORDER BY sort, id', episodeId);
  legs.forEach((l, i) => {
    if (l.type !== 'SQ') return;
    const prev = legs[i - 1];
    if (!prev || ['SL', 'PS', 'SQ'].includes(prev.type)) throw bad(`支线「${l.name}」必须紧跟在一个主线环节之后`);
  });
}
export const episodeRoutes = new Hono<Env>();

const MAX_UPLOAD = 10 * 1024 * 1024;

export function loadEpisodes(eventId: number) {
  const episodes = all('SELECT * FROM episodes WHERE event_id = ? ORDER BY sort, id', eventId);
  const legs = all('SELECT l.* FROM legs l JOIN episodes e ON e.id = l.episode_id WHERE e.event_id = ? ORDER BY l.episode_id, l.sort, l.id', eventId);
  const atts = all('SELECT a.id, a.leg_id, a.filename, a.mime, a.size, a.uploaded_by, a.created_at FROM attachments a JOIN legs l ON l.id = a.leg_id JOIN episodes e ON e.id = l.episode_id WHERE e.event_id = ? ORDER BY a.id', eventId);
  const attByLeg = new Map<number, any[]>();
  for (const a of atts) {
    if (!attByLeg.has(a.leg_id)) attByLeg.set(a.leg_id, []);
    attByLeg.get(a.leg_id)!.push({ ...a, url: `/api/files/${a.id}` });
  }
  const cutoffsByLeg = new Map<number, any[]>();
  for (const cf of all('SELECT c.* FROM leg_cutoffs c JOIN legs l ON l.id = c.leg_id JOIN episodes e ON e.id = l.episode_id WHERE e.event_id = ? ORDER BY c.sort, c.id', eventId)) {
    if (!cutoffsByLeg.has(cf.leg_id)) cutoffsByLeg.set(cf.leg_id, []);
    cutoffsByLeg.get(cf.leg_id)!.push({ id: cf.id, name: cf.name, start_min: cf.start_min, interval_min: cf.interval_min, cost: fromCents(cf.cost) });
  }
  const legsByEp = new Map<number, any[]>();
  for (const l of legs) {
    if (!legsByEp.has(l.episode_id)) legsByEp.set(l.episode_id, []);
    const norm = {};
    legsByEp.get(l.episode_id)!.push({ ...l, ...norm, attachments: attByLeg.get(l.id) ?? [], cutoffs: cutoffsByLeg.get(l.id) ?? [] });
  }
  return episodes.map((e) => ({ ...e, budget: fromCents(e.budget), legs: legsByEp.get(e.id) ?? [] }));
}

/** 赛段必须属于当前比赛 */
export function episodeInEvent(c: Context, id: number) {
  const ep = get('SELECT * FROM episodes WHERE id = ?', id);
  if (!ep || ep.event_id !== (c.get('event') as EventRow).id) throw notFound('赛段不存在');
  return ep;
}
/** 赛段开始后（进行中或已结束），环节的增删、顺序、类型、淘汰与熔断设置只有管理员能改 */
function assertStructureEditable(c: Context, episodeId: number) {
  const user = c.get('user');
  if (isAdminRole(user.role)) return;
  const ep = get<{ status: string; code: string }>('SELECT status, code FROM episodes WHERE id = ?', episodeId);
  if (ep && ep.status !== 'pending') throw forbidden(`${ep.code} 已开始，环节结构只有管理员可以修改`);
}

export function legInEvent(c: Context, id: number) {
  const leg = get('SELECT l.*, e.event_id FROM legs l JOIN episodes e ON e.id = l.episode_id WHERE l.id = ?', id);
  if (!leg || leg.event_id !== (c.get('event') as EventRow).id) throw notFound('环节不存在');
  return leg;
}

episodeRoutes.get('/episodes', (c) => c.json({ episodes: loadEpisodes(c.get('event').id) }));

episodeRoutes.post('/episodes', hostOnly, async (c) => {
  const b = await body(c);
  const eventId = c.get('event').id;
  const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM episodes WHERE event_id = ?', eventId)!.n;
  const code = str(b.code, 20) || `EP${count + 1}`;
  if (get('SELECT 1 FROM episodes WHERE code = ? AND event_id = ?', code, eventId)) throw bad(`赛段编号 ${code} 已存在`);
  const epId = tx(() => {
    const r = run(
      'INSERT INTO episodes(code, name, budget, sort, status, notes, event_id) VALUES (?,?,?,?,?,?,?)',
      code, str(b.name, 50) || code, b.budget === undefined ? 0 : money(b.budget, '经费'), count + 1, 'pending', str(b.notes), eventId,
    );
    const id = Number(r.lastInsertRowid);
    // 固定结构：第一个赛段以 Starting Line 开头；每个赛段以中继站结尾
    if (count === 0) run('INSERT INTO legs(episode_id, sort, type, name, needs_staff, record_mode) VALUES (?,?,?,?,1,?)', id, 1, 'SL', '起跑线', 'full');
    run('INSERT INTO legs(episode_id, sort, type, name, needs_staff, record_mode, can_eliminate, eliminate_count) VALUES (?,?,?,?,1,?,0,0)', id, 99, 'PS', '中继站', 'full');
    return id;
  });
  const r = { lastInsertRowid: epId };
  audit(c.get('user'), 'create', 'episode', epId, undefined, { code });
  notify('episodes');
  return c.json({ id: Number(r.lastInsertRowid) });
});

episodeRoutes.put('/episodes/:id', hostOnly, async (c) => {
  const id = intParam(c, 'id');
  const before = episodeInEvent(c, id);
  const b = await body(c);
  const next = {
    name: b.name === undefined ? before.name : str(b.name, 50) || before.name,
    budget: b.budget === undefined ? before.budget : money(b.budget, '经费'),
    status: ['pending', 'running', 'finished'].includes(b.status) ? b.status : before.status,
    notes: b.notes === undefined ? before.notes : str(b.notes),
    sort: b.sort === undefined ? before.sort : int(b.sort, before.sort),
    start_at: b.startAt === undefined ? before.start_at : isoOrNull(b.startAt),
    inherit_rank: b.inheritRank === undefined ? before.inherit_rank : (b.inheritRank ? 1 : 0),
    start_gap_min: b.startGapMin === undefined ? before.start_gap_min : Math.max(0, int(b.startGapMin, 0)),
  };
  if (b.startAt && !next.start_at) throw bad('自动开始时间格式不正确');
  run('UPDATE episodes SET name=?, budget=?, status=?, notes=?, sort=?, start_at=?, inherit_rank=?, start_gap_min=? WHERE id=?',
    next.name, next.budget, next.status, next.notes, next.sort, next.start_at, next.inherit_rank, next.start_gap_min, id);
  audit(c.get('user'), 'update', 'episode', id, before, next);
  notify('episodes');
  return c.json({ ok: true });
});

episodeRoutes.delete('/episodes/:id', hostOnly, (c) => {
  const id = intParam(c, 'id');
  const before = episodeInEvent(c, id);
  removeAttachmentFiles(all('SELECT path FROM attachments WHERE leg_id IN (SELECT id FROM legs WHERE episode_id = ?)', id));
  run('DELETE FROM episodes WHERE id = ?', id);
  audit(c.get('user'), 'delete', 'episode', id, before);
  notify('episodes');
  return c.json({ ok: true });
});

/** 开始赛段：状态改为进行中，记录开始时间，并给每支存活队伍发放本赛段经费（只发一次） */
episodeRoutes.post('/episodes/:id/start', hostOnly, (c) => {
  const id = intParam(c, 'id');
  const ep = episodeInEvent(c, id);
  if (ep.status === 'running') throw bad('该赛段已在进行中');
  const running = get("SELECT code FROM episodes WHERE status = 'running' AND id != ? AND event_id = ?", id, ep.event_id);
  if (running) throw bad(`${running.code} 仍在进行中，请先结束它再开始新的赛段`);
  const unfinished = all("SELECT code FROM episodes WHERE event_id = ? AND (sort < ? OR (sort = ? AND id < ?)) AND status != 'finished' ORDER BY sort, id", ep.event_id, ep.sort, ep.sort, id);
  if (unfinished.length) throw bad(`前面的赛段还没有结束：${unfinished.map((e) => e.code).join('、')}`);
  const issued = startEpisodeNow(ep as EpisodeRow, c.get('user'), now());
  return c.json({ ok: true, issuedBudgetTo: issued, alreadyStarted: !!ep.started_at });
});

/** 结束赛段：状态改为已结束，记录结束时间 */
/** 发车计划：每支队伍的自动出发时间（设置了自动开始时间才有） */
episodeRoutes.get('/episodes/:id/departures', (c) => {
  const ep = episodeInEvent(c, intParam(c, 'id'));
  return c.json({ departures: departurePlan(ep as EpisodeRow) });
});

/** 重置赛段（测试用）：清掉本赛段及之后所有赛段的记录数据，赛段回到未开始；环节设置、排班、附件不动 */
episodeRoutes.post('/episodes/:id/reset', hostOnly, (c) => {
  const id = intParam(c, 'id');
  const ep = episodeInEvent(c, id);
  const eventId = ep.event_id;
  const ids = all<{ id: number; code: string }>('SELECT id, code FROM episodes WHERE event_id = ? AND (sort > ? OR (sort = ? AND id >= ?)) ORDER BY sort, id', eventId, ep.sort, ep.sort, id);
  tx(() => {
    for (const e of ids) {
      for (const table of ['progress', 'penalties', 'pitstop_results', 'cutoff_uses', 'currency_ledger']) run(`DELETE FROM ${table} WHERE episode_id = ?`, e.id);
      run("UPDATE episodes SET status = 'pending', started_at = NULL, finished_at = NULL WHERE id = ?", e.id);
    }
    // 余额按剩余流水重算（经费发放、购买、熔断都在流水里）
    for (const t of all<{ id: number }>('SELECT id FROM teams WHERE event_id = ?', eventId)) {
      const sum = get<{ s: number | null }>('SELECT SUM(delta) AS s FROM currency_ledger WHERE team_id = ?', t.id)?.s ?? 0;
      run('UPDATE teams SET currency = ? WHERE id = ?', sum, t.id);
    }
    recomputeEliminations(eventId);
    for (const t of all<{ id: number }>("SELECT id FROM teams WHERE event_id = ? AND status = 'withdrawn'", eventId)) run('UPDATE teams SET locked_from_leg_id = ? WHERE id = ?', lockFromAfterLastRecord(eventId, t.id), t.id);
  });
  audit(c.get('user'), 'reset', 'episode', id, undefined, { episodes: ids.map((e) => e.code) });
  notify('episodes'); notify('teams'); notify('progress'); notify('ledger'); notify('pitstop');
  return c.json({ ok: true, episodes: ids.map((e) => e.code) });
});

episodeRoutes.post('/episodes/:id/finish', hostOnly, (c) => {
  const id = intParam(c, 'id');
  const ep = episodeInEvent(c, id);
  if (ep.status !== 'running') throw bad('只有进行中的赛段可以结束');
  run("UPDATE episodes SET status = 'finished', finished_at = COALESCE(finished_at, ?) WHERE id = ?", now(), id);
  audit(c.get('user'), 'finish', 'episode', id, { status: ep.status });
  notify('episodes');
  return c.json({ ok: true });
});

function legFields(b: any, before?: any) {
  const f = legFieldsRaw(b, before);
  if (f.can_eliminate && f.eliminate_count < 1) throw bad('勾选了可淘汰，请填写淘汰队数');
  return f;
}
function legFieldsRaw(b: any, before?: any) {
  const pick = (k: string, max = 5000) => (b[k] === undefined ? (before?.[k] ?? '') : str(b[k], max));
  const type = LEG_TYPES.includes(b.type) ? b.type : (before?.type ?? 'TI');
  // 是否需要站点由类型查表决定（目前只有路线信息不需要）；所有环节都记录开始/结束两个时间
  const needs_staff = (TYPE_DEFAULTS[type] ?? { staff: 1 }).staff;
  const record_mode = 'full';
  const minutes = (k: string) => (b[k] === undefined ? (before?.[k] ?? 0) : Math.max(0, int(b[k], 0)));
  return {
    type,
    needs_staff,
    record_mode,
    cutoff_start: minutes('cutoff_start'),
    cutoff_interval: minutes('cutoff_interval'),
    shop_open: b.shop_open === undefined ? (before?.shop_open ?? 0) : (b.shop_open ? 1 : 0),
    // 中继站一定可淘汰（默认 2 人）；其他环节可选
    can_eliminate: type === 'SQ' ? 0 : (b.can_eliminate === undefined ? (before?.can_eliminate ?? 0) : (b.can_eliminate ? 1 : 0)),
    eliminate_count: Math.max(0, b.eliminate_count === undefined ? (before?.eliminate_count ?? 0) : int(b.eliminate_count, 0)),
    name: b.name === undefined ? (before?.name ?? '') : str(b.name, 50) || (before?.name ?? '新环节'),
    description: pick('description'),
    address: pick('address', 300),
    map_url: pick('map_url', 500),
    clue_text: pick('clue_text'),
    judge_criteria: pick('judge_criteria'),
    open_time: pick('open_time', 50),
    close_time: pick('close_time', 50),
    detour_a: pick('detour_a', 100),
    detour_b: pick('detour_b', 100),
  };
}

episodeRoutes.post('/episodes/:id/legs', hostOnly, async (c) => {
  const episodeId = intParam(c, 'id');
  episodeInEvent(c, episodeId);
  const b = await body(c);
  if (b.type === 'SL' || b.type === 'PS') throw bad('Starting Line 与中继站由系统固定生成，不能手动添加');
  assertStructureEditable(c, episodeId);
  const f = legFields(b);
  if (!f.name) f.name = '新环节';
  // 新环节默认插在中继站之前
  const ps = get('SELECT id, sort FROM legs WHERE episode_id = ? AND type = ? ORDER BY sort DESC LIMIT 1', episodeId, 'PS');
  const maxSort = get<{ m: number | null }>('SELECT MAX(sort) AS m FROM legs WHERE episode_id = ?', episodeId)!.m ?? 0;
  const sort = ps ? ps.sort : maxSort + 1;
  const r = tx(() => {
    if (ps) run('UPDATE legs SET sort = sort + 1 WHERE episode_id = ? AND sort >= ?', episodeId, ps.sort);
    const inserted = run(
      `INSERT INTO legs(episode_id, sort, type, name, description, address, map_url, clue_text, judge_criteria, open_time, close_time, detour_a, detour_b, needs_staff, record_mode, cutoff_start, cutoff_interval, shop_open, can_eliminate, eliminate_count)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      episodeId, sort, f.type, f.name, f.description, f.address, f.map_url, f.clue_text, f.judge_criteria, f.open_time, f.close_time, f.detour_a, f.detour_b, f.needs_staff, f.record_mode, f.cutoff_start, f.cutoff_interval, f.shop_open, f.can_eliminate, f.eliminate_count,
    );
    validateBranchPlacement(episodeId);
    return inserted;
  });
  audit(c.get('user'), 'create', 'leg', Number(r.lastInsertRowid), undefined, f);
  notify('episodes', episodeId);
  return c.json({ id: Number(r.lastInsertRowid) });
});

episodeRoutes.put('/legs/:id', hostOnly, async (c) => {
  const id = intParam(c, 'id');
  const before = legInEvent(c, id);
  const b = await body(c);
  const fixed = before.type === 'SL' || before.type === 'PS';
  if (b.type !== undefined && b.type !== before.type && (fixed || b.type === 'SL' || b.type === 'PS')) throw bad('Starting Line 与中继站的类型固定，不能改成或改自其他类型');
  const f = legFields(b, before);
  if (f.type !== before.type || !!f.can_eliminate !== !!before.can_eliminate || f.eliminate_count !== before.eliminate_count || !!f.shop_open !== !!before.shop_open) assertStructureEditable(c, before.episode_id);
  tx(() => {
  run(
    `UPDATE legs SET type=?, name=?, description=?, address=?, map_url=?, clue_text=?, judge_criteria=?, open_time=?, close_time=?, detour_a=?, detour_b=?, needs_staff=?, record_mode=?, cutoff_start=?, cutoff_interval=?, shop_open=?, can_eliminate=?, eliminate_count=? WHERE id=?`,
    f.type, f.name, f.description, f.address, f.map_url, f.clue_text, f.judge_criteria, f.open_time, f.close_time, f.detour_a, f.detour_b, f.needs_staff, f.record_mode, f.cutoff_start, f.cutoff_interval, f.shop_open, f.can_eliminate, f.eliminate_count, id,
  );
  validateBranchPlacement(before.episode_id);
  });
  audit(c.get('user'), 'update', 'leg', id, before, f);
  if (recomputeEliminations(c.get('event').id)) notify('teams');
  notify('episodes', before.episode_id);
  return c.json({ ok: true });
});

/** 熔断设置整表保存：有 id 的更新，没有的新增，列表里没有的删除（使用记录里存了名字快照） */
episodeRoutes.put('/legs/:id/cutoffs', hostOnly, async (c) => {
  const id = intParam(c, 'id');
  const leg = legInEvent(c, id);
  const b = await body(c);
  if (!Array.isArray(b.items)) throw bad('items 必须是数组');
  const items = b.items.map((it: any, i: number) => ({ id: int(it.id, 0) || 0, name: str(it.name, 50), start_min: Math.max(0, int(it.start_min, 0)), interval_min: Math.max(0, int(it.interval_min, 0)), cost: it.cost ? money(it.cost, '消耗') : 0, sort: i }));
  for (const it of items) { if (!it.name) throw bad('熔断种类名称不能为空'); if (it.cost < 0) throw bad('消耗不能为负数'); }
  const before = all('SELECT * FROM leg_cutoffs WHERE leg_id = ? ORDER BY sort, id', id);
  const same = before.length === items.length && before.every((o, i) => { const n = items[i]; return n.id === o.id && n.name === o.name && n.start_min === o.start_min && n.interval_min === o.interval_min && n.cost === o.cost; });
  if (!same) assertStructureEditable(c, leg.episode_id);
  tx(() => {
    const keep = new Set<number>();
    for (const it of items) {
      if (it.id && get('SELECT 1 FROM leg_cutoffs WHERE id = ? AND leg_id = ?', it.id, id)) {
        run('UPDATE leg_cutoffs SET name = ?, start_min = ?, interval_min = ?, cost = ?, sort = ? WHERE id = ?', it.name, it.start_min, it.interval_min, it.cost, it.sort, it.id);
        keep.add(it.id);
      } else {
        const r = run('INSERT INTO leg_cutoffs(leg_id, name, start_min, interval_min, cost, sort, created_at) VALUES (?,?,?,?,?,?,?)', id, it.name, it.start_min, it.interval_min, it.cost, it.sort, now());
        keep.add(Number(r.lastInsertRowid));
      }
    }
    for (const old of before) if (!keep.has(old.id)) run('DELETE FROM leg_cutoffs WHERE id = ?', old.id);
  });
  audit(c.get('user'), 'update', 'leg_cutoffs', id, before, items);
  notify('episodes', leg.episode_id);
  return c.json({ ok: true });
});

episodeRoutes.delete('/legs/:id', hostOnly, (c) => {
  const id = intParam(c, 'id');
  const before = legInEvent(c, id);
  assertStructureEditable(c, before.episode_id);
  if (before.type === 'SL' || before.type === 'PS') throw bad('Starting Line 与中继站不能删除');
  removeAttachmentFiles(all('SELECT path FROM attachments WHERE leg_id = ?', id));
  run('DELETE FROM legs WHERE id = ?', id);
  audit(c.get('user'), 'delete', 'leg', id, before);
  notify('episodes', before.episode_id);
  return c.json({ ok: true });
});

episodeRoutes.put('/episodes/:id/legs/order', hostOnly, async (c) => {
  const episodeId = intParam(c, 'id');
  episodeInEvent(c, episodeId);
  assertStructureEditable(c, episodeId);
  const { ids } = await body(c);
  if (!Array.isArray(ids)) throw bad('ids 必须是数组');
  const types = new Map(all('SELECT id, type FROM legs WHERE episode_id = ?', episodeId).map((l) => [l.id, l.type]));
  const ordered = ids.map((x: unknown) => int(x)).filter((id: number) => types.has(id));
  const sl = ordered.filter((id: number) => types.get(id) === 'SL');
  const ps = ordered.filter((id: number) => types.get(id) === 'PS');
  const mid = ordered.filter((id: number) => types.get(id) !== 'SL' && types.get(id) !== 'PS');
  const finalOrder = [...sl, ...mid, ...ps]; // Starting Line 永远第一，中继站永远最后
  finalOrder.forEach((legId: number, i: number) => {
    if (types.get(legId) !== 'SQ') return;
    const prev = i > 0 ? types.get(finalOrder[i - 1]!) : undefined;
    if (!prev || ['SL', 'PS', 'SQ'].includes(prev)) throw bad('支线必须紧跟在一个主线环节之后');
  });
  tx(() => {
    finalOrder.forEach((legId: number, i: number) => run('UPDATE legs SET sort = ? WHERE id = ? AND episode_id = ?', i + 1, legId, episodeId));
  });
  audit(c.get('user'), 'reorder', 'leg', episodeId, undefined, ids);
  notify('episodes', episodeId);
  return c.json({ ok: true });
});

// ---------- 附件 ----------
function removeAttachmentFiles(rows: { path: string }[]) {
  for (const r of rows) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, r.path)); } catch { /* ignore */ }
  }
}

episodeRoutes.post('/legs/:id/attachments', async (c) => {
  const legId = intParam(c, 'id');
  const leg = get('SELECT * FROM legs WHERE id = ?', legId);
  if (!leg) throw notFound('环节不存在');
  const user = c.get('user');
  if (!canUploadToLeg(user, leg.episode_id, legId)) throw forbidden('只有主办或本站点人员可以上传附件');
  const form = await c.req.parseBody();
  const file = form['file'];
  if (!(file instanceof File)) throw bad('缺少文件');
  if (file.size > MAX_UPLOAD) throw bad('文件过大，请压缩至 10MB 以内');
  const ext = path.extname(file.name).slice(0, 10) || '';
  const stored = `${legId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), Buffer.from(await file.arrayBuffer()));
  const r = run(
    'INSERT INTO attachments(leg_id, filename, mime, path, size, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?)',
    legId, file.name.slice(0, 200), file.type || 'application/octet-stream', stored, file.size, user.id, now(),
  );
  audit(user, 'upload', 'attachment', Number(r.lastInsertRowid), undefined, { legId, filename: file.name });
  notify('episodes', leg.episode_id);
  return c.json({ id: Number(r.lastInsertRowid), url: `/api/files/${Number(r.lastInsertRowid)}` });
});

episodeRoutes.delete('/attachments/:id', async (c) => {
  const id = intParam(c, 'id');
  const att = get('SELECT a.*, l.episode_id FROM attachments a JOIN legs l ON l.id = a.leg_id WHERE a.id = ?', id);
  if (!att) throw notFound('附件不存在');
  const user = c.get('user');
  if (!canUploadToLeg(user, att.episode_id, att.leg_id)) throw forbidden('无权删除该附件');
  removeAttachmentFiles([att as { path: string }]);
  run('DELETE FROM attachments WHERE id = ?', id);
  audit(user, 'delete', 'attachment', id, { legId: att.leg_id, filename: att.filename });
  notify('episodes', att.episode_id);
  return c.json({ ok: true });
});

export const fileRoutes = new Hono<Env>();
fileRoutes.get('/files/:id', (c) => {
  const id = intParam(c, 'id');
  const att = get('SELECT * FROM attachments WHERE id = ?', id);
  if (!att) throw notFound('附件不存在');
  const full = path.join(UPLOAD_DIR, att.path);
  if (!fs.existsSync(full)) throw notFound('文件已丢失');
  const data = fs.readFileSync(full);
  const inline = att.mime.startsWith('image/') || att.mime === 'application/pdf';
  return c.body(data, 200, {
    'Content-Type': att.mime,
    'Content-Length': String(data.length),
    'Cache-Control': 'private, max-age=86400',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
  });
});
