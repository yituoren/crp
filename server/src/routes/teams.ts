import { Hono, type Context } from 'hono';
import { all, get, run, tx, fromCents } from '../db.js';
import { hostOnly, type Env, type EventRow } from '../auth.js';
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
/** 队伍显示名：填了成员就显示「编号 A&B&C」，否则只显示编号 */
export const teamLabel = (name: string, members: string[]) => (members.length ? `${name} ${members.join('&')}` : name);
export function teamLabelMap(): Map<number, string> {
  return new Map(all('SELECT id, name, members FROM teams').map((t) => [t.id, teamLabel(t.name, parseMembers(t.members))]));
}
/** 每队各成员完成路障的次数（跨赛段），用于路障人选限制 */
function rbCountsByTeam() {
  const m = new Map<number, Record<string, number>>();
  for (const r of all(
    `SELECT p.team_id, p.roadblock_by, COUNT(*) AS c FROM progress p JOIN legs l ON l.id = p.leg_id
     WHERE l.type = 'RB' AND p.roadblock_by IS NOT NULL AND p.roadblock_by != '' GROUP BY p.team_id, p.roadblock_by`,
  )) {
    if (!m.has(r.team_id)) m.set(r.team_id, {});
    m.get(r.team_id)![r.roadblock_by] = r.c;
  }
  return m;
}
export const listTeams = (eventId: number) => {
  const rb = rbCountsByTeam();
  return all('SELECT id, code, name, members, status, currency, sort FROM teams WHERE event_id = ? ORDER BY sort, id', eventId).map((t) => {
    const members = parseMembers(t.members);
    return { ...t, members, label: teamLabel(t.name, members), currency: fromCents(t.currency), rbCounts: rb.get(t.id) ?? {} };
  });
};
const pad2 = (n: number) => String(n).padStart(2, '0');

/** 队伍必须属于当前比赛 */
export function teamInEvent(c: Context, id: number) {
  const t = get('SELECT * FROM teams WHERE id = ?', id);
  if (!t || t.event_id !== (c.get('event') as EventRow).id) throw notFound('队伍不存在');
  return t;
}

teamRoutes.get('/teams', (c) => c.json({ teams: listTeams(c.get('event').id) }));

teamRoutes.post('/teams', hostOnly, async (c) => {
  const b = await body(c);
  const eventId = c.get('event').id;
  const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM teams WHERE event_id = ?', eventId)!.n;
  const name = str(b.name, 50) || pad2(count + 1);
  let code = str(b.code, 20) || `T${count + 1}`;
  while (get('SELECT 1 FROM teams WHERE code = ? AND event_id = ?', code, eventId)) code = code + '_';
  const currency = b.currency === undefined ? 0 : money(b.currency, '货币');
  const r = run(
    'INSERT INTO teams(code, name, members, status, currency, sort, event_id) VALUES (?,?,?,?,?,?,?)',
    code, name, JSON.stringify(parseMembers(b.members).slice(0, 20)), 'alive', currency, count + 1, eventId,
  );
  audit(c.get('user'), 'create', 'team', Number(r.lastInsertRowid), undefined, { code, name });
  notify('teams');
  return c.json({ id: Number(r.lastInsertRowid) });
});

teamRoutes.put('/teams/:id', hostOnly, async (c) => {
  const id = intParam(c, 'id');
  const before = teamInEvent(c, id);
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
  const before = teamInEvent(c, id);
  run('DELETE FROM teams WHERE id = ?', id);
  audit(c.get('user'), 'delete', 'team', id, before);
  notify('teams');
  return c.json({ ok: true });
});

/** 重置全部队伍：状态恢复存活、货币清零（不改队名） */
teamRoutes.post('/teams/reset', hostOnly, (c) => {
  tx(() => {
    run('UPDATE teams SET status = ?, currency = 0 WHERE event_id = ?', 'alive', c.get('event').id);
  });
  audit(c.get('user'), 'reset', 'team', 'all');
  notify('teams');
  return c.json({ ok: true });
});
