import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { all, get, run, tx, now, getSetting, setSetting, db } from '../db.js';
import { hostOnly, adminOnly, type Env } from '../auth.js';
import { audit, body, str, int, intParam, notify, bad, notFound } from '../util.js';
import { importPrototype } from '../import-prototype.js';
import { seed } from '../seed.js';

export const adminRoutes = new Hono<Env>();
/** 路障限制：同队成员完成路障次数之差不能超过这个数 */
export function rbGap() {
  const n = Number(getSetting('rb_gap', '2'));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
}

adminRoutes.use('/admin/*', hostOnly);

// ---------- 设置 ----------
adminRoutes.get('/admin/settings', (c) =>
  c.json({ eventName: getSetting('event_name'), hosts: getSetting('hosts'), teamSize: Math.max(1, Number(getSetting('team_size', '2')) || 2), currencyMode: getSetting('currency_mode', 'yuan') === 'coin' ? 'coin' : 'yuan', rbGap: rbGap() }),
);
adminRoutes.put('/admin/settings', async (c) => {
  const b = await body(c);
  if (b.eventName !== undefined) setSetting('event_name', str(b.eventName, 50) || '城市飞奔');
  if (b.currencyMode !== undefined) { if (!['yuan', 'coin'].includes(b.currencyMode)) throw bad('经费类型只能是 yuan 或 coin'); setSetting('currency_mode', b.currencyMode); }
  if (b.teamSize !== undefined) { const n = int(b.teamSize, 0); if (n < 1 || n > 20) throw bad('每队人数必须是 1 到 20 的整数'); setSetting('team_size', String(n)); }
  if (b.rbGap !== undefined) { const n = int(b.rbGap, -1); if (n < 0 || n > 99) throw bad('路障次数差必须是 0 到 99 的整数'); setSetting('rb_gap', String(n)); }
  if (b.hosts !== undefined) {
    const hosts = String(b.hosts).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    setSetting('hosts', hosts.join(','));
    seed();
  }
  audit(c.get('user'), 'update', 'settings', '', undefined, b);
  notify('admin');
  return c.json({ ok: true });
});

// ---------- 准入名单 ----------
adminRoutes.get('/admin/access-list', (c) => {
  const rows = all(
    `SELECT a.username, a.added_by, a.added_at, u.id AS user_id, u.role FROM access_list a LEFT JOIN users u ON u.username = a.username ORDER BY a.username`,
  );
  return c.json({ accessList: rows, hosts: getSetting('hosts', '').split(',').filter(Boolean) });
});
adminRoutes.post('/admin/access-list', async (c) => {
  const b = await body(c);
  const names: string[] = (Array.isArray(b.usernames) ? b.usernames : String(b.usernames ?? '').split(/[,，\n]/))
    .map((s: string) => str(s, 50)).filter(Boolean);
  if (!names.length) throw bad('请输入至少一个ID');
  tx(() => { for (const n of names) run('INSERT OR IGNORE INTO access_list(username, added_by, added_at) VALUES (?,?,?)', n, c.get('user').username, now()); });
  audit(c.get('user'), 'add', 'access_list', '', undefined, names);
  notify('admin');
  return c.json({ ok: true, added: names });
});
adminRoutes.delete('/admin/access-list/:username', (c) => {
  const username = c.req.param('username');
  if (getSetting('hosts', '').split(',').includes(username)) throw bad('主办名单成员不可移除');
  run('DELETE FROM access_list WHERE username = ?', username);
  audit(c.get('user'), 'remove', 'access_list', username);
  notify('admin');
  return c.json({ ok: true });
});

// ---------- 账号 ----------
adminRoutes.get('/admin/users', (c) =>
  c.json({ users: all('SELECT id, username, display_name AS displayName, role, disabled, created_at FROM users ORDER BY role DESC, username') }),
);
adminRoutes.put('/admin/users/:id', async (c) => {
  const id = intParam(c, 'id');
  const before = get('SELECT id, username, display_name, role, disabled FROM users WHERE id = ?', id);
  if (!before) throw notFound('账号不存在');
  const me = c.get('user');
  const b = await body(c);
  if (before.role === 'admin' && me.role !== 'admin') throw bad('管理员账号只能由管理员修改');
  // 管理员只能通过服务器命令创建，页面上不允许把任何账号设为管理员，也不允许把管理员改成别的角色
  if (b.role !== undefined && b.role !== before.role && (b.role === 'admin' || before.role === 'admin')) throw bad('管理员角色只能通过服务器命令设置');
  const role = ['host', 'crew'].includes(b.role) ? b.role : before.role;
  const disabled = b.disabled === undefined ? before.disabled : b.disabled ? 1 : 0;
  const displayName = b.displayName === undefined ? before.display_name : str(b.displayName, 50) || before.display_name;
  if (id === me.id && (role !== me.role || disabled)) throw bad('不能降级或停用自己');
  run('UPDATE users SET role = ?, disabled = ?, display_name = ? WHERE id = ?', role, disabled, displayName, id);
  audit(me, 'update', 'user', id, before, { role, disabled, displayName });
  notify('admin');
  return c.json({ ok: true });
});
adminRoutes.post('/admin/users/:id/reset-password', async (c) => {
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
adminRoutes.delete('/admin/users/:id', (c) => {
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

// ---------- 审计 ----------
adminRoutes.get('/admin/audit', adminOnly, (c) => {
  const limit = Math.min(int(c.req.query('limit'), 200) || 200, 1000);
  const offset = int(c.req.query('offset'), 0);
  return c.json({ logs: all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?', limit, offset), total: get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_logs')!.n });
});

// ---------- 导出 / 导入 / 重置 ----------
const TABLES = ['settings', 'users', 'access_list', 'episodes', 'legs', 'attachments', 'teams', 'assignments', 'progress', 'penalties', 'pitstop_results', 'currency_ledger', 'announcements', 'audit_logs'];

adminRoutes.get('/admin/export', adminOnly, (c) => {
  const dump: Record<string, unknown> = { format: 'crp-v1', exportedAt: now() };
  for (const t of TABLES) dump[t] = all(`SELECT * FROM ${t}`);
  audit(c.get('user'), 'export', 'database');
  c.header('Content-Disposition', `attachment; filename="crp_backup_${now().slice(0, 19).replace(/[:T]/g, '-')}.json"`);
  return c.json(dump);
});

adminRoutes.post('/admin/import', adminOnly, async (c) => {
  const data = await body(c);
  if (data.format !== 'crp-v1') throw bad('不是本系统导出的备份文件（缺少 format: crp-v1）');
  const me = c.get('user');
  tx(() => {
    db.exec('PRAGMA foreign_keys = OFF');
    for (const t of [...TABLES].reverse()) run(`DELETE FROM ${t}`);
    for (const t of TABLES) {
      const rows = Array.isArray(data[t]) ? data[t] : [];
      for (const row of rows) {
        const cols = Object.keys(row);
        run(`INSERT INTO ${t}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((k) => (row[k] === undefined ? null : row[k])));
      }
    }
    db.exec('PRAGMA foreign_keys = ON');
  });
  seed();
  audit(me, 'import', 'database', '', undefined, { exportedAt: data.exportedAt });
  notify('admin'); notify('episodes'); notify('teams');
  return c.json({ ok: true });
});

adminRoutes.post('/admin/import-prototype', adminOnly, async (c) => {
  const b = await body(c);
  const data = b.data ?? b;
  if (!data.episodes || !data.teams) throw bad('不是原型系统的备份文件（缺少 episodes / teams）');
  const report = await importPrototype(data, { baseDate: str(b.baseDate, 10) || undefined, wipe: !!b.wipe });
  audit(c.get('user'), 'import_prototype', 'database', '', undefined, report);
  notify('admin'); notify('episodes'); notify('teams');
  return c.json({ report });
});

adminRoutes.post('/admin/reset', adminOnly, async (c) => {
  const b = await body(c);
  const includeAccounts = !!b.includeAccounts;
  const me = c.get('user');
  tx(() => {
    for (const t of ['pitstop_results', 'penalties', 'progress', 'currency_ledger', 'assignments', 'attachments', 'legs', 'episodes', 'teams', 'announcements']) run(`DELETE FROM ${t}`);
    if (includeAccounts) {
      run("DELETE FROM users WHERE role != 'admin'"); // 只保留管理员账号
      run('DELETE FROM access_list');
    }
  });
  seed();
  audit(me, 'reset', 'database', '', undefined, { includeAccounts });
  notify('admin'); notify('episodes'); notify('teams');
  return c.json({ ok: true });
});
