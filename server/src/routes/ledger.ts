import { Hono } from 'hono';
import { all, get, run, tx, now, fromCents } from '../db.js';
import { canAdjustCurrency, type Env, isAdminRole, isHostRole } from '../auth.js';
import { audit, body, str, int, notify, bad, forbidden, notFound, money, currencyMode, editLockReason } from '../util.js';
import { teamLabelMap, inventoryCount } from './teams.js';

export const ledgerRoutes = new Hono<Env>();

ledgerRoutes.get('/ledger', (c) => {
  const ep = c.req.query('episodeId');
  const teamId = c.req.query('teamId');
  const conds: string[] = ['t.event_id = ?'];
  const params: (number | string)[] = [c.get('event').id];
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

/** 内部记一笔流水（不做权限校验，调用方负责）：返回流水 id */
export function addLedgerEntry(opts: { episodeId: number | null; teamId: number; delta: number; reason: string; legId: number | null; kind: 'shop' | 'cutoff' | 'other'; user: { id: number; displayName: string } }) {
  const team = get<{ currency: number }>('SELECT currency FROM teams WHERE id = ?', opts.teamId);
  if (!team) throw notFound('队伍不存在');
  const balance = team.currency + opts.delta;
  return tx(() => {
    run('UPDATE teams SET currency = ? WHERE id = ?', balance, opts.teamId);
    const r = run(
      'INSERT INTO currency_ledger(episode_id, team_id, delta, balance_after, reason, operator_id, operator_name, created_at, leg_id, kind) VALUES (?,?,?,?,?,?,?,?,?,?)',
      opts.episodeId, opts.teamId, opts.delta, balance, opts.reason, opts.user.id, opts.user.displayName, now(), opts.legId, opts.kind,
    );
    return Number(r.lastInsertRowid);
  });
}
/** 内部反向一笔流水（不做权限校验）：已撤销过则忽略 */
export function revertLedgerEntry(id: number, user: { id: number; displayName: string }) {
  const orig = get('SELECT * FROM currency_ledger WHERE id = ?', id);
  if (!orig || orig.reverted || orig.reverts_id) return;
  const team = get<{ currency: number }>('SELECT currency FROM teams WHERE id = ?', orig.team_id);
  if (!team) return;
  const balance = team.currency - orig.delta;
  tx(() => {
    run('UPDATE teams SET currency = ? WHERE id = ?', balance, orig.team_id);
    run('UPDATE currency_ledger SET reverted = 1 WHERE id = ?', id);
    run(
      'INSERT INTO currency_ledger(episode_id, team_id, delta, balance_after, reason, operator_id, operator_name, created_at, reverts_id, leg_id, kind, item_id, item_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      orig.episode_id, orig.team_id, -orig.delta, balance, `撤销：${orig.reason || '手动调整'}`, user.id, user.displayName, now(), id, orig.leg_id ?? null, orig.kind ?? 'other', orig.item_id ?? null, orig.item_name ?? null,
    );
  });
}

ledgerRoutes.post('/ledger', async (c) => {
  const user = c.get('user');
  const b = await body(c);
  const episodeId = int(b.episodeId, 0) || null;
  const teamId = int(b.teamId, 0);
  const kind: 'shop' | 'cutoff' | 'other' | 'use' = b.kind === 'shop' ? 'shop' : b.kind === 'cutoff' ? 'cutoff' : b.kind === 'use' ? 'use' : 'other';
  let delta = kind === 'shop' || kind === 'use' ? 0 : money(b.delta);
  let reason = str(b.reason, 200) || '手动调整';
  if (kind === 'cutoff') {
    // 熔断：只能扣除
    if (delta >= 0) throw bad('熔断只能扣除');
    reason = `熔断${str(b.reason, 200) ? '：' + str(b.reason, 200) : ''}`;
  }
  let item: { id: number; name: string; price: number } | null = null;
  if (!teamId) throw bad('缺少队伍');
  if (kind === 'shop') {
    // 商店购买：只有货币模式；金额固定为商品价格，只能扣除；必须选在开放商店的环节
    if (currencyMode() !== 'coin') throw bad('只有货币模式的比赛才有商店');
    item = get<{ id: number; name: string; price: number }>('SELECT id, name, price FROM shop_items WHERE id = ? AND event_id = ?', int(b.itemId, 0), c.get('event').id) ?? null;
    if (!item) throw notFound('商品不存在');
    delta = -item.price;
    reason = `购买：${item.name}`;
  }
  let useName: string | null = null;
  if (kind === 'use') {
    // 使用背包物品：不动余额，只记一条流水；每次只用一件，物品必须在背包里
    useName = str(b.itemName, 100);
    if (!useName) throw bad('缺少物品');
    if (inventoryCount(teamId, useName) < 1) throw bad(`背包里没有「${useName}」`);
    reason = `使用：${useName}`;
  }
  if (!delta && kind !== 'use') throw bad('金额不能为 0');
  if (!canAdjustCurrency(user, episodeId ?? 0, teamId, int(b.legId, 0) || null)) throw forbidden('主办可操作所有队伍；跟队只能操作所跟队伍；站点只能记在自己驻守的环节上');
  const team = get('SELECT * FROM teams WHERE id = ?', teamId);
  if (!team || team.event_id !== c.get('event').id) throw notFound('队伍不存在');
  const epRow = episodeId ? get<{ status: string; code: string }>('SELECT status, code FROM episodes WHERE id = ?', episodeId) : null;
  if (epRow?.status === 'pending' && !isAdminRole(user.role)) throw bad(`${epRow.code} 尚未开始，开始赛段后才能操作经费`);
  { const r = editLockReason(user, epRow, team as { status: string }); if (r) throw forbidden(r); }
  // 环节为空 = “其他”，只有主办能选（与罚时一致）；使用物品不选环节，自动记在该队当前进行中的环节上
  let legId = int(b.legId, 0) || null;
  if (kind === 'use' && !legId && episodeId) legId = get<{ leg_id: number }>(
    `SELECT p.leg_id FROM progress p JOIN legs l ON l.id = p.leg_id WHERE p.episode_id = ? AND p.team_id = ? AND p.arrived_at IS NOT NULL AND p.completed_at IS NULL ORDER BY l.sort DESC, l.id DESC LIMIT 1`, episodeId, teamId,
  )?.leg_id ?? null;
  if (!legId && !isHostRole(user.role) && kind !== 'use') throw forbidden('“其他”环节只能由主办选择，请选择具体环节');
  const legRow = legId ? get('SELECT id, shop_open FROM legs WHERE id = ? AND episode_id = ?', legId, episodeId ?? 0) : null;
  if (legId && !legRow) throw notFound('环节不存在');
  if (kind === 'shop') {
    if (!legRow) throw bad('商店购买必须选择所在环节');
    if (!legRow.shop_open) throw bad('该环节没有开放商店');
  }
  const balance = team.currency + delta;
  const id = tx(() => {
    run('UPDATE teams SET currency = ? WHERE id = ?', balance, teamId);
    const r = run(
      'INSERT INTO currency_ledger(episode_id, team_id, delta, balance_after, reason, operator_id, operator_name, created_at, leg_id, kind, item_id, item_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      episodeId, teamId, delta, balance, reason, user.id, user.displayName, now(), legId, kind, item?.id ?? null, item?.name ?? useName,
    );
    return Number(r.lastInsertRowid);
  });
  audit(user, kind === 'shop' ? 'shop_buy' : kind === 'use' ? 'item_use' : 'currency', 'team', teamId, { currency: fromCents(team.currency) }, { delta: fromCents(delta), balance: fromCents(balance), reason, item: item?.name ?? useName });
  notify('ledger', episodeId);
  notify('teams');
  return c.json({ id, balance: fromCents(balance) });
});

/** 撤销一条经费变动：只有发出这条记录的本人和主办可以撤销 */
ledgerRoutes.post('/ledger/:id/revert', (c) => {
  const id = int(c.req.param('id'), 0);
  const user = c.get('user');
  const orig = get('SELECT * FROM currency_ledger WHERE id = ?', id);
  if (!orig) throw notFound('流水不存在');
  if (!isHostRole(user.role) && orig.operator_id !== user.id) throw forbidden('只有发出这条记录的本人或主办可以撤销');
  if (orig.kind === 'shop' && orig.item_name && inventoryCount(orig.team_id, orig.item_name) < 1) throw bad(`「${orig.item_name}」已经被使用，请先撤销使用记录`);
  { const r = editLockReason(user, orig.episode_id ? get<{ status: string; code: string }>('SELECT status, code FROM episodes WHERE id = ?', orig.episode_id) : null, get<{ status: string }>('SELECT status FROM teams WHERE id = ?', orig.team_id)); if (r) throw forbidden(r); }
  if (orig.reverted) throw bad('这条变动已经撤销过了');
  if (orig.reverts_id) throw bad('撤销记录本身不能再撤销');
  const team = get('SELECT * FROM teams WHERE id = ?', orig.team_id);
  if (!team) throw notFound('队伍不存在');
  const balance = team.currency - orig.delta;
  const newId = tx(() => {
    run('UPDATE teams SET currency = ? WHERE id = ?', balance, orig.team_id);
    run('UPDATE currency_ledger SET reverted = 1 WHERE id = ?', id);
    const r = run(
      'INSERT INTO currency_ledger(episode_id, team_id, delta, balance_after, reason, operator_id, operator_name, created_at, reverts_id, leg_id, kind, item_id, item_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      orig.episode_id, orig.team_id, -orig.delta, balance, `撤销：${orig.reason || '手动调整'}`, user.id, user.displayName, now(), id, orig.leg_id ?? null, orig.kind ?? 'other', orig.item_id ?? null, orig.item_name ?? null,
    );
    return Number(r.lastInsertRowid);
  });
  audit(user, 'currency_revert', 'ledger', id, { delta: fromCents(orig.delta) }, { revertId: newId, balance: fromCents(balance) });
  // 熔断扣币被撤销 = 那次使用作废：删掉使用记录，倒计时按剩余记录重算
  if (orig.kind === 'cutoff') {
    const u = get<{ id: number }>('SELECT id FROM cutoff_uses WHERE ledger_id = ?', id);
    if (u) { run('DELETE FROM cutoff_uses WHERE id = ?', u.id); audit(user, 'cutoff_use_delete', 'team', orig.team_id, { useId: u.id, byLedgerRevert: id }); notify('progress', orig.episode_id); }
  }
  notify('ledger', orig.episode_id);
  notify('teams');
  return c.json({ id: newId, balance: fromCents(balance) });
});
