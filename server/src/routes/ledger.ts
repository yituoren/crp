import { Hono } from 'hono';
import { all, get, run, tx, now, fromCents } from '../db.js';
import { canAdjustCurrency, getAssignment, type Env, isAdminRole, isHostRole } from '../auth.js';
import { audit, body, str, int, notify, bad, forbidden, notFound, money, currencyMode, editLockReason } from '../util.js';
import { teamLabelMap, inventoryCount } from './teams.js';
import { shopStock } from './episodes.js';
import { checkUse, afterUse, beforeRevertUse, kindOf, isDirected, isSteal } from '../twist.js';
import { SYSTEM_USER } from '../episodeStart.js';
import { recomputeEliminations } from '../elimination.js';
import { currentLegOf } from '../progressCore.js';

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

/** Internal: write a ledger row (no permission check, the caller is responsible); returns the row id */
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
    const id = Number(r.lastInsertRowid);
    settleDebt(opts.teamId, id);
    return id;
  });
}
/** Internal: revert a ledger row (no permission check); ignored when already reverted */
export function revertLedgerEntry(id: number, user: { id: number; displayName: string }) {
  const orig = get('SELECT * FROM currency_ledger WHERE id = ?', id);
  if (!orig || orig.reverted || orig.reverts_id) return;
  tx(() => {
    const newId = writeRevert(orig, user);
    settleDebt(orig.team_id, newId);
  });
}
/** Write the reverse row of a ledger change and return its id. The debt settlements that change caused are reverted first (with their penalties), so no penalty stays behind for a charge that is gone */
function writeRevert(orig: any, user: { id: number; displayName: string }): number {
  for (const s of all('SELECT * FROM currency_ledger WHERE debt_of = ? AND reverted = 0 AND reverts_id IS NULL', orig.id)) {
    if (s.penalty_id) revertPenaltyRow(s.penalty_id, user);
    writeRevert(s, user);
  }
  const team = get<{ currency: number }>('SELECT currency FROM teams WHERE id = ?', orig.team_id)!;
  const balance = team.currency - orig.delta;
  run('UPDATE teams SET currency = ? WHERE id = ?', balance, orig.team_id);
  run('UPDATE currency_ledger SET reverted = 1 WHERE id = ?', orig.id);
  const r = run(
    'INSERT INTO currency_ledger(episode_id, team_id, delta, balance_after, reason, operator_id, operator_name, created_at, reverts_id, leg_id, kind, item_id, item_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    orig.episode_id, orig.team_id, -orig.delta, balance, `撤销：${orig.reason || '手动调整'}`, user.id, user.displayName, now(), orig.id, orig.leg_id ?? null, orig.kind ?? 'other', orig.item_id ?? null, orig.item_name ?? null,
  );
  return Number(r.lastInsertRowid);
}
function revertPenaltyRow(id: number, user: { id: number }) {
  const p = get('SELECT * FROM penalties WHERE id = ?', id);
  if (!p || p.reverted || p.reverts_id) return;
  run('UPDATE penalties SET reverted = 1 WHERE id = ?', id);
  run('INSERT INTO penalties(episode_id, team_id, minutes, reason, applied_by, applied_at, reverts_id, leg_id) VALUES (?,?,?,?,?,?,?,?)',
    p.episode_id, p.team_id, -p.minutes, `撤销：${p.reason}`, user.id, now(), id, p.leg_id ?? null);
  notify('progress', p.episode_id);
}

/** Coins of debt become penalty minutes at this rate */
const DEBT_MIN_PER_COIN = 5;
/**
 * Debt is settled at once (coin mode): when a change leaves the balance below zero, every coin short becomes 5 minutes
 * of penalty on the leg the team is on (「其他」 before it has started the episode) and the balance goes back to 0. The
 * settlement row points at the change (debt_of), so reverting that change reverts the settlement and its penalty too.
 */
export function settleDebt(teamId: number, causeId: number) {
  if (currencyMode() !== 'coin') return;
  const team = get<{ currency: number; event_id: number }>('SELECT currency, event_id FROM teams WHERE id = ?', teamId);
  if (!team || team.currency >= 0) return;
  const cause = get('SELECT episode_id FROM currency_ledger WHERE id = ?', causeId);
  const episodeId: number | null = cause?.episode_id
    ?? get<{ id: number }>("SELECT id FROM episodes WHERE event_id = ? AND status != 'pending' ORDER BY sort DESC, id DESC LIMIT 1", team.event_id)?.id ?? null;
  if (!episodeId) return;
  // the penalty goes on the leg the team is on (「其他」 before it starts), settled like any penalty there
  const legId = currentLegOf(episodeId, teamId);
  const lack = -team.currency;
  const coins = Math.ceil(lack / 100);
  const minutes = coins * DEBT_MIN_PER_COIN;
  tx(() => {
    const p = run('INSERT INTO penalties(episode_id, team_id, minutes, reason, applied_by, applied_at, leg_id) VALUES (?,?,?,?,?,?,?)',
      episodeId, teamId, minutes, `欠费 ${coins} 币，罚时`, SYSTEM_USER.id, now(), legId);
    const penaltyId = Number(p.lastInsertRowid);
    run('UPDATE teams SET currency = 0 WHERE id = ?', teamId);
    run('INSERT INTO currency_ledger(episode_id, team_id, delta, balance_after, reason, operator_id, operator_name, created_at, leg_id, kind, debt_of, penalty_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      episodeId, teamId, lack, 0, `欠费 ${coins} 币，换成罚时 ${minutes} 分钟`, SYSTEM_USER.id, SYSTEM_USER.displayName, now(), legId, 'other', causeId, penaltyId);
    audit(SYSTEM_USER, 'debt_settle', 'team', teamId, { currency: fromCents(-lack) }, { minutes, causeId, penaltyId });
  });
  notify('progress', episodeId);
  if (recomputeEliminations(team.event_id)) notify('teams');
}

ledgerRoutes.post('/ledger', async (c) => {
  const user = c.get('user');
  const b = await body(c);
  const episodeId = int(b.episodeId, 0) || null;
  const teamId = int(b.teamId, 0);
  const kind: 'shop' | 'cutoff' | 'other' = b.kind === 'shop' ? 'shop' : b.kind === 'cutoff' ? 'cutoff' : 'other';
  let delta = kind === 'shop' ? 0 : money(b.delta);
  let reason = str(b.reason, 200) || '手动调整';
  if (kind === 'cutoff') {
    // cutoff: deductions only
    if (delta >= 0) throw bad('熔断只能扣除');
    reason = `熔断${str(b.reason, 200) ? '：' + str(b.reason, 200) : ''}`;
  }
  let item: { id: number; name: string; price: number } | null = null;
  if (!teamId) throw bad('缺少队伍');
  if (kind === 'shop') {
    // shop purchase: coin mode only; amount fixed to the item price, deduction only; must be on a shop-open leg
    if (currencyMode() !== 'coin') throw bad('只有货币模式的比赛才有商店');
    item = get<{ id: number; name: string; price: number }>('SELECT id, name, price FROM shop_items WHERE id = ? AND event_id = ?', int(b.itemId, 0), c.get('event').id) ?? null;
    if (!item) throw notFound('商品不存在');
    delta = -item.price;
    reason = `购买：${item.name}`;
  }
  if (!delta) throw bad('金额不能为 0');
  if (!canAdjustCurrency(user, episodeId ?? 0, teamId, int(b.legId, 0) || null)) throw forbidden('主办可操作所有队伍；跟队只能操作所跟队伍；站点只能记在自己驻守的环节上');
  const team = get('SELECT * FROM teams WHERE id = ?', teamId);
  if (!team || team.event_id !== c.get('event').id) throw notFound('队伍不存在');
  const epRow = episodeId ? get<{ status: string; code: string }>('SELECT status, code FROM episodes WHERE id = ?', episodeId) : null;
  if (epRow?.status === 'pending' && !isAdminRole(user.role)) throw bad(`${epRow.code} 尚未开始，开始赛段后才能操作经费`);
  { const r = editLockReason(user, epRow, team as { status: string }); if (r) throw forbidden(r); }
  const legId = int(b.legId, 0) || null; // no leg = "other", hosts only (same as penalties)
  if (!legId && !isHostRole(user.role)) throw forbidden('“其他”环节只能由主办选择，请选择具体环节');
  const legRow = legId ? get('SELECT id, shop_open FROM legs WHERE id = ? AND episode_id = ?', legId, episodeId ?? 0) : null;
  if (legId && !legRow) throw notFound('环节不存在');
  if (kind === 'shop') {
    if (!legRow) throw bad('商店购买必须选择所在环节');
    if (!legRow.shop_open) throw bad('该环节没有开放商店');
  }
  const balance = team.currency + delta;
  const id = tx(() => {
    // stock is checked inside the transaction so two crews cannot sell the last unit twice
    if (kind === 'shop' && item) {
      const stock = shopStock('s.leg_id = ? AND s.shop_item_id = ?', legId!, item.id)[0];
      if (!stock) throw bad(`本环节的商店不卖「${item.name}」`);
      if (stock.remaining === 0) throw bad(`「${item.name}」在本环节已售罄`);
    }
    run('UPDATE teams SET currency = ? WHERE id = ?', balance, teamId);
    const r = run(
      'INSERT INTO currency_ledger(episode_id, team_id, delta, balance_after, reason, operator_id, operator_name, created_at, leg_id, kind, item_id, item_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      episodeId, teamId, delta, balance, reason, user.id, user.displayName, now(), legId, kind, item?.id ?? null, item?.name ?? null,
    );
    const newId = Number(r.lastInsertRowid);
    // mirror the purchase as an item "gained" row
    if (kind === 'shop' && item) run('INSERT INTO item_log(episode_id, team_id, leg_id, item_name, delta, kind, ledger_id, operator_id, operator_name, created_at) VALUES (?,?,?,?,1,?,?,?,?,?)', episodeId, teamId, legId, item.name, 'buy', newId, user.id, user.displayName, now());
    settleDebt(teamId, newId);
    return newId;
  });
  audit(user, kind === 'shop' ? 'shop_buy' : 'currency', 'team', teamId, { currency: fromCents(team.currency) }, { delta: fromCents(delta), balance: fromCents(balance), reason, item: item?.name });
  if (kind === 'shop') notify('episodes', episodeId); // remaining stock is part of the leg data
  notify('ledger', episodeId);
  notify('teams');
  // the balance after a possible debt settlement
  return c.json({ id, balance: fromCents(get<{ currency: number }>('SELECT currency FROM teams WHERE id = ?', teamId)!.currency) });
});

/** Revert a money change: only its author or a host may do so */
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
  if (orig.debt_of) throw bad('欠费结算会随引起欠费的那笔变动一起撤销；要免掉这次罚时，请在罚时记录里撤销');
  const team = get('SELECT * FROM teams WHERE id = ?', orig.team_id);
  if (!team) throw notFound('队伍不存在');
  const newId = tx(() => {
    const newId = writeRevert(orig, user);
    settleDebt(orig.team_id, newId);
    return newId;
  });
  const balance = get<{ currency: number }>('SELECT currency FROM teams WHERE id = ?', orig.team_id)!.currency;
  audit(user, 'currency_revert', 'ledger', id, { delta: fromCents(orig.delta) }, { revertId: newId, balance: fromCents(balance) });
  // reverting a purchase voids that item's "gained" row: write the matching reverse row in the item log
  if (orig.kind === 'shop') {
    const got = get<{ id: number }>('SELECT id FROM item_log WHERE ledger_id = ? AND reverts_id IS NULL AND reverted = 0', id);
    if (got) tx(() => { run('UPDATE item_log SET reverted = 1 WHERE id = ?', got.id); run('INSERT INTO item_log(episode_id, team_id, leg_id, item_name, delta, kind, ledger_id, operator_id, operator_name, created_at, reverts_id) VALUES (?,?,?,?,-1,?,?,?,?,?,?)', orig.episode_id, orig.team_id, orig.leg_id ?? null, orig.item_name, 'buy', newId, user.id, user.displayName, now(), got.id); });
  }
  // reverting a cutoff charge voids that use: delete the use record so the countdown is recomputed from what remains
  if (orig.kind === 'cutoff') {
    const u = get<{ id: number }>('SELECT id FROM cutoff_uses WHERE ledger_id = ?', id);
    if (u) { run('DELETE FROM cutoff_uses WHERE id = ?', u.id); audit(user, 'cutoff_use_delete', 'team', orig.team_id, { useId: u.id, byLedgerRevert: id }); notify('progress', orig.episode_id); }
  }
  if (orig.kind === 'shop') notify('episodes', orig.episode_id); // the unit goes back into the leg's stock
  notify('ledger', orig.episode_id);
  notify('teams');
  return c.json({ id: newId, balance: fromCents(balance) });
});

// ================= Item log: gains (mirrored from purchases), uses, reverts =================
export function listItemLog(eventId: number, episodeId?: number | null, teamId?: number | null) {
  const conds = ['t.event_id = ?']; const params: (number | string)[] = [eventId];
  if (episodeId) { conds.push('l.episode_id = ?'); params.push(episodeId); }
  if (teamId) { conds.push('l.team_id = ?'); params.push(teamId); }
  const labels = teamLabelMap();
  return all<any>(
    `SELECT l.*, t.name AS team_name, g.name AS leg_name, lt.tip AS tip_text, ef.status AS effect_status, ef.kind AS effect_kind, ef.target_team_id AS effect_target
     FROM item_log l JOIN teams t ON t.id = l.team_id LEFT JOIN legs g ON g.id = l.leg_id LEFT JOIN leg_tips lt ON lt.id = l.tip_id LEFT JOIN twist_effects ef ON ef.item_log_id = l.id
     WHERE ${conds.join(' AND ')} ORDER BY l.created_at DESC, l.id DESC LIMIT 500`, ...params,
  ).map((r) => {
    // a fired twist card shows whom it hit, or that it is still waiting / missed
    const effectLabel = r.effect_status === 'pending' || r.effect_status === 'queued' ? '待命中' : r.effect_status === 'void' ? '落空' : null;
    const target = r.target_team_id ?? (r.effect_status && !['void', 'pending', 'queued'].includes(r.effect_status) ? r.effect_target : null);
    return { ...r, team_name: labels.get(r.team_id) ?? r.team_name, target_name: target ? labels.get(target) ?? null : null, target_label: r.target_label ?? effectLabel };
  });
}
/** A revealed 锦囊 tip is shown only to hosts and the team's follow in that episode */
ledgerRoutes.get('/item-log', (c) => {
  const user = c.get('user');
  const items = listItemLog(c.get('event').id, Number(c.req.query('episodeId')) || null, Number(c.req.query('teamId')) || null);
  if (!isHostRole(user.role)) for (const r of items) if (r.tip_text !== null && getAssignment(r.episode_id ?? 0, user.id)?.team_id !== r.team_id) r.tip_text = null;
  return c.json({ items });
});

/** The 锦囊 card ("xx的锦囊卡") is recognised by name: using it records the 锦囊 id typed by the crew */
export const isTipItem = (name: string) => name.includes('锦囊');

/** Use one bag item: no balance change, only an item-log row; attributed to the team's current leg. Items marked as needing a target take another team of the event */
ledgerRoutes.post('/items/use', async (c) => {
  const user = c.get('user');
  const b = await body(c);
  const episodeId = int(b.episodeId, 0) || null;
  const teamId = int(b.teamId, 0);
  const itemName = str(b.itemName, 100);
  if (!teamId || !itemName) throw bad('缺少队伍或物品');
  if (currencyMode() !== 'coin') throw bad('只有货币模式的比赛才有道具');
  const team = get('SELECT * FROM teams WHERE id = ?', teamId);
  if (!team || team.event_id !== c.get('event').id) throw notFound('队伍不存在');
  let legId = int(b.legId, 0) || null;
  if (!canAdjustCurrency(user, episodeId ?? 0, teamId, legId)) throw forbidden('主办可操作所有队伍；跟队只能操作所跟队伍');
  const epRow = episodeId ? get<{ status: string; code: string }>('SELECT status, code FROM episodes WHERE id = ?', episodeId) : null;
  if (epRow?.status === 'pending' && !isAdminRole(user.role)) throw bad(`${epRow.code} 尚未开始`);
  { const r = editLockReason(user, epRow, team as { status: string }); if (r) throw forbidden(r); }
  if (inventoryCount(teamId, itemName) < 1) throw bad(`背包里没有「${itemName}」`);
  // twist cards with logic decide by themselves: directed ones always need a target, missile / 让行 never take one
  const twist = kindOf(itemName);
  const needsTarget = isDirected(itemName) || !twist && !!get<{ needs_target: number }>('SELECT needs_target FROM shop_items WHERE event_id = ? AND name = ?', c.get('event').id, itemName)?.needs_target;
  const targetId = int(b.targetTeamId, 0) || null;
  if (needsTarget && !targetId) throw bad(`使用「${itemName}」需要选择对象队伍`);
  if (targetId) {
    const target = get<{ event_id: number }>('SELECT event_id FROM teams WHERE id = ?', targetId);
    if (!target || target.event_id !== c.get('event').id) throw bad('对象队伍不存在');
    if (targetId === teamId) throw bad('对象不能是本队');
  }
  const currentLeg = episodeId ? get<{ leg_id: number }>(
    `SELECT p.leg_id FROM progress p JOIN legs l ON l.id = p.leg_id WHERE p.episode_id = ? AND p.team_id = ? AND p.arrived_at IS NOT NULL AND p.completed_at IS NULL ORDER BY l.sort DESC, l.id DESC LIMIT 1`, episodeId, teamId,
  )?.leg_id ?? null : null;
  if (!legId) legId = currentLeg;
  checkUse(episodeId, teamId, itemName, needsTarget ? targetId : null, currentLeg);
  // 锦囊: usable at any time, the crew types the id it is used on (no tips set up on legs, nothing checked or revealed)
  const tipCode = isTipItem(itemName) ? str(b.tipCode, 50) : '';
  if (isTipItem(itemName) && !tipCode) throw bad(`使用「${itemName}」需要填写锦囊 id`);
  const target = needsTarget || !twist ? targetId : null;
  // 盗窃: the card drawn offline from the target's bag (empty = nothing taken)
  const stolen = isSteal(itemName) && target ? str(b.stealItem, 100) : '';
  if (stolen && inventoryCount(target!, stolen) < 1) throw bad(`${teamLabelMap().get(target!) ?? ''} 的背包里没有「${stolen}」`);
  const r = run('INSERT INTO item_log(episode_id, team_id, leg_id, item_name, delta, kind, operator_id, operator_name, created_at, target_team_id, tip_id, target_label) VALUES (?,?,?,?,-1,?,?,?,?,?,?,?)',
    episodeId, teamId, legId, itemName, 'use', user.id, user.displayName, now(), target, null, tipCode || null);
  if (stolen) {
    // the stolen card moves between the bags: out of the target's, into the user's (both linked to this use)
    const useId = Number(r.lastInsertRowid);
    run('INSERT INTO item_log(episode_id, team_id, leg_id, item_name, delta, kind, operator_id, operator_name, created_at, target_team_id, link_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)', episodeId, target, legId, stolen, -1, 'stolen', user.id, user.displayName, now(), teamId, useId);
    run('INSERT INTO item_log(episode_id, team_id, leg_id, item_name, delta, kind, operator_id, operator_name, created_at, target_team_id, link_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)', episodeId, teamId, legId, stolen, 1, 'steal', user.id, user.displayName, now(), target, useId);
  }
  audit(user, 'item_use', 'team', teamId, undefined, { item: itemName, legId, targetTeamId: targetId, tip: tipCode || undefined, stolen });
  afterUse(episodeId, teamId, itemName, Number(r.lastInsertRowid), target, currentLeg);
  notify('ledger', episodeId); notify('teams');
  return c.json({ id: Number(r.lastInsertRowid) });
});

/** Revert an item use: the item returns to the bag. Purchases are reverted through the ledger (which syncs here) */
ledgerRoutes.post('/item-log/:id/revert', (c) => {
  const id = int(c.req.param('id'), 0);
  const user = c.get('user');
  const orig = get('SELECT * FROM item_log WHERE id = ?', id);
  if (!orig) throw notFound('记录不存在');
  const team = get('SELECT * FROM teams WHERE id = ?', orig.team_id);
  if (!team || team.event_id !== c.get('event').id) throw notFound('队伍不存在');
  if (orig.kind === 'buy') throw bad('购买请在经费流水里撤销，道具会同步退回');
  if (orig.kind === 'steal' || orig.kind === 'stolen') throw bad('请撤销这次「盗窃」的使用记录，卡片会同步退回');
  // undoing a 盗窃 also moves the stolen card back (only while the thief still holds it)
  const moved = all('SELECT * FROM item_log WHERE link_id = ? AND reverted = 0 AND reverts_id IS NULL', id);
  const gained = moved.find((m) => m.kind === 'steal');
  if (gained && inventoryCount(gained.team_id, gained.item_name) < 1) throw bad(`偷来的「${gained.item_name}」已经用掉，请先撤销那次使用`);
  if (!isHostRole(user.role) && orig.operator_id !== user.id) throw forbidden('只有发出这条记录的本人或主办可以撤销');
  { const r = editLockReason(user, orig.episode_id ? get<{ status: string; code: string }>('SELECT status, code FROM episodes WHERE id = ?', orig.episode_id) : null, team as { status: string }); if (r) throw forbidden(r); }
  if (orig.reverted) throw bad('这条记录已经撤销过了');
  if (orig.reverts_id) throw bad('撤销记录本身不能再撤销');
  beforeRevertUse(orig as { id: number; effect_id: number | null });
  const newId = tx(() => {
    run('UPDATE item_log SET reverted = 1 WHERE id = ?', id);
    const r = run('INSERT INTO item_log(episode_id, team_id, leg_id, item_name, delta, kind, operator_id, operator_name, created_at, reverts_id, target_team_id, tip_id, target_label) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', orig.episode_id, orig.team_id, orig.leg_id, orig.item_name, -orig.delta, orig.kind, user.id, user.displayName, now(), id, orig.target_team_id ?? null, orig.tip_id ?? null, orig.target_label ?? null);
    for (const m of moved) {
      run('UPDATE item_log SET reverted = 1 WHERE id = ?', m.id);
      run('INSERT INTO item_log(episode_id, team_id, leg_id, item_name, delta, kind, operator_id, operator_name, created_at, reverts_id, target_team_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)', m.episode_id, m.team_id, m.leg_id, m.item_name, -m.delta, m.kind, user.id, user.displayName, now(), m.id, m.target_team_id);
    }
    return Number(r.lastInsertRowid);
  });
  audit(user, 'item_use_revert', 'team', orig.team_id, { id }, { revertId: newId });
  notify('ledger', orig.episode_id); notify('teams');
  return c.json({ id: newId });
});
