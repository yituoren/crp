import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { get, run, now } from '../db.js';
import type { Context } from 'hono';
import { authRequired, issueToken, clearToken, hostAnywhere, signBindTicket, readBindTicket, type AuthUser, type Env } from '../auth.js';
import { audit, body, str, bad } from '../util.js';
import { assertTextOk, fromMiniProgram, SCENE_PROFILE } from '../wxsec.js';

export const authRoutes = new Hono<Env>();

authRoutes.post('/login', async (c) => {
  const { username, password } = await body(c);
  const u = str(username, 50);
  const row = get('SELECT * FROM users WHERE username = ?', u);
  if (!row || !(await bcrypt.compare(String(password ?? ''), row.password_hash))) {
    return c.json({ error: '账号或密码错误' }, 401);
  }
  if (row.disabled) return c.json({ error: '账号已被停用，请联系主办' }, 403);
  const user = { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
  await issueToken(c, user);
  return c.json({ user });
});

/** Create a crew account; returns an error response instead when the input is not acceptable */
async function createAccount(c: Context, b: { username?: unknown; password?: unknown; displayName?: unknown }): Promise<AuthUser | Response> {
  const u = str(b.username, 50);
  const pw = String(b.password ?? '');
  if (!u || !pw) return c.json({ error: '请填写完整信息' }, 400);
  if (pw.length < 4) return c.json({ error: '密码至少 4 位' }, 400);
  if (get('SELECT 1 FROM users WHERE username = ?', u)) {
    return c.json({ error: '该ID已注册，如需重置密码请联系主办或管理员' }, 409);
  }
  const hash = await bcrypt.hash(pw, 10);
  const name = str(b.displayName, 50) || u;
  const r = run('INSERT INTO users(username, password_hash, display_name, role, created_at) VALUES (?,?,?,?,?)', u, hash, name, 'crew', now());
  const user = { id: Number(r.lastInsertRowid), username: u, displayName: name, role: 'crew' as const };
  audit(user, 'register', 'user', user.id, undefined, { username: u });
  return user;
}

/** Registration is open to everyone; events are joined with an invite code */
authRoutes.post('/register', async (c) => {
  const user = await createAccount(c, await body(c));
  if (user instanceof Response) return user;
  await issueToken(c, user);
  return c.json({ user });
});

// ---------- WeChat mini program sign-in ----------
// The mini program's AppID and AppSecret come from the server environment (a systemd drop-in), never from the repository
const WX_APPID = process.env.WX_APPID ?? '';
const WX_SECRET = process.env.WX_SECRET ?? '';
/** Exchange a wx.login code for the user's openid in this mini program */
async function openidOf(code: string): Promise<string> {
  if (!WX_APPID || !WX_SECRET) throw bad('服务器还没有配置小程序登录');
  const q = new URLSearchParams({ appid: WX_APPID, secret: WX_SECRET, js_code: code, grant_type: 'authorization_code' });
  const r = await fetch(`https://api.weixin.qq.com/sns/jscode2session?${q}`);
  const d = await r.json().catch(() => ({})) as { openid?: string; errcode?: number; errmsg?: string };
  if (!d.openid) throw bad(`微信登录失败（${d.errcode ?? r.status}），请重试`);
  return d.openid;
}

/**
 * Mini program sign-in with wx.login's code: a bound WeChat user is signed in at once; otherwise a short-lived ticket
 * comes back and the user binds it to an account (existing ID + password, or a new one) with /wx-bind
 */
authRoutes.post('/wx-login', async (c) => {
  const code = str((await body(c)).code, 200);
  if (!code) return c.json({ error: '缺少登录凭证' }, 400);
  const openid = await openidOf(code);
  const row = get('SELECT * FROM users WHERE wx_openid = ?', openid);
  if (!row) return c.json({ needBind: true, ticket: await signBindTicket(openid) });
  if (row.disabled) return c.json({ error: '账号已被停用，请联系主办' }, 403);
  const user = { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
  return c.json({ user, token: await issueToken(c, user) });
});

/** Bind the WeChat user of a /wx-login ticket to an account: sign in with ID + password, or register one (register: true) */
authRoutes.post('/wx-bind', async (c) => {
  const b = await body(c);
  const openid = await readBindTicket(String(b.ticket ?? ''));
  if (!openid) return c.json({ error: '微信登录已过期，请重新进入小程序' }, 401);
  let user: AuthUser;
  if (b.register) {
    // a new account's ID and name are profile content
    await assertTextOk([str(b.username, 50), str(b.displayName, 50)], openid, SCENE_PROFILE);
    const created = await createAccount(c, b);
    if (created instanceof Response) return created;
    user = created;
  } else {
    const row = get('SELECT * FROM users WHERE username = ?', str(b.username, 50));
    if (!row || !(await bcrypt.compare(String(b.password ?? ''), row.password_hash))) return c.json({ error: '账号或密码错误' }, 401);
    if (row.disabled) return c.json({ error: '账号已被停用，请联系主办' }, 403);
    user = { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
  }
  // one WeChat user per account: the openid moves here, and this account's earlier WeChat binding is replaced
  run('UPDATE users SET wx_openid = NULL WHERE wx_openid = ?', openid);
  run('UPDATE users SET wx_openid = ? WHERE id = ?', openid, user.id);
  audit(user, 'wx_bind', 'user', user.id);
  return c.json({ user, token: await issueToken(c, user) });
});

/** Remove the WeChat binding of the signed-in account (the mini program then asks for ID + password again) */
authRoutes.post('/wx-unbind', authRequired, (c) => {
  const user = c.get('user');
  run('UPDATE users SET wx_openid = NULL WHERE id = ?', user.id);
  audit(user, 'wx_unbind', 'user', user.id);
  return c.json({ ok: true });
});

authRoutes.post('/logout', (c) => {
  clearToken(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', authRequired, (c) => {
  const user = c.get('user');
  const createdAt = get<{ created_at: string }>('SELECT created_at FROM users WHERE id = ?', user.id)?.created_at ?? null;
  const wx = !!get('SELECT 1 FROM users WHERE id = ? AND wx_openid IS NOT NULL', user.id);
  return c.json({ user: { ...user, createdAt, wxBound: wx }, hostAnywhere: user.role === 'admin' || hostAnywhere(user.id), serverTime: now() });
});

/** Rename own crew ID (not allowed for the admin account); the display name follows, operator snapshots in history stay */
authRoutes.put('/profile', authRequired, async (c) => {
  const user = c.get('user');
  if (user.role === 'admin') return c.json({ error: '管理员账号的ID不能修改' }, 403);
  const { username } = await body(c);
  const u = str(username, 50);
  if (!u) return c.json({ error: '请填写新的ID' }, 400);
  if (u === user.username) return c.json({ user });
  if (fromMiniProgram(c)) await assertTextOk([u], get<{ wx_openid: string | null }>('SELECT wx_openid FROM users WHERE id = ?', user.id)?.wx_openid ?? null, SCENE_PROFILE);
  if (get('SELECT 1 FROM users WHERE username = ? AND id != ?', u, user.id)) return c.json({ error: '该ID已被使用' }, 409);
  run('UPDATE users SET username = ?, display_name = ? WHERE id = ?', u, u, user.id);
  audit(user, 'rename', 'user', user.id, { username: user.username }, { username: u });
  return c.json({ user: { ...user, username: u, displayName: u } });
});

authRoutes.post('/change-password', authRequired, async (c) => {
  const user = c.get('user');
  const { oldPassword, newPassword } = await body(c);
  const row = get('SELECT password_hash FROM users WHERE id = ?', user.id)!;
  if (!(await bcrypt.compare(String(oldPassword ?? ''), row.password_hash))) return c.json({ error: '当前密码错误' }, 400);
  const pw = String(newPassword ?? '');
  if (pw.length < 4) return c.json({ error: '新密码至少 4 位' }, 400);
  run('UPDATE users SET password_hash = ? WHERE id = ?', await bcrypt.hash(pw, 10), user.id);
  audit(user, 'change_password', 'user', user.id);
  return c.json({ ok: true });
});
