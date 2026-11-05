import { Hono } from 'hono';
import { all, get, run, now } from '../db.js';
import { hostOnly, isHostRole, type Env } from '../auth.js';

/** Audiences: all = every crew member; hosts = hosts only (crew messages to the hosts); follow:<episodeId>:<teamId> = system departure notice */
import { audit, body, str, int, intParam, notify, bad } from '../util.js';

export const announcementRoutes = new Hono<Env>();

announcementRoutes.get('/announcements', (c) => {
  const ev = c.get('event');
  const me = get('SELECT last_read_id FROM ann_reads WHERE user_id = ? AND event_id = ?', c.get('user').id, ev.id);
  // Hosts see everything; others see "all", their own posts, and departure notices for the team they follow in that episode
  const uid = Number(c.get('user').id);
  const visible = isHostRole(c.get('user').role) ? '1' : `(audience = 'all' OR author_id = ${uid} OR EXISTS (SELECT 1 FROM assignments s WHERE s.user_id = ${uid} AND s.role = 'follow' AND announcements.audience = 'follow:' || s.episode_id || ':' || s.team_id))`;
  // pinned first (newest pin first), then by publish time descending
  return c.json({
    announcements: all(`SELECT * FROM announcements WHERE event_id = ? AND ${visible} ORDER BY (pinned_at IS NULL), pinned_at DESC, id DESC LIMIT 200`, ev.id),
    lastReadId: me?.last_read_id ?? 0,
  });
});

/** Mark announcements read up to an id (stored per account + event, so it follows the user across devices) */
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

/** Hosts post to everyone or to the hosts only; every other member posts to the hosts */
announcementRoutes.post('/announcements', async (c) => {
  const b = await body(c);
  const content = str(b.content, 2000);
  if (!content) throw bad('内容不能为空');
  const level = ['info', 'warning', 'urgent'].includes(b.level) ? b.level : 'info';
  const audience = isHostRole(c.get('user').role) && b.audience !== 'hosts' ? 'all' : 'hosts';
  const r = run(
    'INSERT INTO announcements(content, level, created_by, created_at, audience, event_id, author_id) VALUES (?,?,?,?,?,?,?)',
    content, level, c.get('user').displayName, now(), audience, c.get('event').id, c.get('user').id,
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

/** Pin / unpin */
announcementRoutes.post('/announcements/:id/pin', hostOnly, async (c) => {
  const id = intParam(c, 'id');
  own(c, id);
  const { pinned } = await body(c);
  run('UPDATE announcements SET pinned_at = ? WHERE id = ?', pinned ? now() : null, id);
  audit(c.get('user'), pinned ? 'pin' : 'unpin', 'announcement', id);
  notify('announcements');
  return c.json({ ok: true });
});

/** Hosts delete any announcement; others only their own */
announcementRoutes.delete('/announcements/:id', (c) => {
  const id = intParam(c, 'id');
  const a = own(c, id);
  if (!isHostRole(c.get('user').role) && a.author_id !== c.get('user').id) throw bad('只能删除自己发的公告');
  run('DELETE FROM announcements WHERE id = ?', id);
  audit(c.get('user'), 'delete', 'announcement', id);
  notify('announcements');
  return c.json({ ok: true });
});
