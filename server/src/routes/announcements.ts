import { Hono } from 'hono';
import { all, get, run, now } from '../db.js';
import { hostOnly, type Env } from '../auth.js';
import { audit, body, str, int, intParam, notify, bad } from '../util.js';

export const announcementRoutes = new Hono<Env>();

announcementRoutes.get('/announcements', (c) => {
  const me = get('SELECT ann_read_id FROM users WHERE id = ?', c.get('user').id);
  return c.json({ announcements: all('SELECT * FROM announcements ORDER BY id DESC LIMIT 200'), lastReadId: me?.ann_read_id ?? 0 });
});

/** 标记已读到某条公告（存在账号上，换设备也生效） */
announcementRoutes.post('/announcements/read', async (c) => {
  const { id } = await body(c);
  const n = int(id, 0);
  run('UPDATE users SET ann_read_id = MAX(ann_read_id, ?) WHERE id = ?', n, c.get('user').id);
  return c.json({ ok: true });
});

announcementRoutes.post('/announcements', hostOnly, async (c) => {
  const b = await body(c);
  const content = str(b.content, 2000);
  if (!content) throw bad('内容不能为空');
  const level = ['info', 'warning', 'urgent'].includes(b.level) ? b.level : 'info';
  const r = run(
    'INSERT INTO announcements(content, level, created_by, created_at) VALUES (?,?,?,?)',
    content, level, c.get('user').displayName, now(),
  );
  audit(c.get('user'), 'create', 'announcement', Number(r.lastInsertRowid), undefined, { content, level });
  notify('announcements');
  return c.json({ id: Number(r.lastInsertRowid) });
});

announcementRoutes.delete('/announcements/:id', hostOnly, (c) => {
  const id = intParam(c, 'id');
  run('DELETE FROM announcements WHERE id = ?', id);
  audit(c.get('user'), 'delete', 'announcement', id);
  notify('announcements');
  return c.json({ ok: true });
});
