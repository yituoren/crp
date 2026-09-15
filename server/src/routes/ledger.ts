import { Hono } from 'hono';
import { all, get, run, tx, now, fromCents } from '../db.js';
import { canAdjustCurrency, type Env, isHostRole } from '../auth.js';
import { audit, body, str, int, notify, bad, forbidden, notFound, money } from '../util.js';
import { teamLabelMap } from './teams.js';

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
    `SELECT l.*, t.name AS team_name, t.code AS team_code, e.code AS episode_code, g.name AS leg_name
     FROM currency_ledger l
     JOIN teams t ON t.id = l.team_id
     LEFT JOIN episodes e ON e.id = l.episode_id
     LEFT JOIN legs g ON g.id = l.leg_id
     ${where} ORDER BY l.id DESC LIMIT 500`,
    ...params,
  );
  const labels = teamLabelMap();
  return c.json({ ledger: rows.map((r) => ({ ...r, team_name: labels.get(r.team_id) ?? r.team_name, delta: fromCents(r.delta), balance_after: fromCents(r.balance_after) })) });
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
  if (!canAdjustCurrency(user, episodeId ?? 0, teamId)) throw forbidden('只有主办或该队伍的跟队可以操作经费');
  const team = get('SELECT * FROM teams WHERE id = ?', teamId);
  if (!team) throw notFound('队伍不存在');
  if (episodeId) {
    const epRow = get('SELECT status, code FROM episodes WHERE id = ?', episodeId);
    if (epRow?.status === 'pending') throw bad(`${epRow.code} 尚未开始，开始赛段后才能操作经费`);
    if (epRow?.status === 'finished' && !isHostRole(user.role)) throw forbidden(`${epRow.code} 已结束，只有主办可以操作经费`);
  }
  const legId = int(b.legId, 0) || null; // 环节可空 = 其他，不做权限校验
  if (legId && !get('SELECT 1 FROM legs WHERE id = ? AND episode_id = ?', legId, episodeId ?? 0)) throw notFound('环节不存在');
  const balance = team.currency + delta;
  const id = tx(() => {
    run('UPDATE teams SET currency = ? WHERE id = ?', balance, teamId);
    const r = run(
      'INSERT INTO currency_ledger(episode_id, team_id, delta, balance_after, reason, operator_id, operator_name, created_at, leg_id) VALUES (?,?,?,?,?,?,?,?,?)',
      episodeId, teamId, delta, balance, reason, user.id, user.displayName, now(), legId,
    );
    return Number(r.lastInsertRowid);
  });
  audit(user, 'currency', 'team', teamId, { currency: fromCents(team.currency) }, { delta: fromCents(delta), balance: fromCents(balance), reason });
  notify('ledger', episodeId);
  notify('teams');
  return c.json({ id, balance: fromCents(balance) });
});

/** 撤销一条经费变动：有权添加该记录的人就有权撤销（主办任意；站点本赛段；跟队所跟队伍） */
ledgerRoutes.post('/ledger/:id/revert', (c) => {
  const id = int(c.req.param('id'), 0);
  const user = c.get('user');
  const orig = get('SELECT * FROM currency_ledger WHERE id = ?', id);
  if (!orig) throw notFound('流水不存在');
  if (!canAdjustCurrency(user, orig.episode_id ?? 0, orig.team_id)) throw forbidden('没有这条记录的撤销权限');
  if (!isHostRole(user.role) && orig.episode_id && get('SELECT status FROM episodes WHERE id = ?', orig.episode_id)?.status === 'finished') throw forbidden('赛段已结束，只有主办可以撤销');
  if (orig.reverted) throw bad('这条变动已经撤销过了');
  if (orig.reverts_id) throw bad('撤销记录本身不能再撤销');
  const team = get('SELECT * FROM teams WHERE id = ?', orig.team_id);
  if (!team) throw notFound('队伍不存在');
  const balance = team.currency - orig.delta;
  const newId = tx(() => {
    run('UPDATE teams SET currency = ? WHERE id = ?', balance, orig.team_id);
    run('UPDATE currency_ledger SET reverted = 1 WHERE id = ?', id);
    const r = run(
      'INSERT INTO currency_ledger(episode_id, team_id, delta, balance_after, reason, operator_id, operator_name, created_at, reverts_id, leg_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
      orig.episode_id, orig.team_id, -orig.delta, balance, `撤销：${orig.reason || '手动调整'}`, user.id, user.displayName, now(), id, orig.leg_id ?? null,
    );
    return Number(r.lastInsertRowid);
  });
  audit(user, 'currency_revert', 'ledger', id, { delta: fromCents(orig.delta) }, { revertId: newId, balance: fromCents(balance) });
  notify('ledger', orig.episode_id);
  notify('teams');
  return c.json({ id: newId, balance: fromCents(balance) });
});
