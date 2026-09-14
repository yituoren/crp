import { Hono } from 'hono';
import { all, get, run, tx, fromCents } from '../db.js';
import { hostOnly, type Env } from '../auth.js';
import { audit, body, str, int, intParam, notify, bad, notFound, money } from '../util.js';

export const teamRoutes = new Hono<Env>();

/** members 列存 JSON 数组；兼容旧的自由文本（按 / & 、 , 空格拆分） */
export function parseMembers(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
  const s = String(raw ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) { try { return parseMembers(JSON.parse(s)); } catch { /* fallthrough */ } }
  return s.split(/[\/&、,，\s]+/).map((x) => x.trim()).filter(Boolean);
}
/** 队伍显示名：填了成员就显示 A&B&C，否则显示队名 */
export const teamLabel = (name: string, members: string[]) => (members.length ? members.join('&') : name);
export function teamLabelMap(): Map<number, string> {
  return new Map(all('SELECT id, name, members FROM teams').map((t) => [t.id, teamLabel(t.name, parseMembers(t.members))]));
}
export const listTeams = () =>
  all('SELECT id, code, name, members, status, currency, sort FROM teams ORDER BY sort, id').map((t) => {
    const members = parseMembers(t.members);
    return { ...t, members, label: teamLabel(t.name, members), currency: fromCents(t.currency) };
  });
const pad2 = (n: number) => String(n).padStart(2, '0');

teamRoutes.get('/teams', (c) => c.json({ teams: listTeams() }));

teamRoutes.post('/teams', hostOnly, async (c) => {
  const b = await body(c);
  const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM teams')!.n;
  const name = str(b.name, 50) || pad2(count + 1);
  let code = str(b.code, 20) || `T${count + 1}`;
  while (get('SELECT 1 FROM teams WHERE code = ?', code)) code = code + '_';
  const currency = b.currency === undefined ? 0 : money(b.currency, '货币');
  const r = run(
    'INSERT INTO teams(code, name, members, status, currency, sort) VALUES (?,?,?,?,?,?)',
    code, name, JSON.stringify(parseMembers(b.members).slice(0, 20)), 'alive', currency, count + 1,
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
  const members = b.members === undefined ? before.members : JSON.stringify(parseMembers(b.members).slice(0, 20));
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

/** 重置全部队伍：状态恢复存活、货币清零（不改队名） */
teamRoutes.post('/teams/reset', hostOnly, (c) => {
  tx(() => {
    run('UPDATE teams SET status = ?, currency = 0', 'alive');
  });
  audit(c.get('user'), 'reset', 'team', 'all');
  notify('teams');
  return c.json({ ok: true });
});
