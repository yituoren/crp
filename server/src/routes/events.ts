import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { all, get, run, tx, now, fromCents, UPLOAD_DIR } from '../db.js';
import { hostOnly, adminOnly, isMember, joinEvent, loadEvent, roleIn, type Env, type EventRow } from '../auth.js';
import { exportEvent, importEvent, parseEventFile } from '../eventTransfer.js';
import { audit, body, str, int, intParam, bad, notFound, notify, notifyEventDeleted, money } from '../util.js';

/** Routes used before entering an event: list and join */
export const eventListRoutes = new Hono<Env>();

/** Overall event status: any running episode = running; all finished = finished; otherwise pending */
function eventStatus(eventId: number): 'pending' | 'running' | 'finished' {
  const eps = all<{ status: string }>('SELECT status FROM episodes WHERE event_id = ?', eventId);
  if (eps.some((e) => e.status === 'running')) return 'running';
  if (eps.length && eps.every((e) => e.status === 'finished')) return 'finished';
  return 'pending';
}

function summary(ev: EventRow, user: { id: number; username: string; role: string }) {
  const owner = ev.owner_id ? get<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', ev.owner_id) : null;
  const memberCount = get<{ n: number }>('SELECT COUNT(*) AS n FROM event_members WHERE event_id = ?', ev.id)!.n;
  const episodeCount = get<{ n: number }>('SELECT COUNT(*) AS n FROM episodes WHERE event_id = ?', ev.id)!.n;
  const pending = !!get("SELECT 1 FROM event_join_requests WHERE event_id = ? AND user_id = ? AND status = 'pending'", ev.id, user.id);
  return {
    id: ev.id, hash: ev.hash, name: ev.name, joined: isMember(user, ev), role: roleIn(user, ev), pending,
    ownerName: owner?.display_name ?? '', memberCount, episodeCount, status: eventStatus(ev.id), createdAt: ev.created_at,
  };
}

/** My events + all events (events not joined need an invite code) */
eventListRoutes.get('/events', (c) => {
  const user = c.get('user');
  const rows = all<EventRow>('SELECT * FROM events ORDER BY id DESC').map((ev) => summary(ev, user));
  return c.json({ mine: rows.filter((r) => r.joined), all: rows });
});

const randomHash = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomCode = () => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => a[b % a.length]).join(''); };

/** Create an event: any signed-in user; the creator becomes its host */
eventListRoutes.post('/events', async (c) => {
  const user = c.get('user');
  const b = await body(c);
  const name = str(b.name, 50);
  if (!name) throw bad('请填写赛事名称');
  let inviteCode = str(b.inviteCode, 50);
  if (inviteCode && get('SELECT 1 FROM events WHERE invite_code = ?', inviteCode)) throw bad('这个邀请码已被其他比赛使用');
  while (!inviteCode || get('SELECT 1 FROM events WHERE invite_code = ?', inviteCode)) inviteCode = randomCode();
  const teamSize = b.teamSize === undefined ? 2 : int(b.teamSize, 0);
  if (teamSize < 1 || teamSize > 20) throw bad('每队人数必须是 1 到 20 的整数');
  const currencyMode = b.currencyMode === undefined ? 'yuan' : b.currencyMode;
  if (!['yuan', 'coin'].includes(currencyMode)) throw bad('经费类型只能是 yuan 或 coin');
  let hash = randomHash();
  while (get('SELECT 1 FROM events WHERE hash = ?', hash)) hash = randomHash();
  const id = tx(() => {
    const r = run('INSERT INTO events(hash, name, invite_code, hosts, team_size, currency_mode, rb_gap, owner_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      hash, name, inviteCode, '', teamSize, currencyMode, 2, user.id, now());
    const newId = Number(r.lastInsertRowid);
    joinEvent(user.id, newId, 'host');
    return newId;
  });
  const ev = loadEvent(hash)!;
  audit(user, 'create', 'event', id, undefined, { hash, name, inviteCode, teamSize, currencyMode });
  return c.json({ event: summary(ev, user) });
});

/** Import an event file exported by this system as a new event; any signed-in user, who becomes its host */
const MAX_EVENT_FILE = 200 * 1024 * 1024;
eventListRoutes.post('/events/import', async (c) => {
  const user = c.get('user');
  const form = await c.req.parseBody();
  const file = form['file'];
  if (!(file instanceof File)) throw bad('请选择比赛文件');
  if (file.size > MAX_EVENT_FILE) throw bad('文件过大');
  const dump = parseEventFile(Buffer.from(await file.arrayBuffer()));
  const { id, hash, skippedUsers } = importEvent(dump, user);
  const ev = loadEvent(hash)!;
  audit(user, 'import', 'event', id, undefined, { hash, name: ev.name, from: dump.event?.hash, exportedAt: dump.exportedAt, skippedUsers });
  notify('admin');
  return c.json({ event: summary(ev, user), skippedUsers });
});

/** Apply with the invite code (optional note); membership starts once a host / admin approves */
eventListRoutes.post('/events/join', async (c) => {
  const user = c.get('user');
  const b = await body(c);
  const code = str(b.code, 50);
  if (!code) throw bad('请输入邀请码');
  const ev = get<EventRow>('SELECT * FROM events WHERE invite_code = ? AND invite_code != \'\'', code);
  if (!ev) throw bad('邀请码不正确');
  if (b.hash && ev.hash !== String(b.hash)) throw bad('邀请码与这个比赛不匹配');
  if (isMember(user, ev)) throw bad('你已经是这个比赛的成员');
  if (get("SELECT 1 FROM event_join_requests WHERE event_id = ? AND user_id = ? AND status = 'pending'", ev.id, user.id)) throw bad('已提交过申请，请等待主办审核');
  run('INSERT INTO event_join_requests(event_id, user_id, note, status, created_at) VALUES (?,?,?,?,?)', ev.id, user.id, str(b.note, 200), 'pending', now());
  audit(user, 'join_request', 'event', ev.id, undefined, { hash: ev.hash, note: str(b.note, 200) });
  notify('admin');
  return c.json({ event: summary(ev, user) });
});

/** Inside an event: info and settings */
export const eventInfoRoutes = new Hono<Env>();

function info(ev: EventRow, user: { id: number; username: string; role: string }) {
  const role = roleIn(user, ev);
  return {
    id: ev.id,
    hash: ev.hash,
    name: ev.name,
    teamSize: Math.max(1, ev.team_size || 1),
    currencyMode: ev.currency_mode === 'coin' ? 'coin' : 'yuan',
    rbGap: Math.max(0, ev.rb_gap ?? 2),
    inviteCode: role === 'crew' ? undefined : ev.invite_code, // invite code is only shown to hosts
    ownerId: ev.owner_id ?? null,
    myRole: role,
  };
}

eventInfoRoutes.get('/info', (c) => c.json({ event: info(c.get('event'), c.get('user')) }));

eventInfoRoutes.put('/info', hostOnly, async (c) => {
  const ev = c.get('event');
  const b = await body(c);
  const next = {
    name: b.name === undefined ? ev.name : str(b.name, 50) || ev.name,
    invite_code: b.inviteCode === undefined ? ev.invite_code : str(b.inviteCode, 50),
    team_size: ev.team_size,
    currency_mode: ev.currency_mode,
    rb_gap: ev.rb_gap,
  };
  if (b.currencyMode !== undefined) { if (!['yuan', 'coin'].includes(b.currencyMode)) throw bad('经费类型只能是 yuan 或 coin'); next.currency_mode = b.currencyMode; }
  if (b.teamSize !== undefined) { const n = int(b.teamSize, 0); if (n < 1 || n > 20) throw bad('每队人数必须是 1 到 20 的整数'); next.team_size = n; }
  if (b.rbGap !== undefined) { const n = int(b.rbGap, -1); if (n < 0 || n > 99) throw bad('路障次数差必须是 0 到 99 的整数'); next.rb_gap = n; }
  if (next.invite_code && get('SELECT 1 FROM events WHERE invite_code = ? AND id != ?', next.invite_code, ev.id)) throw bad('这个邀请码已被其他比赛使用');
  run('UPDATE events SET name = ?, invite_code = ?, team_size = ?, currency_mode = ?, rb_gap = ? WHERE id = ?',
    next.name, next.invite_code, next.team_size, next.currency_mode, next.rb_gap, ev.id);
  audit(c.get('user'), 'update', 'event', ev.id, { name: ev.name, team_size: ev.team_size, currency_mode: ev.currency_mode, rb_gap: ev.rb_gap }, next);
  notify('admin');
  return c.json({ event: info(loadEvent(ev.hash)!, c.get('user')) });
});

// ---------- Shop (coin mode): items and prices are maintained by hosts in the event settings ----------
export function listShopItems(eventId: number) {
  return all<{ id: number; name: string; price: number; sort: number }>('SELECT id, name, price, sort FROM shop_items WHERE event_id = ? ORDER BY sort, id', eventId).map((i) => ({ ...i, price: fromCents(i.price) }));
}
eventInfoRoutes.get('/shop/items', (c) => c.json({ items: listShopItems(c.get('event').id) }));
/** Save the shop items as a whole: rows with an id are updated, others inserted, missing ones deleted (ledger rows keep a name snapshot, so history survives) */
eventInfoRoutes.put('/shop/items', hostOnly, async (c) => {
  const ev = c.get('event');
  const b = await body(c);
  if (!Array.isArray(b.items)) throw bad('items 必须是数组');
  const items = b.items.map((it: any, i: number) => ({ id: int(it.id, 0) || 0, name: str(it.name, 50), price: money(it.price, '价格'), sort: i }));
  for (const it of items) { if (!it.name) throw bad('商品名称不能为空'); if (it.price <= 0) throw bad(`「${it.name}」的价格必须大于 0`); }
  const before = listShopItems(ev.id);
  tx(() => {
    const keep = new Set<number>();
    for (const it of items) {
      if (it.id && get('SELECT 1 FROM shop_items WHERE id = ? AND event_id = ?', it.id, ev.id)) {
        run('UPDATE shop_items SET name = ?, price = ?, sort = ? WHERE id = ?', it.name, it.price, it.sort, it.id);
        keep.add(it.id);
      } else {
        const r = run('INSERT INTO shop_items(event_id, name, price, sort, created_at) VALUES (?,?,?,?,?)', ev.id, it.name, it.price, it.sort, now());
        keep.add(Number(r.lastInsertRowid));
      }
    }
    for (const old of before) if (!keep.has(old.id)) run('DELETE FROM shop_items WHERE id = ?', old.id);
  });
  audit(c.get('user'), 'update', 'shop_items', ev.id, before, items);
  notify('admin');
  return c.json({ items: listShopItems(ev.id) });
});

/** Event members (for scheduling): joined users + creator + admins */
eventInfoRoutes.get('/members', (c) => {
  const ev = c.get('event');
  const users = all<{ id: number; username: string; displayName: string; role: string; disabled: number }>('SELECT id, username, display_name AS displayName, role, disabled FROM users ORDER BY username')
    .filter((u) => u.role === 'admin' || (ev.owner_id && ev.owner_id === u.id) || get('SELECT 1 FROM event_members WHERE event_id = ? AND user_id = ?', ev.id, u.id))
    .map((u) => ({ ...u, role: roleIn(u, ev) }))
    .sort((a, b) => (a.role === b.role ? a.username.localeCompare(b.username) : a.role === 'admin' ? -1 : b.role === 'admin' ? 1 : a.role === 'host' ? -1 : 1));
  return c.json({ users });
});

/** Grant / revoke host: hosts may do it; admins and the creator are fixed, and nobody changes themselves */
/** Join requests awaiting review */
eventInfoRoutes.get('/join-requests', hostOnly, (c) => {
  const ev = c.get('event');
  const requests = all(
    `SELECT r.id, r.user_id, u.username, r.note, r.created_at FROM event_join_requests r JOIN users u ON u.id = r.user_id
     WHERE r.event_id = ? AND r.status = 'pending' ORDER BY r.created_at, r.id`, ev.id,
  );
  return c.json({ requests });
});
function decideRequest(c: any, status: 'approved' | 'rejected') {
  const ev = c.get('event');
  const id = intParam(c, 'id');
  const r = get('SELECT * FROM event_join_requests WHERE id = ? AND event_id = ?', id, ev.id);
  if (!r) throw notFound('申请不存在');
  if (r.status !== 'pending') throw bad('该申请已经处理过');
  const me = c.get('user');
  tx(() => {
    run('UPDATE event_join_requests SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?', status, now(), me.id, id);
    if (status === 'approved') joinEvent(r.user_id, ev.id);
  });
  audit(me, status === 'approved' ? 'approve_join' : 'reject_join', 'event', ev.id, undefined, { userId: r.user_id });
  notify('admin');
  return c.json({ ok: true });
}
eventInfoRoutes.post('/join-requests/:id/approve', hostOnly, (c) => decideRequest(c, 'approved'));
eventInfoRoutes.post('/join-requests/:id/reject', hostOnly, (c) => decideRequest(c, 'rejected'));

eventInfoRoutes.put('/members/:userId', hostOnly, async (c) => {
  const ev = c.get('event');
  const me = c.get('user');
  const userId = intParam(c, 'userId');
  const b = await body(c);
  const role = b.role === 'host' ? 'host' : b.role === 'crew' ? 'crew' : null;
  if (!role) throw bad('角色只能是 host 或 crew');
  const target = get<{ id: number; username: string; role: string }>('SELECT id, username, role FROM users WHERE id = ?', userId);
  if (!target) throw notFound('账号不存在');
  if (target.role === 'admin') throw bad('管理员是全局角色，不在比赛里设置');
  if (ev.owner_id && ev.owner_id === userId) throw bad('创建者固定为主办');
  if (userId === me.id) throw bad('不能修改自己的主办身份');
  if (!get('SELECT 1 FROM event_members WHERE event_id = ? AND user_id = ?', ev.id, userId)) throw bad('该账号还没有加入本比赛');
  run('UPDATE event_members SET role = ? WHERE event_id = ? AND user_id = ?', role, ev.id, userId);
  audit(me, role === 'host' ? 'set_host' : 'unset_host', 'event_member', userId, undefined, { username: target.username, role });
  notify('admin');
  return c.json({ ok: true });
});

/** Download the whole event as a file that can be imported on any server (hosts and admin) */
eventInfoRoutes.get('/export', hostOnly, (c) => {
  const ev = c.get('event');
  const buf = exportEvent(ev.id);
  audit(c.get('user'), 'export', 'event', ev.id, undefined, { name: ev.name, size: buf.length });
  const stamp = now().slice(0, 10);
  const filename = `${ev.name}_${stamp}.crp`;
  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="event_${stamp}.crp"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    },
  });
});

/** This event's audit log (admin) */
eventInfoRoutes.get('/audit', adminOnly, (c) => {
  const ev = c.get('event');
  const limit = Math.min(int(c.req.query('limit'), 200) || 200, 1000);
  const offset = int(c.req.query('offset'), 0);
  return c.json({
    logs: all('SELECT * FROM audit_logs WHERE event_id = ? ORDER BY id DESC LIMIT ? OFFSET ?', ev.id, limit, offset),
    total: get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_logs WHERE event_id = ?', ev.id)!.n,
  });
});


/**
 * Delete the whole event (hosts and admin). The body must repeat the event name as a confirmation.
 * Removes episodes (with legs, attachments, cutoffs, progress, penalties, pit stop results, assignments),
 * teams (with ledger, item log, cutoff uses), announcements, shop items, members and join requests,
 * plus the uploaded attachment files. Accounts are kept; audit rows stay for the system-wide log.
 */
eventInfoRoutes.delete('/', hostOnly, async (c) => {
  const ev = c.get('event');
  const b = await body(c);
  if (String(b.name ?? '').trim() !== ev.name) throw bad('比赛名称不一致，未删除');
  const files = all<{ path: string }>(
    'SELECT a.path FROM attachments a JOIN legs l ON l.id = a.leg_id JOIN episodes e ON e.id = l.episode_id WHERE e.event_id = ?', ev.id,
  ).map((r) => r.path);
  const counts = {
    episodes: get<{ n: number }>('SELECT COUNT(*) AS n FROM episodes WHERE event_id = ?', ev.id)!.n,
    teams: get<{ n: number }>('SELECT COUNT(*) AS n FROM teams WHERE event_id = ?', ev.id)!.n,
    attachments: files.length,
  };
  tx(() => {
    run('DELETE FROM cutoff_uses WHERE episode_id IN (SELECT id FROM episodes WHERE event_id = ?)', ev.id);
    run('DELETE FROM currency_ledger WHERE team_id IN (SELECT id FROM teams WHERE event_id = ?)', ev.id);
    run('DELETE FROM item_log WHERE team_id IN (SELECT id FROM teams WHERE event_id = ?)', ev.id);
    run('DELETE FROM episodes WHERE event_id = ?', ev.id); // cascades to legs and everything hanging off episodes / legs
    run('DELETE FROM teams WHERE event_id = ?', ev.id);
    run('DELETE FROM announcements WHERE event_id = ?', ev.id);
    run('DELETE FROM shop_items WHERE event_id = ?', ev.id);
    run('DELETE FROM events WHERE id = ?', ev.id); // cascades to members, join requests, announcement read marks
    audit(c.get('user'), 'delete', 'event', ev.id, { name: ev.name, hash: ev.hash, ...counts });
  });
  for (const f of files) { try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); } catch { /* already gone */ } }
  notifyEventDeleted(ev.hash);
  return c.json({ ok: true });
});
