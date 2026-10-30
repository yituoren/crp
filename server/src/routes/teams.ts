import { recomputeEliminations, lockFromAfterLastRecord } from '../elimination.js';
import { Hono, type Context } from 'hono';
import { all, get, run, tx, fromCents } from '../db.js';
import { hostOnly, type Env, type EventRow } from '../auth.js';
import { audit, body, str, int, intParam, notify, bad, notFound, money } from '../util.js';

export const teamRoutes = new Hono<Env>();

/** members is a JSON array; old free text is split on / & 、 , and spaces */
export function parseMembers(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
  const s = String(raw ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) { try { return parseMembers(JSON.parse(s)); } catch { /* fallthrough */ } }
  return s.split(/[\/&、,，\s]+/).map((x) => x.trim()).filter(Boolean);
}
/** Full team label: "number A&B&C" when members are filled in, otherwise just the number */
export const fullTeamLabel = (name: string, members: string[]) => (members.length ? `${name} ${members.join('&')}` : name);
/** Team label used everywhere: "number short name" when a short name is set, otherwise the full label */
export const teamLabel = (name: string, members: string[], shortName = '') => (shortName ? `${name} ${shortName}` : fullTeamLabel(name, members));
export function teamLabelMap(): Map<number, string> {
  return new Map(all('SELECT id, name, members, short_name FROM teams').map((t) => [t.id, teamLabel(t.name, parseMembers(t.members), t.short_name)]));
}
/** Roadblock counts per member per team (across episodes), used for the roadblock limit */
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
/** Team bags: non-reverted gains minus uses in the item log, counted per item */
export function inventoryByTeam(eventId: number) {
  const m = new Map<number, { name: string; count: number }[]>();
  for (const r of all(
    `SELECT l.team_id, l.item_name AS name, SUM(l.delta) AS count FROM item_log l JOIN teams t ON t.id = l.team_id
     WHERE t.event_id = ? AND l.reverted = 0 AND l.reverts_id IS NULL
     GROUP BY l.team_id, l.item_name HAVING count > 0 ORDER BY MIN(l.id)`, eventId,
  )) {
    if (!m.has(r.team_id)) m.set(r.team_id, []);
    m.get(r.team_id)!.push({ name: r.name, count: r.count });
  }
  return m;
}
/** How many of an item a team holds */
export function inventoryCount(teamId: number, itemName: string): number {
  return get<{ n: number | null }>('SELECT SUM(delta) AS n FROM item_log WHERE team_id = ? AND item_name = ? AND reverted = 0 AND reverts_id IS NULL', teamId, itemName)?.n ?? 0;
}
export const listTeams = (eventId: number) => {
  const rb = rbCountsByTeam();
  const inv = inventoryByTeam(eventId);
  return all('SELECT id, code, name, members, short_name, status, currency, sort, eliminated_leg_id, locked_from_leg_id FROM teams WHERE event_id = ? ORDER BY sort, id', eventId).map((t) => {
    const members = parseMembers(t.members);
    return { ...t, members, label: teamLabel(t.name, members, t.short_name), full_label: fullTeamLabel(t.name, members), currency: fromCents(t.currency), rbCounts: rb.get(t.id) ?? {}, inventory: inv.get(t.id) ?? [] };
  });
};
const pad2 = (n: number) => String(n).padStart(2, '0');
/** Team numbers are generated from the order (01, 02…) and cannot be edited; renumbered after reorder, insert or delete */
function renumberTeams(eventId: number) {
  all<{ id: number }>('SELECT id FROM teams WHERE event_id = ? ORDER BY sort, id', eventId).forEach((t, i) => run('UPDATE teams SET sort = ?, name = ? WHERE id = ?', i + 1, pad2(i + 1), t.id));
}

/** The team must belong to the current event */
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
  const name = pad2(count + 1); // numbers are generated from the order
  let code = str(b.code, 20) || `T${count + 1}`;
  while (get('SELECT 1 FROM teams WHERE code = ? AND event_id = ?', code, eventId)) code = code + '_';
  const currency = b.currency === undefined ? 0 : money(b.currency, '货币');
  const r = run(
    'INSERT INTO teams(code, name, members, short_name, status, currency, sort, event_id) VALUES (?,?,?,?,?,?,?,?)',
    code, name, JSON.stringify(parseMembers(b.members).slice(0, 20)), str(b.short_name, 20), 'alive', currency, count + 1, eventId,
  );
  renumberTeams(eventId);
  audit(c.get('user'), 'create', 'team', Number(r.lastInsertRowid), undefined, { code, name });
  notify('teams');
  return c.json({ id: Number(r.lastInsertRowid) });
});

/** Drag reorder: ids is the new order; teams not listed keep their relative order after it; then renumber */
teamRoutes.put('/teams/order', hostOnly, async (c) => {
  const eventId = c.get('event').id;
  const { ids } = await body(c);
  if (!Array.isArray(ids)) throw bad('ids 必须是数组');
  const existing = all<{ id: number }>('SELECT id FROM teams WHERE event_id = ? ORDER BY sort, id', eventId).map((t) => t.id);
  const ordered = ids.map((x: unknown) => int(x)).filter((id: number) => existing.includes(id));
  const finalOrder = [...ordered, ...existing.filter((id) => !ordered.includes(id))];
  tx(() => {
    finalOrder.forEach((id, i) => run('UPDATE teams SET sort = ? WHERE id = ?', i + 1, id));
    renumberTeams(eventId);
  });
  audit(c.get('user'), 'reorder', 'team', eventId, undefined, finalOrder);
  notify('teams');
  return c.json({ ok: true });
});

teamRoutes.put('/teams/:id', hostOnly, async (c) => {
  const id = intParam(c, 'id');
  const before = teamInEvent(c, id);
  const b = await body(c);
  const name = before.name; // the number comes from the order and cannot be changed
  const members = b.members === undefined ? before.members : JSON.stringify(parseMembers(b.members).slice(0, 20));
  const shortName = b.short_name === undefined ? before.short_name : str(b.short_name, 20);
  // status can only be set to withdrawn or restored from it; elimination is computed from leg rules, no manual entry
  if (b.status !== undefined && !['alive', 'withdrawn'].includes(b.status)) throw bad('淘汰由环节的淘汰规则自动判定，不能手动设置');
  if (b.status === 'alive' && before.status === 'eliminated') throw bad('淘汰状态由记录自动计算，修改记录后会自动恢复');
  const status = b.status === undefined ? before.status : b.status;
  const sort = before.sort; // order is changed through PUT /teams/order
  let locked: number | null = before.locked_from_leg_id ?? null;
  if (status === 'withdrawn' && before.status !== 'withdrawn') locked = lockFromAfterLastRecord(c.get('event').id, id); // withdrawal: earlier records stay, later legs are locked
  if (status === 'alive' && before.status === 'withdrawn') locked = null;
  run('UPDATE teams SET name = ?, members = ?, short_name = ?, status = ?, sort = ?, locked_from_leg_id = ?, eliminated_leg_id = CASE WHEN ? = \'withdrawn\' THEN NULL ELSE eliminated_leg_id END WHERE id = ?', name, members, shortName, status, sort, locked, status, id);
  audit(c.get('user'), 'update', 'team', id, before, { name, members, short_name: shortName, status, sort, locked_from_leg_id: locked });
  recomputeEliminations(c.get('event').id); // withdrawing / restoring changes which teams take part
  notify('teams');
  return c.json({ ok: true });
});

teamRoutes.delete('/teams/:id', hostOnly, (c) => {
  const id = intParam(c, 'id');
  const before = teamInEvent(c, id);
  tx(() => {
    // delete everything of the team: progress, penalties, results, ledger, references as target / partner, follow assignments
    run('DELETE FROM progress WHERE team_id = ?', id);
    run('UPDATE progress SET target_team_id = NULL WHERE target_team_id = ?', id);
    run('DELETE FROM penalties WHERE team_id = ?', id);
    run('DELETE FROM pitstop_results WHERE team_id = ?', id);
    run('DELETE FROM currency_ledger WHERE team_id = ?', id);
    run('UPDATE assignments SET team_id = NULL WHERE team_id = ?', id);
    run('DELETE FROM teams WHERE id = ?', id);
  });
  renumberTeams(c.get('event').id);
  audit(c.get('user'), 'delete', 'team', id, before);
  recomputeEliminations(c.get('event').id);
  notify('teams'); notify('progress'); notify('ledger'); notify('assignments');
  return c.json({ ok: true });
});

/** Reset all teams: alive again, balance zero (names untouched) */
teamRoutes.post('/teams/reset', hostOnly, (c) => {
  tx(() => {
    run('UPDATE teams SET status = ?, currency = 0, eliminated_leg_id = NULL, locked_from_leg_id = NULL WHERE event_id = ?', 'alive', c.get('event').id);
  });
  audit(c.get('user'), 'reset', 'team', 'all');
  notify('teams');
  return c.json({ ok: true });
});
