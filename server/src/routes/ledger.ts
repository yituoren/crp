import { Hono } from 'hono';
import { all, get, run, tx, now, fromCents } from '../db.js';
import { canAdjustCurrency, type Env } from '../auth.js';
import { audit, body, str, int, notify, bad, forbidden, notFound, money } from '../util.js';

export const ledgerRoutes = new Hono<Env>();

ledgerRoutes.get('/ledger', (c) => {
  const ep = c.req.query('episodeId');
  const teamId = c.req.query('teamId');
  const conds: string[] = [];
  const params: (number | string)[] = [];
  if (ep) { conds.push('l.episode_id = ?'); params.push(Number(ep)); }
  if (teamId) { conds.push('l.team_id = ?'); params.push(Number(teamId)); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = all(
    `SELECT l.*, t.name AS team_name, t.code AS team_code, e.code AS episode_code
     FROM currency_ledger l
     JOIN teams t ON t.id = l.team_id
     LEFT JOIN episodes e ON e.id = l.episode_id
     ${where} ORDER BY l.id DESC LIMIT 500`,
    ...params,
  );
  return c.json({ ledger: rows.map((r) => ({ ...r, delta: fromCents(r.delta), balance_after: fromCents(r.balance_after) })) });
});

ledgerRoutes.post('/ledger', async (c) => {
  const user = c.get('user');
  const b = await body(c);
  const episodeId = int(b.episodeId, 0) || null;
  const teamId = int(b.teamId, 0);
  const delta = money(b.delta);
  const reason = str(b.reason, 200) || '手动调整';
  if (!teamId) throw bad('缺少队伍');
  if (!delta) throw bad('金额不能为 0');
  if (!canAdjustCurrency(user, episodeId ?? 0)) throw forbidden('只有主办或本赛段的站点人员可以操作货币');
  const team = get('SELECT * FROM teams WHERE id = ?', teamId);
  if (!team) throw notFound('队伍不存在');
  const balance = team.currency + delta;
  const id = tx(() => {
    run('UPDATE teams SET currency = ? WHERE id = ?', balance, teamId);
    const r = run(
      'INSERT INTO currency_ledger(episode_id, team_id, delta, balance_after, reason, operator_id, operator_name, created_at) VALUES (?,?,?,?,?,?,?,?)',
      episodeId, teamId, delta, balance, reason, user.id, user.displayName, now(),
    );
    return Number(r.lastInsertRowid);
  });
  audit(user, 'currency', 'team', teamId, { currency: fromCents(team.currency) }, { delta: fromCents(delta), balance: fromCents(balance), reason });
  notify('ledger', episodeId);
  notify('teams');
  return c.json({ id, balance: fromCents(balance) });
});
