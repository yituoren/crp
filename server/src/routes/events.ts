import { Hono } from 'hono';
import { all, get, run, tx, now, fromCents } from '../db.js';
import { hostOnly, adminOnly, isMember, joinEvent, loadEvent, roleIn, type Env, type EventRow } from '../auth.js';
import { audit, body, str, int, intParam, bad, notFound, notify, money } from '../util.js';

/** 进比赛之前的接口：比赛列表、加入 */
export const eventListRoutes = new Hono<Env>();

function summary(ev: EventRow, user: { id: number; username: string; role: string }) {
  return { id: ev.id, hash: ev.hash, name: ev.name, joined: isMember(user, ev), role: roleIn(user, ev) };
}

/** 我的比赛 + 公共赛事（全部比赛，未加入的需要邀请码） */
eventListRoutes.get('/events', (c) => {
  const user = c.get('user');
  const rows = all<EventRow>('SELECT * FROM events ORDER BY id').map((ev) => summary(ev, user));
  return c.json({ mine: rows.filter((r) => r.joined), all: rows });
});

/** 输入邀请码加入 */
eventListRoutes.post('/events/join', async (c) => {
  const user = c.get('user');
  const b = await body(c);
  const code = str(b.code, 50);
  if (!code) throw bad('请输入邀请码');
  const ev = get<EventRow>('SELECT * FROM events WHERE invite_code = ? AND invite_code != \'\'', code);
  if (!ev) throw bad('邀请码不正确');
  if (b.hash && ev.hash !== String(b.hash)) throw bad('邀请码与这个比赛不匹配');
  joinEvent(user.id, ev.id);
  audit(user, 'join', 'event', ev.id, undefined, { hash: ev.hash });
  return c.json({ event: summary(ev, user) });
});

/** 比赛内：比赛信息与设置 */
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
    inviteCode: role === 'crew' ? undefined : ev.invite_code, // 邀请码只给主办看
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

// ---------- 商店（货币模式）：商品与价格由主办在赛事设置里维护 ----------
export function listShopItems(eventId: number) {
  return all<{ id: number; name: string; price: number; sort: number }>('SELECT id, name, price, sort FROM shop_items WHERE event_id = ? ORDER BY sort, id', eventId).map((i) => ({ ...i, price: fromCents(i.price) }));
}
eventInfoRoutes.get('/shop/items', (c) => c.json({ items: listShopItems(c.get('event').id) }));
/** 整体保存商品列表：有 id 的更新，没有的新增，列表里没有的删除（流水里存了物品名快照，删除不影响历史） */
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

/** 比赛成员（排班用）：已加入的人 + 创建者 + 管理员 */
eventInfoRoutes.get('/members', (c) => {
  const ev = c.get('event');
  const users = all<{ id: number; username: string; displayName: string; role: string; disabled: number }>('SELECT id, username, display_name AS displayName, role, disabled FROM users ORDER BY username')
    .filter((u) => u.role === 'admin' || (ev.owner_id && ev.owner_id === u.id) || get('SELECT 1 FROM event_members WHERE event_id = ? AND user_id = ?', ev.id, u.id))
    .map((u) => ({ ...u, role: roleIn(u, ev) }))
    .sort((a, b) => (a.role === b.role ? a.username.localeCompare(b.username) : a.role === 'admin' ? -1 : b.role === 'admin' ? 1 : a.role === 'host' ? -1 : 1));
  return c.json({ users });
});

/** 设置 / 取消主办：主办可操作；管理员和创建者的身份固定，不能改自己 */
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

/** 本比赛的操作日志（管理员） */
eventInfoRoutes.get('/audit', adminOnly, (c) => {
  const ev = c.get('event');
  const limit = Math.min(int(c.req.query('limit'), 200) || 200, 1000);
  const offset = int(c.req.query('offset'), 0);
  return c.json({
    logs: all('SELECT * FROM audit_logs WHERE event_id = ? ORDER BY id DESC LIMIT ? OFFSET ?', ev.id, limit, offset),
    total: get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_logs WHERE event_id = ?', ev.id)!.n,
  });
});

