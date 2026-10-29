import { Hono, type Context } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, tx, now, UPLOAD_DIR, fromCents } from '../db.js';
import { hostOnly, canUploadToLeg, isAdminRole, isHostRole, parseLegIds, type Env, type EventRow } from '../auth.js';
import { audit, body, str, int, intParam, notify, bad, notFound, forbidden, money, isoOrNull } from '../util.js';
import { startEpisodeNow, departurePlan, type EpisodeRow } from '../episodeStart.js';
import { teamLabelMap } from './teams.js';
import { recomputeEliminations, lockFromAfterLastRecord } from '../elimination.js';

export const LEG_TYPES = ['SL', 'RI', 'TI', 'DT', 'RB', 'FF', 'Union', 'Shuffle', 'UT', 'YD', 'SB', 'FO', 'Trap', 'SQ', 'PS'] as const;
export type RecordMode = 'none' | 'single' | 'full';
/** Defaults per leg type: whether station crew is needed, record mode */
export const TYPE_DEFAULTS: Record<string, { staff: 0 | 1; mode: RecordMode }> = {
  SL: { staff: 1, mode: 'full' },   // Starting Line: departure
  RI: { staff: 0, mode: 'full' },     // Route Info: no station, no time
  TI: { staff: 1, mode: 'full' },
  DT: { staff: 1, mode: 'full' },
  RB: { staff: 1, mode: 'full' },
  FF: { staff: 1, mode: 'full' },     // Fast Forward
  Union: { staff: 1, mode: 'full' },
  Shuffle: { staff: 1, mode: 'full' },  // Shuffle: everyone regroups and restarts; arrival / departure
  UT: { staff: 1, mode: 'full' },   // U-Turn: check-in + target team
  YD: { staff: 1, mode: 'full' },   // Yield: check-in + target team
  SB: { staff: 1, mode: 'full' },     // Speed Bump
  FO: { staff: 1, mode: 'full' },     // Face Off
  Trap: { staff: 1, mode: 'full' },
  SQ: { staff: 1, mode: 'full' },     // Side quest: follows a main leg, can be entered while the main leg runs, the main leg's clock pauses meanwhile
  PS: { staff: 1, mode: 'full' },   // Pit Stop: check-in
};

/** A side quest must directly follow an ordinary main leg (not the Starting Line, a pit stop or another side quest) */
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

/** Shop stock of legs: event item, price and remaining count (quantity minus purchases on that leg that are not reverted; null quantity = unlimited) */
export function shopStock(where: string, ...params: number[]) {
  return all<{ id: number; leg_id: number; item_id: number; name: string; price: number; quantity: number | null; sold: number }>(
    `SELECT s.id, s.leg_id, s.shop_item_id AS item_id, i.name, i.price, s.quantity,
       (SELECT COUNT(*) FROM currency_ledger c WHERE c.kind = 'shop' AND c.leg_id = s.leg_id AND c.item_id = s.shop_item_id AND c.reverts_id IS NULL AND c.reverted = 0) AS sold
     FROM leg_shop_items s JOIN shop_items i ON i.id = s.shop_item_id WHERE ${where} ORDER BY s.sort, s.id`, ...params,
  ).map((r) => ({ ...r, price: fromCents(r.price), remaining: r.quantity === null ? null : Math.max(0, r.quantity - r.sold) }));
}

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
  const shopByLeg = new Map<number, any[]>();
  for (const it of shopStock('s.leg_id IN (SELECT l.id FROM legs l JOIN episodes e ON e.id = l.episode_id WHERE e.event_id = ?)', eventId)) {
    if (!shopByLeg.has(it.leg_id)) shopByLeg.set(it.leg_id, []);
    shopByLeg.get(it.leg_id)!.push(it);
  }
  const legsByEp = new Map<number, any[]>();
  for (const l of legs) {
    if (!legsByEp.has(l.episode_id)) legsByEp.set(l.episode_id, []);
    const norm = {};
    legsByEp.get(l.episode_id)!.push({ ...l, ...norm, attachments: attByLeg.get(l.id) ?? [], cutoffs: cutoffsByLeg.get(l.id) ?? [], shop: shopByLeg.get(l.id) ?? [] });
  }
  return episodes.map((e) => ({ ...e, budget: fromCents(e.budget), legs: legsByEp.get(e.id) ?? [] }));
}

/** The episode must belong to the current event */
export function episodeInEvent(c: Context, id: number) {
  const ep = get('SELECT * FROM episodes WHERE id = ?', id);
  if (!ep || ep.event_id !== (c.get('event') as EventRow).id) throw notFound('赛段不存在');
  return ep;
}
/** Once an episode has started (running or finished) only admins may add, delete or reorder legs or change type, elimination and cutoff settings */
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

/** Leg list: judge criteria are visible only to hosts / admins and the crew assigned as station of that leg in the episode; others get null */
episodeRoutes.get('/episodes', (c) => {
  const user = c.get('user');
  const episodes = loadEpisodes(c.get('event').id);
  if (isHostRole(user.role)) return c.json({ episodes });
  const mine = new Map<number, Set<number>>();
  for (const a of all<{ episode_id: number; leg_id: number | null; leg_ids: string | null }>("SELECT episode_id, leg_id, leg_ids FROM assignments WHERE user_id = ? AND role = 'station'", user.id)) {
    mine.set(a.episode_id, new Set(parseLegIds(a)));
  }
  for (const ep of episodes as any[]) for (const l of ep.legs) if (!mine.get(ep.id)?.has(l.id)) l.judge_criteria = null;
  return c.json({ episodes });
});

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
    // Fixed structure: the first episode opens with a Starting Line, every episode ends with a Pit Stop
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

/** Start an episode: mark running, record the start time, issue the episode budget to every alive team (once) */
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

/** Finish an episode: mark finished and record the finish time */
/** Departure plan: each team's automatic departure time (only when a start time is set) */
episodeRoutes.get('/episodes/:id/departures', (c) => {
  const ep = episodeInEvent(c, intParam(c, 'id'));
  return c.json({ departures: departurePlan(ep as EpisodeRow) });
});

/** Reset an episode (testing): clear the records of this and all later episodes and set them back to pending; leg settings, schedule and attachments stay */
episodeRoutes.post('/episodes/:id/reset', hostOnly, (c) => {
  const id = intParam(c, 'id');
  const ep = episodeInEvent(c, id);
  const eventId = ep.event_id;
  const ids = all<{ id: number; code: string }>('SELECT id, code FROM episodes WHERE event_id = ? AND (sort > ? OR (sort = ? AND id >= ?)) ORDER BY sort, id', eventId, ep.sort, ep.sort, id);
  tx(() => {
    for (const e of ids) {
      for (const table of ['progress', 'penalties', 'pitstop_results', 'cutoff_uses', 'currency_ledger', 'item_log']) run(`DELETE FROM ${table} WHERE episode_id = ?`, e.id);
      run("UPDATE episodes SET status = 'pending', started_at = NULL, finished_at = NULL, depart_base = NULL WHERE id = ?", e.id);
    }
    // Recompute balances from the remaining ledger (budget issues, purchases and cutoffs are all ledger rows)
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
  // Every team still racing before the pit stop (not withdrawn, not eliminated on an earlier leg) must have reached it
  const ps = get<{ id: number }>("SELECT id FROM legs WHERE episode_id = ? AND type = 'PS' ORDER BY sort DESC, id DESC LIMIT 1", id);
  if (ps) {
    const labels = teamLabelMap();
    const missing = all<{ id: number; name: string }>(
      `SELECT t.id, t.name FROM teams t WHERE t.event_id = ? AND t.status != 'withdrawn' AND (t.eliminated_leg_id IS NULL OR t.eliminated_leg_id = ?)
         AND NOT EXISTS (SELECT 1 FROM pitstop_results r WHERE r.episode_id = ? AND r.team_id = t.id AND r.checkin_at IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM progress p WHERE p.episode_id = ? AND p.team_id = t.id AND p.leg_id = ? AND p.completed_at IS NOT NULL)
       ORDER BY t.sort, t.id`, ep.event_id, ps.id, id, id, ps.id,
    );
    if (missing.length) throw bad(`还有队伍没有到达中继站：${missing.map((t) => labels.get(t.id) ?? t.name).join('、')}`);
  }
  run("UPDATE episodes SET status = 'finished', finished_at = COALESCE(finished_at, ?) WHERE id = ?", now(), id);
  audit(c.get('user'), 'finish', 'episode', id, { status: ep.status });
  notify('episodes');
  return c.json({ ok: true });
});

function legFields(b: any, before?: any) {
  const f = legFieldsRaw(b, before);
  if (f.can_eliminate && f.eliminate_count < 1) throw bad('勾选了可淘汰，请填写淘汰队数');
  if (!f.can_eliminate) f.eliminate_count = 0;
  return f;
}
function legFieldsRaw(b: any, before?: any) {
  const pick = (k: string, max = 5000) => (b[k] === undefined ? (before?.[k] ?? '') : str(b[k], max));
  const type = LEG_TYPES.includes(b.type) ? b.type : (before?.type ?? 'TI');
  // Station need is looked up by type (only Route Info needs none); every leg records start and end times
  const needs_staff = (TYPE_DEFAULTS[type] ?? { staff: 1 }).staff;
  const record_mode = 'full';
  const minutes = (k: string) => (b[k] === undefined ? (before?.[k] ?? 0) : Math.max(0, int(b[k], 0)));
  return {
    type,
    needs_staff,
    record_mode,
    cutoff_start: minutes('cutoff_start'),
    cutoff_interval: minutes('cutoff_interval'),
    shop_open: before?.shop_open ?? 0, // maintained by PUT /legs/:id/shop
    // Pit stops may eliminate (legacy default 2); other legs optional
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
  // new legs are inserted before the pit stop
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

/** Save the cutoff list as a whole: rows with an id are updated, others inserted, missing ones deleted (use records keep a name snapshot) */
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

/** Save the leg's shop stock as a whole: [{ item_id, quantity (null = unlimited) }]; the shop is open exactly when the list is not empty */
episodeRoutes.put('/legs/:id/shop', hostOnly, async (c) => {
  const id = intParam(c, 'id');
  const leg = legInEvent(c, id);
  const b = await body(c);
  if (!Array.isArray(b.items)) throw bad('items 必须是数组');
  const seen = new Set<number>();
  const items = b.items.map((it: any, i: number) => {
    const itemId = int(it.item_id, 0);
    if (!itemId || !get('SELECT 1 FROM shop_items WHERE id = ? AND event_id = ?', itemId, c.get('event').id)) throw bad('请选择赛事设置里已有的商品');
    if (seen.has(itemId)) throw bad('同一种商品只能添加一次');
    seen.add(itemId);
    const q = it.quantity === null || it.quantity === undefined || it.quantity === '' ? null : Number(it.quantity);
    if (q !== null && !(Number.isInteger(q) && q >= 0)) throw bad('数量必须是非负整数，留空表示不限');
    return { item_id: itemId, quantity: q, sort: i };
  });
  const before = all<{ shop_item_id: number; quantity: number | null }>('SELECT shop_item_id, quantity FROM leg_shop_items WHERE leg_id = ? ORDER BY sort, id', id);
  const same = before.length === items.length && before.every((o, i) => o.shop_item_id === items[i].item_id && o.quantity === items[i].quantity);
  if (same) return c.json({ ok: true });
  assertStructureEditable(c, leg.episode_id);
  tx(() => {
    run('DELETE FROM leg_shop_items WHERE leg_id = ?', id);
    for (const it of items) run('INSERT INTO leg_shop_items(leg_id, shop_item_id, quantity, sort, created_at) VALUES (?,?,?,?,?)', id, it.item_id, it.quantity, it.sort, now());
    run('UPDATE legs SET shop_open = ? WHERE id = ?', items.length ? 1 : 0, id);
  });
  audit(c.get('user'), 'update', 'leg_shop_items', id, before, items);
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
  const finalOrder = [...sl, ...mid, ...ps]; // Starting Line always first, Pit Stop always last
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

// ---------- Attachments ----------
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
