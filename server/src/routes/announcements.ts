import { Hono } from 'hono';
import { all, get, run, now } from '../db.js';
import { hostOnly, type Env } from '../auth.js';
import { audit, body, str, int, intParam, notify, bad } from '../util.js';

export const announcementRoutes = new Hono<Env>();

announcementRoutes.get('/announcements', (c) => {
  const ev = c.get('event');
  const me = get('SELECT last_read_id FROM ann_reads WHERE user_id = ? AND event_id = ?', c.get('user').id, ev.id);
  // 置顶的在前（按置顶时间倒序），其余按发布时间倒序
  return c.json({
    announcements: all('SELECT * FROM announcements WHERE event_id = ? ORDER BY (pinned_at IS NULL), pinned_at DESC, id DESC LIMIT 200', ev.id),
    lastReadId: me?.last_read_id ?? 0,
  });
});

/** 标记已读到某条公告（按账号 + 比赛存，换设备也生效） */
announcementRoutes.post('/announcements/read', async (c) => {
  const { id } = await body(c);
  const n = int(id, 0);
  run(
    `INSERT INTO ann_reads(user_id, event_id, last_read_id) VALUES (?,?,?)
     ON CONFLICT(user_id, event_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
    c.get('user').id, c.get('event').id, n,
  );
  return c.json({ ok: true });
});

announcementRoutes.post('/announcements', hostOnly, async (c) => {
  const b = await body(c);
  const content = str(b.content, 2000);
  if (!content) throw bad('内容不能为空');
  const level = ['info', 'warning', 'urgent'].includes(b.level) ? b.level : 'info';
  const audience = str(b.audience, 50) || 'all'; // 通知对象：预留，暂只支持 all
  const r = run(
    'INSERT INTO announcements(content, level, created_by, created_at, audience, event_id) VALUES (?,?,?,?,?,?)',
    content, level, c.get('user').displayName, now(), audience, c.get('event').id,
  );
  audit(c.get('user'), 'create', 'announcement', Number(r.lastInsertRowid), undefined, { content, level });
  notify('announcements');
  return c.json({ id: Number(r.lastInsertRowid) });
});

function own(c: any, id: number) {
  const a = get('SELECT * FROM announcements WHERE id = ?', id);
  if (!a || a.event_id !== c.get('event').id) throw bad('公告不存在');
  return a;
}

/** 置顶 / 取消置顶 */
announcementRoutes.post('/announcements/:id/pin', hostOnly, async (c) => {
  const id = intParam(c, 'id');
  own(c, id);
  const { pinned } = await body(c);
  run('UPDATE announcements SET pinned_at = ? WHERE id = ?', pinned ? now() : null, id);
  audit(c.get('user'), pinned ? 'pin' : 'unpin', 'announcement', id);
  notify('announcements');
  return c.json({ ok: true });
});

announcementRoutes.delete('/announcements/:id', hostOnly, (c) => {
  const id = intParam(c, 'id');
  own(c, id);
  run('DELETE FROM announcements WHERE id = ?', id);
  audit(c.get('user'), 'delete', 'announcement', id);
  notify('announcements');
  return c.json({ ok: true });
});
