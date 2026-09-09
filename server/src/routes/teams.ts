import { Hono } from 'hono';
import { all, get, run, tx, getSetting } from '../db.js';
import { hostOnly, type Env } from '../auth.js';
import { audit, body, str, int, intParam, notify, bad, notFound } from '../util.js';

export const teamRoutes = new Hono<Env>();

export const listTeams = () =>
  all('SELECT id, code, name, members, status, currency, sort FROM teams ORDER BY sort, id');

teamRoutes.get('/teams', (c) => c.json({ teams: listTeams() }));

teamRoutes.post('/teams', hostOnly, async (c) => {
  const b = await body(c);
  const name = str(b.name, 50);
  if (!name) throw bad('队名不能为空');
  const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM teams')!.n;
  let code = str(b.code, 20) || `T${count + 1}`;
  while (get('SELECT 1 FROM teams WHERE code = ?', code)) code = code + '_';
  const currency = b.currency === undefined ? Number(getSetting('initial_currency', '1000')) : int(b.currency);
  const r = run(
    'INSERT INTO teams(code, name, members, status, currency, sort) VALUES (?,?,?,?,?,?)',
    code, name, str(b.members, 200), 'alive', currency, count + 1,
  );
  audit(c.get('user'), 'create', 'team', Number(r.lastInsertRowid), undefined, { code, name });
  notify('teams');
  return c.json({ id: Number(r.lastInsertRowid) });
});

teamRoutes.put('/teams/:id', hostOnly, async (c) => {
  const id = intParam(c, 'id');
  const before = get('SELECT * FROM teams WHERE id = ?', id);
  if (!before) throw notFound('队伍不存在');
  const b = await body(c);
  const name = b.name === undefined ? before.name : str(b.name, 50) || before.name;
  const members = b.members === undefined ? before.members : str(b.members, 200);
  const status = ['alive', 'eliminated', 'withdrawn'].includes(b.status) ? b.status : before.status;
  const sort = b.sort === undefined ? before.sort : int(b.sort, before.sort);
  run('UPDATE teams SET name = ?, members = ?, status = ?, sort = ? WHERE id = ?', name, members, status, sort, id);
  audit(c.get('user'), 'update', 'team', id, before, { name, members, status, sort });
  notify('teams');
  return c.json({ ok: true });
});

teamRoutes.delete('/teams/:id', hostOnly, (c) => {
  const id = intParam(c, 'id');
  const before = get('SELECT * FROM teams WHERE id = ?', id);
  if (!before) throw notFound('队伍不存在');
  run('DELETE FROM teams WHERE id = ?', id);
  audit(c.get('user'), 'delete', 'team', id, before);
  notify('teams');
  return c.json({ ok: true });
});

/** 重置全部队伍：状态恢复存活、货币恢复初始值（不改队名） */
teamRoutes.post('/teams/reset', hostOnly, (c) => {
  const initial = Number(getSetting('initial_currency', '1000'));
  tx(() => {
    run('UPDATE teams SET status = ?, currency = ?', 'alive', initial);
  });
  audit(c.get('user'), 'reset', 'team', 'all');
  notify('teams');
  return c.json({ ok: true });
});
