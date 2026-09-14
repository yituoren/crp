import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, tx, now, UPLOAD_DIR } from '../db.js';
import { hostOnly, canUploadToLeg, type Env } from '../auth.js';
import { audit, body, str, int, intParam, notify, bad, notFound, forbidden } from '../util.js';

export const LEG_TYPES = ['SL', 'RI', 'TI', 'DT', 'RB', 'FO', 'Union', 'UT', 'YD', 'SB', 'PK', 'Trap', 'PS'] as const;
export type RecordMode = 'none' | 'single' | 'full';
/** 各类型环节的默认行为：是否需要站点人员、记录方式 */
export const TYPE_DEFAULTS: Record<string, { staff: 0 | 1; mode: RecordMode }> = {
  SL: { staff: 1, mode: 'single' },   // 起跑线：记出发
  RI: { staff: 0, mode: 'none' },     // 路线信息：不排人不记时
  TI: { staff: 1, mode: 'full' },
  DT: { staff: 1, mode: 'full' },
  RB: { staff: 1, mode: 'full' },
  FO: { staff: 1, mode: 'full' },
  Union: { staff: 1, mode: 'full' },
  UT: { staff: 1, mode: 'single' },   // 回转点：打卡 + 施加对象
  YD: { staff: 1, mode: 'single' },   // 让路点：打卡 + 施加对象
  SB: { staff: 1, mode: 'full' },     // 减速带
  PK: { staff: 1, mode: 'full' },     // 对抗 / PK
  Trap: { staff: 1, mode: 'full' },
  PS: { staff: 1, mode: 'single' },   // 中继站：记签到
};
export const episodeRoutes = new Hono<Env>();

const MAX_UPLOAD = 10 * 1024 * 1024;

export function loadEpisodes() {
  const episodes = all('SELECT * FROM episodes ORDER BY sort, id');
  const legs = all('SELECT * FROM legs ORDER BY episode_id, sort, id');
  const atts = all('SELECT id, leg_id, filename, mime, size, uploaded_by, created_at FROM attachments ORDER BY id');
  const attByLeg = new Map<number, any[]>();
  for (const a of atts) {
    if (!attByLeg.has(a.leg_id)) attByLeg.set(a.leg_id, []);
    attByLeg.get(a.leg_id)!.push({ ...a, url: `/api/files/${a.id}` });
  }
  const legsByEp = new Map<number, any[]>();
  for (const l of legs) {
    if (!legsByEp.has(l.episode_id)) legsByEp.set(l.episode_id, []);
    legsByEp.get(l.episode_id)!.push({ ...l, attachments: attByLeg.get(l.id) ?? [] });
  }
  return episodes.map((e) => ({ ...e, legs: legsByEp.get(e.id) ?? [] }));
}

episodeRoutes.get('/episodes', (c) => c.json({ episodes: loadEpisodes() }));

episodeRoutes.post('/episodes', hostOnly, async (c) => {
  const b = await body(c);
  const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM episodes')!.n;
  const code = str(b.code, 20) || `EP${count + 1}`;
  if (get('SELECT 1 FROM episodes WHERE code = ?', code)) throw bad(`赛段编号 ${code} 已存在`);
  const r = run(
    'INSERT INTO episodes(code, name, budget, sort, status, notes) VALUES (?,?,?,?,?,?)',
    code, str(b.name, 50) || code, int(b.budget), count + 1, 'pending', str(b.notes),
  );
  audit(c.get('user'), 'create', 'episode', Number(r.lastInsertRowid), undefined, { code });
  notify('episodes');
  return c.json({ id: Number(r.lastInsertRowid) });
});

episodeRoutes.put('/episodes/:id', hostOnly, async (c) => {
  const id = intParam(c, 'id');
  const before = get('SELECT * FROM episodes WHERE id = ?', id);
  if (!before) throw notFound('赛段不存在');
  const b = await body(c);
  const next = {
    name: b.name === undefined ? before.name : str(b.name, 50) || before.name,
    budget: b.budget === undefined ? before.budget : int(b.budget, before.budget),
    status: ['pending', 'running', 'finished'].includes(b.status) ? b.status : before.status,
    notes: b.notes === undefined ? before.notes : str(b.notes),
    sort: b.sort === undefined ? before.sort : int(b.sort, before.sort),
  };
  run('UPDATE episodes SET name=?, budget=?, status=?, notes=?, sort=? WHERE id=?', next.name, next.budget, next.status, next.notes, next.sort, id);
  audit(c.get('user'), 'update', 'episode', id, before, next);
  notify('episodes');
  return c.json({ ok: true });
});

episodeRoutes.delete('/episodes/:id', hostOnly, (c) => {
  const id = intParam(c, 'id');
  const before = get('SELECT * FROM episodes WHERE id = ?', id);
  if (!before) throw notFound('赛段不存在');
  removeAttachmentFiles(all('SELECT path FROM attachments WHERE leg_id IN (SELECT id FROM legs WHERE episode_id = ?)', id));
  run('DELETE FROM episodes WHERE id = ?', id);
  audit(c.get('user'), 'delete', 'episode', id, before);
  notify('episodes');
  return c.json({ ok: true });
});

function legFields(b: any, before?: any) {
  const pick = (k: string, max = 5000) => (b[k] === undefined ? (before?.[k] ?? '') : str(b[k], max));
  const type = LEG_TYPES.includes(b.type) ? b.type : (before?.type ?? 'TI');
  const typeChanged = !before || before.type !== type;
  const d = TYPE_DEFAULTS[type] ?? { staff: 1, mode: 'full' };
  const needs_staff = b.needs_staff === undefined ? (typeChanged ? d.staff : before.needs_staff) : (b.needs_staff ? 1 : 0);
  const record_mode = ['none', 'single', 'full'].includes(b.record_mode) ? b.record_mode : (typeChanged ? d.mode : before.record_mode);
  return {
    type,
    needs_staff,
    record_mode,
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
  if (!get('SELECT 1 FROM episodes WHERE id = ?', episodeId)) throw notFound('赛段不存在');
  const b = await body(c);
  const f = legFields(b);
  if (!f.name) f.name = '新环节';
  const maxSort = get<{ m: number | null }>('SELECT MAX(sort) AS m FROM legs WHERE episode_id = ?', episodeId)!.m ?? 0;
  const r = run(
    `INSERT INTO legs(episode_id, sort, type, name, description, address, map_url, clue_text, judge_criteria, open_time, close_time, detour_a, detour_b, needs_staff, record_mode)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    episodeId, maxSort + 1, f.type, f.name, f.description, f.address, f.map_url, f.clue_text, f.judge_criteria, f.open_time, f.close_time, f.detour_a, f.detour_b, f.needs_staff, f.record_mode,
  );
  audit(c.get('user'), 'create', 'leg', Number(r.lastInsertRowid), undefined, f);
  notify('episodes', episodeId);
  return c.json({ id: Number(r.lastInsertRowid) });
});

episodeRoutes.put('/legs/:id', hostOnly, async (c) => {
  const id = intParam(c, 'id');
  const before = get('SELECT * FROM legs WHERE id = ?', id);
  if (!before) throw notFound('环节不存在');
  const f = legFields(await body(c), before);
  run(
    `UPDATE legs SET type=?, name=?, description=?, address=?, map_url=?, clue_text=?, judge_criteria=?, open_time=?, close_time=?, detour_a=?, detour_b=?, needs_staff=?, record_mode=? WHERE id=?`,
    f.type, f.name, f.description, f.address, f.map_url, f.clue_text, f.judge_criteria, f.open_time, f.close_time, f.detour_a, f.detour_b, f.needs_staff, f.record_mode, id,
  );
  audit(c.get('user'), 'update', 'leg', id, before, f);
  notify('episodes', before.episode_id);
  return c.json({ ok: true });
});

episodeRoutes.delete('/legs/:id', hostOnly, (c) => {
  const id = intParam(c, 'id');
  const before = get('SELECT * FROM legs WHERE id = ?', id);
  if (!before) throw notFound('环节不存在');
  removeAttachmentFiles(all('SELECT path FROM attachments WHERE leg_id = ?', id));
  run('DELETE FROM legs WHERE id = ?', id);
  audit(c.get('user'), 'delete', 'leg', id, before);
  notify('episodes', before.episode_id);
  return c.json({ ok: true });
});

episodeRoutes.put('/episodes/:id/legs/order', hostOnly, async (c) => {
  const episodeId = intParam(c, 'id');
  const { ids } = await body(c);
  if (!Array.isArray(ids)) throw bad('ids 必须是数组');
  tx(() => {
    ids.forEach((legId: unknown, i: number) => run('UPDATE legs SET sort = ? WHERE id = ? AND episode_id = ?', i + 1, int(legId), episodeId));
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

episodeRoutes.get('/files/:id', (c) => {
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
