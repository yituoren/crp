import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { all, get, run, now, getSetting, fromCents } from '../db.js';
import { authRequired, issueToken, clearToken, type Env } from '../auth.js';
import { audit, body, str } from '../util.js';

export const authRoutes = new Hono<Env>();

function hostNames(): string[] {
  return getSetting('hosts', '').split(',').map((s) => s.trim()).filter(Boolean);
}

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

authRoutes.post('/register', async (c) => {
  const { username, password, displayName } = await body(c);
  const u = str(username, 50);
  const pw = String(password ?? '');
  if (!u || !pw) return c.json({ error: '请填写完整信息' }, 400);
  if (pw.length < 4) return c.json({ error: '密码至少 4 位' }, 400);
  if (!get('SELECT 1 FROM access_list WHERE username = ?', u)) {
    return c.json({ error: '你的ID不在主办准入名单中，请联系主办添加' }, 403);
  }
  if (get('SELECT 1 FROM users WHERE username = ?', u)) {
    return c.json({ error: '该ID已注册，如需重置密码请联系主办' }, 409);
  }
  const role = hostNames().includes(u) ? 'host' : 'crew';
  const hash = await bcrypt.hash(pw, 10);
  const r = run(
    'INSERT INTO users(username, password_hash, display_name, role, created_at) VALUES (?,?,?,?,?)',
    u, hash, str(displayName, 50) || u, role, now(),
  );
  const user = { id: Number(r.lastInsertRowid), username: u, displayName: str(displayName, 50) || u, role: role as 'host' | 'crew' };
  audit(user, 'register', 'user', user.id, undefined, { username: u, role });
  await issueToken(c, user);
  return c.json({ user });
});

authRoutes.post('/logout', (c) => {
  clearToken(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', authRequired, (c) => {
  return c.json({
    user: c.get('user'),
    event: {
      name: getSetting('event_name', '城市飞奔'),
      initialCurrency: fromCents(Number(getSetting('initial_currency', '100000'))),
      hosts: hostNames(),
    },
    serverTime: now(),
  });
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

/** 所有幕后（供排班等页面使用） */
authRoutes.get('/users', authRequired, (c) => {
  return c.json({
    users: all('SELECT id, username, display_name AS displayName, role, disabled FROM users ORDER BY role DESC, username'),
  });
});
