import { Hono, type MiddlewareHandler } from 'hono';
import bcrypt from 'bcryptjs';
import { all, get, run, tx, now, db } from '../db.js';
import { adminOnly, type Env } from '../auth.js';
import { audit, body, str, int, intParam, notify, bad, notFound } from '../util.js';
import { seed } from '../seed.js';

/** Account management (list, disable, reset password, delete) is admin only; everyone else can only change their own password */
const accountManager: MiddlewareHandler<Env> = adminOnly;

// ================= Before entering an event: account management =================
export const userRoutes = new Hono<Env>();
userRoutes.use('/users/*', accountManager);
userRoutes.use('/users', accountManager);

userRoutes.get('/users', (c) =>
  c.json({ users: all('SELECT id, username, display_name AS displayName, role, disabled, created_at FROM users ORDER BY role DESC, username') }),
);
userRoutes.put('/users/:id', async (c) => {
  const id = intParam(c, 'id');
  const before = get('SELECT id, username, display_name, role, disabled FROM users WHERE id = ?', id);
  if (!before) throw notFound('账号不存在');
  const me = c.get('user');
  const b = await body(c);
  if (before.role === 'admin' && me.role !== 'admin') throw bad('管理员账号只能由管理员修改');
  const disabled = b.disabled === undefined ? before.disabled : b.disabled ? 1 : 0;
  let username = before.username;
  if (b.username !== undefined) {
    if (before.role === 'admin') throw bad('管理员账号的ID不能修改');
    username = str(b.username, 50);
    if (!username) throw bad('请填写新的ID');
    if (get('SELECT 1 FROM users WHERE username = ? AND id != ?', username, id)) throw bad('该ID已被使用');
  }
  const displayName = b.username !== undefined ? username : b.displayName === undefined ? before.display_name : str(b.displayName, 50) || before.display_name;
  if (id === me.id && disabled) throw bad('不能停用自己');
  run('UPDATE users SET disabled = ?, username = ?, display_name = ? WHERE id = ?', disabled, username, displayName, id);
  audit(me, 'update', 'user', id, before, { disabled, username, displayName });
  notify('admin');
  return c.json({ ok: true });
});
userRoutes.post('/users/:id/reset-password', async (c) => {
  const id = intParam(c, 'id');
  const target = get('SELECT role FROM users WHERE id = ?', id);
  if (!target) throw notFound('账号不存在');
  if (target.role === 'admin' && c.get('user').role !== 'admin') throw bad('管理员密码只能由管理员重置');
  const { password } = await body(c);
  const pw = String(password ?? '');
  if (pw.length < 4) throw bad('密码至少 4 位');
  run('UPDATE users SET password_hash = ? WHERE id = ?', await bcrypt.hash(pw, 10), id);
  audit(c.get('user'), 'reset_password', 'user', id);
  return c.json({ ok: true });
});
userRoutes.delete('/users/:id', (c) => {
  const id = intParam(c, 'id');
  if (id === c.get('user').id) throw bad('不能删除自己');
  const before = get('SELECT id, username, role FROM users WHERE id = ?', id);
  if (!before) throw notFound('账号不存在');
  if (before.role === 'admin' && c.get('user').role !== 'admin') throw bad('管理员账号只能由管理员删除');
  run('DELETE FROM users WHERE id = ?', id);
  audit(c.get('user'), 'delete', 'user', id, before);
  notify('admin');
  return c.json({ ok: true });
});

// ================= Before entering an event: system level (admin): audit log, backup, restore, reset =================
export const systemRoutes = new Hono<Env>();
systemRoutes.use('/system/*', adminOnly);

systemRoutes.get('/system/audit', (c) => {
  const limit = Math.min(int(c.req.query('limit'), 200) || 200, 1000);
  const offset = int(c.req.query('offset'), 0);
  return c.json({ logs: all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?', limit, offset), total: get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_logs')!.n });
});

const TABLES = ['settings', 'users', 'events', 'event_members', 'ann_reads', 'episodes', 'legs', 'attachments', 'teams', 'assignments', 'progress', 'penalties', 'pitstop_results', 'currency_ledger', 'announcements', 'audit_logs'];

systemRoutes.get('/system/export', (c) => {
  const dump: Record<string, unknown> = { format: 'crp-v2', exportedAt: now() };
  for (const t of TABLES) dump[t] = all(`SELECT * FROM ${t}`);
  audit(c.get('user'), 'export', 'database');
  c.header('Content-Disposition', `attachment; filename="crp_backup_${now().slice(0, 19).replace(/[:T]/g, '-')}.json"`);
  return c.json(dump);
});

systemRoutes.post('/system/import', async (c) => {
  const data = await body(c);
  if (data.format !== 'crp-v1' && data.format !== 'crp-v2') throw bad('不是本系统导出的备份文件（缺少 format: crp-v1 / crp-v2）');
  const me = c.get('user');
  tx(() => {
    db.exec('PRAGMA foreign_keys = OFF');
    for (const t of [...TABLES].reverse()) run(`DELETE FROM ${t}`);
    for (const t of TABLES) {
      const rows = Array.isArray(data[t]) ? data[t] : [];
      for (const row of rows) {
        const cols = Object.keys(row).filter((k) => k !== 'ann_read_id');
        run(`INSERT INTO ${t}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((k) => (row[k] === undefined ? null : row[k])));
      }
    }
    db.exec('PRAGMA foreign_keys = ON');
  });
  seed(); // v1 backups have no events table: seed rebuilds event 1 from the old settings
  audit(me, 'import', 'database', '', undefined, { exportedAt: data.exportedAt, format: data.format });
  notify('admin'); notify('episodes'); notify('teams');
  return c.json({ ok: true });
});

systemRoutes.post('/system/reset', async (c) => {
  const b = await body(c);
  const includeAccounts = !!b.includeAccounts;
  const me = c.get('user');
  tx(() => {
    for (const t of ['pitstop_results', 'penalties', 'progress', 'currency_ledger', 'assignments', 'attachments', 'legs', 'episodes', 'teams', 'announcements', 'ann_reads']) run(`DELETE FROM ${t}`);
    if (includeAccounts) {
      run("DELETE FROM users WHERE role != 'admin'"); // keep admin accounts only
      run('DELETE FROM event_members');
    }
  });
  seed();
  audit(me, 'reset', 'database', '', undefined, { includeAccounts });
  notify('admin'); notify('episodes'); notify('teams');
  return c.json({ ok: true });
});

/** The in-event backstage has no routes of its own yet: settings use /events/:hash/info, logs use /events/:hash/audit */
export const adminRoutes = new Hono<Env>();
