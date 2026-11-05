import { all, get, run, tx, now } from './db.js';
import { audit, notify, bad, forbidden } from './util.js';
import type { AuthUser } from './auth.js';
import { teamLabelMap, inventoryCount } from './routes/teams.js';
import { upsertProgress } from './progressCore.js';
import { addLedgerEntry } from './routes/ledger.js';
import { recomputeEliminations } from './elimination.js';

/**
 * Twist cards with built-in logic, recognised by item name.
 *  - 一号飞弹 (missile): fired from the bag (not any more once a team has the check-in clue, i.e. finished the second-to-last leg); it
 *    goes to the first team to arrive at a point no team has reached yet: that point starts 15 minutes later for it.
 *  - Point cards, played at the task point the user's team is on:
 *    回转 (U-turn, only at the first task point after a detour) sends the target, when it arrives here, back to the detour to do the
 *    other branch: its detour record reopens (choice "回转", the new completion shows in red) and everything after it is cleared;
 *    让路 (yield) makes the target wait 15 minutes when it arrives here; 让行 does that to the next team to arrive here.
 *    A target that has already passed the point makes 回转 / 让路 void.
 *  - 决斗 (duel), played at a task point against a team: once both have finished that task the faster net time (to the millisecond, no
 *    draw) wins 4 coins from the loser; coins the loser lacks become a penalty, 5 minutes per coin.
 *  - 盗窃 (steal): the cards are drawn offline; online the user picks the target and the item drawn, which moves between the bags
 *    (or nothing, when the target had no card or blocked it). A team can be stolen from any number of times.
 *  - 验牌 / 合流 and everything else are handled by hand.
 *  - Twist cards cannot be used in the event's last episode (the final).
 *  - 护盾 (shield) cancels a missile / 让路 / 让行 on the team; 反弹 (reflect) cancels it and gives the same effect to the card's user at
 *    its own next arrival (a reflected effect cannot be reflected again, only shielded). Neither works on 回转 or 决斗.
 * Settling a point when a team arrives (or its wait there ends): 回转 > 让路 > 让行 > missile, one at a time. A waiting team is free
 * again when its wait ends (or the effect is shielded / reflected) and the point is settled again for it, so a 让行 goes to whichever
 * team is free there first.
 * Rules: in one episode a team is hit by each kind of card at most once (shield / reflect do not count; a reflected effect that lands
 * counts for its new target): directed cards cannot pick such a team, undirected ones meeting it are void. 让路 / 让行 can be used once
 * per episode per team.
 * Publicity (announced to all crew): 回转 / 让路 when they land, and 决斗 / 盗窃 / 验牌 on use, name user and target; 让行 / missile when
 * they land, and 合流 on use, name the user. Settlement details (shield, reflect, void, duel result) only reach the teams' follows.
 *
 * Effect rows: pending (waiting: a fired missile, a card at a point, a duel, or a reflected effect waiting for its target's next
 * arrival) | queued (a missile assigned to the team that reached a new point first) → hit → shielded / reflected; void; cancelled.
 */
export type Kind = 'missile' | 'uturn' | 'yield' | 'yield_next' | 'duel';
export function kindOf(name: string): Kind | null {
  if (name.includes('飞弹')) return 'missile';
  if (name.includes('回转')) return 'uturn';
  if (name.includes('让路')) return 'yield';
  if (name.includes('让行')) return 'yield_next';
  if (name.includes('决斗')) return 'duel';
  return null;
}
export const isMissile = (name: string) => kindOf(name) === 'missile';
/** All twist cards, with or without built-in logic */
export const isTwistCard = (name: string) => ['飞弹', '回转', '让路', '让行', '决斗', '盗窃', '验牌', '合流'].some((k) => name.includes(k));
export const isSteal = (name: string) => name.includes('盗窃');
export const isShield = (name: string) => name.includes('护盾');
export const isReflect = (name: string) => name.includes('反弹');
/** Cards whose target is picked on use */
export const isDirected = (name: string) => ['uturn', 'yield', 'duel'].includes(kindOf(name) ?? '') || ['盗窃', '验牌'].some((k) => name.includes(k));
const oncePerEpisode = (name: string) => ['yield', 'yield_next'].includes(kindOf(name) ?? '');
const SHIELDABLE: Kind[] = ['missile', 'yield', 'yield_next'];
const DUEL_STAKE = 400; // 4 coins (coin amounts are stored × 100)
const DUEL_MIN_PER_COIN = 5;

export type Effect = {
  id: number; episode_id: number; item_name: string; kind: Kind; item_log_id: number | null; source_team_id: number; target_team_id: number | null;
  leg_id: number | null; point_leg_id: number | null; mode: 'delay_start' | 'uturn' | 'duel'; status: string; wait_min: number;
  wait_from: string | null; wait_until: string | null; reflected_from_id: number | null; decided: number; released: number; note: string;
  created_at: string; resolved_at: string | null;
};
type Leg = { id: number; episode_id: number; type: string; name: string; sort: number };

const SYSTEM: AuthUser = { id: 0, username: 'system', displayName: '系统', role: 'admin' };
const addMin = (iso: string, m: number) => new Date(new Date(iso).getTime() + m * 60000).toISOString();
const hm = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
const legOf = (id: number | null) => (id ? get<Leg>('SELECT id, episode_id, type, name, sort FROM legs WHERE id = ?', id) ?? null : null);
const legLabel = (id: number | null) => { const l = legOf(id); return l ? (l.type === 'RI' ? `→ ${l.name}` : l.name) : ''; };
const eventOf = (episodeId: number) => get<{ event_id: number }>('SELECT event_id FROM episodes WHERE id = ?', episodeId)!.event_id;
const label = (teamId: number | null) => (teamId ? teamLabelMap().get(teamId) ?? '' : '');
const progressOf = (episodeId: number, teamId: number, legId: number) => get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, teamId, legId);
const effect = (id: number) => get<Effect>('SELECT * FROM twist_effects WHERE id = ?', id)!;

export function listEffects(episodeId: number) {
  const labels = teamLabelMap();
  return all<Effect>('SELECT * FROM twist_effects WHERE episode_id = ? ORDER BY id', episodeId)
    .map((e) => ({ ...e, source_name: labels.get(e.source_team_id) ?? '', target_name: e.target_team_id ? labels.get(e.target_team_id) ?? '' : null }));
}

/** Whether a team has already been hit by this kind of card in this episode */
function hitBy(episodeId: number, teamId: number, kind: Kind) {
  return !!get("SELECT 1 FROM twist_effects WHERE episode_id = ? AND target_team_id = ? AND kind = ? AND status = 'hit'", episodeId, teamId, kind);
}
/** Teams that have checked in at the episode's pit stop (manual check-in or the pit stop's end record) */
function checkedIn(episodeId: number): Set<number> {
  const s = new Set<number>();
  for (const r of all<{ team_id: number }>("SELECT p.team_id FROM progress p JOIN legs l ON l.id = p.leg_id WHERE p.episode_id = ? AND l.type = 'PS' AND p.completed_at IS NOT NULL", episodeId)) s.add(r.team_id);
  for (const r of all<{ team_id: number }>('SELECT team_id FROM pitstop_results WHERE episode_id = ? AND checkin_at IS NOT NULL', episodeId)) s.add(r.team_id);
  return s;
}
/** A team has received the check-in clue: some team finished the episode's second-to-last main leg */
function checkinClueTaken(episodeId: number) {
  const leg = get<{ id: number }>("SELECT id FROM legs WHERE episode_id = ? AND type != 'SQ' ORDER BY sort DESC, id DESC LIMIT 1 OFFSET 1", episodeId);
  return !!leg && !!get('SELECT 1 FROM progress WHERE episode_id = ? AND leg_id = ? AND completed_at IS NOT NULL', episodeId, leg.id);
}
/** The detour right before a task point (only Route Info / side quests in between), or null */
function detourBefore(point: Leg): Leg | null {
  const prev = get<Leg>("SELECT id, episode_id, type, name, sort FROM legs WHERE episode_id = ? AND sort < ? AND type NOT IN ('RI', 'SQ') ORDER BY sort DESC, id DESC LIMIT 1", point.episode_id, point.sort);
  return prev?.type === 'DT' ? prev : null;
}

function announce(episodeId: number, content: string, audience: string, effectId: number | null = null) {
  run('INSERT INTO announcements(content, level, created_by, created_at, audience, event_id, effect_id) VALUES (?,?,?,?,?,?,?)',
    content, 'warning', SYSTEM.displayName, now(), audience, eventOf(episodeId), effectId);
  notify('announcements');
}
const toFollow = (episodeId: number, teamId: number) => `follow:${episodeId}:${teamId}`;
/** A void effect is only logged: settlement details are not announced */
function voidEffect(ef: Effect, note: string, targetId: number | null = ef.target_team_id) {
  run("UPDATE twist_effects SET status = 'void', target_team_id = ?, note = ?, resolved_at = ? WHERE id = ?", targetId, note, now(), ef.id);
}

// ---------------- Using a card ----------------

/** Card use hook (inside the use request, before the use is written): limits and where the card can be played */
export function checkUse(episodeId: number | null, teamId: number, itemName: string, targetId: number | null, currentLegId: number | null) {
  const kind = kindOf(itemName);
  if (!episodeId) { if (isTwistCard(itemName)) throw bad('请先选择赛段'); return; }
  const last = get<{ id: number; code: string }>('SELECT id, code FROM episodes WHERE event_id = (SELECT event_id FROM episodes WHERE id = ?) ORDER BY sort DESC, id DESC LIMIT 1', episodeId);
  if (last?.id === episodeId && isTwistCard(itemName)) throw bad(`最后一个赛段（${last.code}）中 twist 卡不生效，不能使用「${itemName}」`);
  if (kind === 'missile' && checkinClueTaken(episodeId)) throw bad('已有队伍领到签到线索（完成倒数第二个环节），一号飞弹不能再使用');
  if (oncePerEpisode(itemName) && get('SELECT 1 FROM item_log WHERE episode_id = ? AND team_id = ? AND item_name = ? AND kind = ? AND reverted = 0 AND reverts_id IS NULL', episodeId, teamId, itemName, 'use')) {
    throw bad(`「${itemName}」每个赛段每队只能使用一次`);
  }
  if (kind && kind !== 'missile') {
    const point = legOf(currentLegId);
    if (!point || ['RI', 'SQ', 'SL', 'PS'].includes(point.type)) throw bad(`「${itemName}」要在到达任务点时使用（本队当前不在任务点）`);
    if (kind === 'uturn' && !detourBefore(point)) throw bad('回转只能在绕道（DT）之后的下一个任务点使用');
  }
  // directed cards cannot pick a team already hit (or about to be) by this kind of card; 盗窃 has no such limit
  if (targetId && isDirected(itemName) && !isSteal(itemName)) {
    const taken = kind
      ? get("SELECT 1 FROM twist_effects WHERE episode_id = ? AND target_team_id = ? AND kind = ? AND status IN ('pending', 'queued', 'hit')", episodeId, targetId, kind)
      : get('SELECT 1 FROM item_log WHERE episode_id = ? AND target_team_id = ? AND item_name = ? AND kind = ? AND reverted = 0 AND reverts_id IS NULL', episodeId, targetId, itemName, 'use');
    if (taken) throw bad(`${label(targetId)} 本赛段已被「${itemName}」作用，不能选择`);
  }
}
/**
 * Card use hook (after the use is written): cards with logic become pending effects; 决斗 / 盗窃 / 验牌 announce user and target,
 * 合流 the user. 回转 / 让路 on a team that has already passed the point are void at once
 */
export function afterUse(episodeId: number | null, teamId: number, itemName: string, itemLogId: number, targetId: number | null, currentLegId: number | null) {
  if (!episodeId) return;
  if (['决斗', '盗窃', '验牌'].some((k) => itemName.includes(k))) announce(episodeId, `${label(teamId)} 对 ${label(targetId)} 使用了「${itemName}」`, 'all');
  if (itemName.includes('合流')) announce(episodeId, `${label(teamId)} 使用了「${itemName}」`, 'all');
  const kind = kindOf(itemName);
  if (!kind) return;
  const point = kind === 'missile' ? null : currentLegId;
  const r = run('INSERT INTO twist_effects(episode_id, item_name, kind, item_log_id, source_team_id, target_team_id, point_leg_id, leg_id, mode, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    episodeId, itemName, kind, itemLogId, teamId, targetId, point, kind === 'duel' ? point : null, kind === 'duel' ? 'duel' : kind === 'uturn' ? 'uturn' : 'delay_start', 'pending', now());
  const ef = effect(Number(r.lastInsertRowid));
  if ((kind === 'uturn' || kind === 'yield') && targetId && point && progressOf(episodeId, targetId, point)?.arrived_at) voidEffect(ef, `${label(targetId)} 已经通过该点位`);
  if (kind === 'duel') settleDuel(ef);
  audit(SYSTEM, 'twist_play', 'twist_effect', ef.id, undefined, { itemName, teamId, targetId, point });
  notify('progress', episodeId);
}
/** Reverting a card use: only while its effect is still waiting; shield / reflect answers cannot be reverted */
export function beforeRevertUse(itemLog: { id: number; effect_id: number | null }) {
  if (itemLog.effect_id) throw bad('这次使用回应了一张 twist 卡，不能撤销');
  const ef = get<Effect>('SELECT * FROM twist_effects WHERE item_log_id = ?', itemLog.id);
  if (!ef) return;
  if (ef.status !== 'pending') throw bad(`「${ef.item_name}」已经结算，不能撤销`);
  run("UPDATE twist_effects SET status = 'cancelled', resolved_at = ? WHERE id = ?", now(), ef.id);
  notify('progress', ef.episode_id);
}

// ---------------- Settling a point ----------------

/** Which answers the target team can give right now (empty when there is nothing to decide) */
export function answerOptions(ef: Effect) {
  if (ef.status !== 'hit' || ef.decided || !SHIELDABLE.includes(ef.kind) || !ef.target_team_id || !ef.wait_until || Date.now() >= new Date(ef.wait_until).getTime()) return { shield: false, reflect: false };
  const names = heldItems(ef.target_team_id);
  return {
    shield: names.some(isShield),
    reflect: names.some(isReflect) && !ef.reflected_from_id && ef.source_team_id !== ef.target_team_id,
  };
}
const heldItems = (teamId: number) => all<{ name: string; n: number }>('SELECT item_name AS name, SUM(delta) AS n FROM item_log WHERE team_id = ? AND reverted = 0 AND reverts_id IS NULL GROUP BY item_name HAVING n > 0', teamId).map((i) => i.name);

const KIND_ORDER: Kind[] = ['uturn', 'yield', 'yield_next', 'missile'];
/** Effects that could land on `teamId` at point `legId`, by kind */
function candidates(episodeId: number, teamId: number, legId: number, kind: Kind): Effect[] {
  const reflected = `(status = 'pending' AND target_team_id = ${teamId} AND reflected_from_id IS NOT NULL AND point_leg_id IS NULL)`;
  const where: Record<Kind, string> = {
    uturn: `status = 'pending' AND target_team_id = ${teamId} AND point_leg_id = ${legId}`,
    yield: `(status = 'pending' AND target_team_id = ${teamId} AND point_leg_id = ${legId}) OR ${reflected}`,
    yield_next: `(status = 'pending' AND target_team_id IS NULL AND point_leg_id = ${legId}) OR ${reflected}`,
    missile: `(status = 'queued' AND target_team_id = ${teamId} AND leg_id = ${legId}) OR ${reflected}`,
    duel: '0',
  };
  return all<Effect>(`SELECT * FROM twist_effects WHERE episode_id = ? AND kind = ? AND (${where[kind]}) ORDER BY id`, episodeId, kind);
}
/**
 * A team is free at point `legId` at time `t` (it just arrived, or its wait there ended): land the highest-priority effect waiting for
 * it. Kinds it was already hit by are void; one landing ends this round (its end frees the team again)
 */
function settleAt(episodeId: number, teamId: number, legId: number, t: string) {
  for (const kind of KIND_ORDER) {
    const list = candidates(episodeId, teamId, legId, kind);
    if (!list.length) continue;
    if (hitBy(episodeId, teamId, kind)) { for (const ef of list) voidEffect(ef, `${label(teamId)} 本赛段已被「${ef.item_name}」作用过`, teamId); continue; }
    const first = list[0]!;
    if (kind === 'uturn') { if (landUturn(first, teamId, legId, t)) return; continue; }
    landDelay(first, teamId, legId, t);
    return;
  }
}

/** Arrival hook: a team's start on a task point was just chained (it arrived there). A first arrival takes the waiting missiles */
export function onArrival(episodeId: number, teamId: number, legId: number, t: string) {
  const frontier = !get('SELECT 1 FROM progress WHERE episode_id = ? AND leg_id = ? AND team_id != ? AND arrived_at IS NOT NULL', episodeId, legId, teamId)
    && !get("SELECT 1 FROM twist_effects WHERE episode_id = ? AND kind = 'uturn' AND point_leg_id = ? AND status = 'hit'", episodeId, legId);
  if (frontier) run("UPDATE twist_effects SET status = 'queued', target_team_id = ?, leg_id = ? WHERE episode_id = ? AND kind = 'missile' AND status = 'pending' AND target_team_id IS NULL", teamId, legId, episodeId);
  settleAt(episodeId, teamId, legId, t);
  notify('progress', episodeId);
}

/** 让路 / 让行 / missile land: the point starts wait_min after `from`; the follow is asked about shield / reflect in the pop-up */
function landDelay(ef: Effect, teamId: number, legId: number, from: string) {
  const until = addMin(from, ef.wait_min);
  run("UPDATE twist_effects SET status = 'hit', target_team_id = ?, leg_id = ?, mode = 'delay_start', wait_from = ?, wait_until = ?, released = 0, resolved_at = ? WHERE id = ?", teamId, legId, from, until, now(), ef.id);
  const p = progressOf(ef.episode_id, teamId, legId);
  if (p && !p.completed_at) upsertProgress(ef.episode_id, teamId, legId, { ...p, arrived_at: until }, SYSTEM.id);
  const by = ef.reflected_from_id ? `被 ${label(ef.source_team_id)} 反弹回来的` : `被 ${label(ef.source_team_id)} 的`;
  announce(ef.episode_id, `${label(teamId)} ${by}「${ef.item_name}」作用：在「${legLabel(legId)}」原地等待 ${ef.wait_min} 分钟，${hm(until)} 后开始`, toFollow(ef.episode_id, teamId), ef.id);
  // public: a reflected one landing is a settlement detail
  if (!ef.reflected_from_id) announce(ef.episode_id, ef.kind === 'yield' ? `${label(ef.source_team_id)} 对 ${label(teamId)} 使用了「${ef.item_name}」` : `${label(ef.source_team_id)} 使用了「${ef.item_name}」`, 'all');
}

/**
 * 回转 lands: the team goes back to the detour before this point. The detour's completion reopens (choice "回转"; the new completion is
 * shown in red) and every record after it up to this point is cleared. Returns false (void) when the team has no detour record
 */
function landUturn(ef: Effect, teamId: number, legId: number, t: string): boolean {
  const point = legOf(legId)!;
  const dt = detourBefore(point);
  const dp = dt ? progressOf(ef.episode_id, teamId, dt.id) : null;
  if (!dt || !dp?.completed_at) { voidEffect(ef, `${label(teamId)} 没有绕道记录`, teamId); return false; }
  upsertProgress(ef.episode_id, teamId, dt.id, { ...dp, completed_at: null, detour_choice: '回转' }, SYSTEM.id);
  for (const p of all('SELECT p.* FROM progress p JOIN legs l ON l.id = p.leg_id WHERE p.episode_id = ? AND p.team_id = ? AND l.sort > ? AND l.sort <= ?', ef.episode_id, teamId, dt.sort, point.sort)) {
    upsertProgress(ef.episode_id, teamId, p.leg_id, { ...p, arrived_at: null, completed_at: null }, SYSTEM.id);
  }
  run("UPDATE twist_effects SET status = 'hit', leg_id = ?, mode = 'uturn', wait_from = ?, note = ?, resolved_at = ? WHERE id = ?", dt.id, t, `原选择：${dp.detour_choice ?? '-'}`, now(), ef.id);
  announce(ef.episode_id, `${label(teamId)} 被 ${label(ef.source_team_id)} 的「${ef.item_name}」作用：回到「${dt.name}」完成另一个分支（原选择：${dp.detour_choice ?? '-'}），完成后在「${dt.name}」重新记录完成`, toFollow(ef.episode_id, teamId), ef.id);
  announce(ef.episode_id, `${label(ef.source_team_id)} 对 ${label(teamId)} 使用了「${ef.item_name}」`, 'all');
  return true;
}

/** Undo the start delay (shielded / reflected): the point starts at the time the team was free again */
function liftDelay(ef: Effect) {
  if (!ef.leg_id || !ef.target_team_id || !ef.wait_from) return;
  const p = progressOf(ef.episode_id, ef.target_team_id, ef.leg_id);
  if (p && !p.completed_at && p.arrived_at === ef.wait_until) upsertProgress(ef.episode_id, ef.target_team_id, ef.leg_id, { ...p, arrived_at: ef.wait_from }, SYSTEM.id);
}
function useCard(ef: Effect, teamId: number, match: (n: string) => boolean, user: AuthUser) {
  const name = heldItems(teamId).find(match);
  if (!name || inventoryCount(teamId, name) < 1) throw bad('背包里没有这张卡');
  run('INSERT INTO item_log(episode_id, team_id, leg_id, item_name, delta, kind, operator_id, operator_name, created_at, effect_id) VALUES (?,?,?,?,-1,?,?,?,?,?)',
    ef.episode_id, teamId, ef.leg_id, name, 'use', user.id, user.displayName, now(), ef.id);
  return name;
}

/**
 * The target answers a landed effect (once, before the wait ends): accept keeps it; shield cancels it; reflect cancels it and gives the
 * same effect to the card's user at its next arrival. After shield / reflect the team is free at the point again right away
 */
export function answerEffect(ef: Effect, answer: 'shield' | 'reflect' | 'accept', user: AuthUser) {
  if (ef.status !== 'hit' || ef.decided) throw bad('这次作用已经处理过了');
  const opts = answerOptions(ef);
  if (answer === 'shield' && !opts.shield) throw bad('现在不能使用护盾');
  if (answer === 'reflect' && !opts.reflect) throw bad(ef.reflected_from_id ? '被反弹的效果不能再反弹' : '现在不能使用反弹');
  tx(() => {
    run('UPDATE twist_effects SET decided = 1 WHERE id = ?', ef.id);
    if (answer === 'accept') return;
    const card = useCard(ef, ef.target_team_id!, answer === 'shield' ? isShield : isReflect, user);
    run('UPDATE twist_effects SET status = ?, note = ?, released = 1 WHERE id = ?', answer === 'shield' ? 'shielded' : 'reflected', card, ef.id);
    liftDelay(ef);
    if (answer === 'reflect') {
      const src = ef.source_team_id;
      const r = run('INSERT INTO twist_effects(episode_id, item_name, kind, source_team_id, target_team_id, mode, status, wait_min, reflected_from_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ef.episode_id, ef.item_name, ef.kind, ef.target_team_id, src, 'delay_start', 'pending', ef.wait_min, ef.id, now());
      const back = effect(Number(r.lastInsertRowid));
      // the user's follow learns about it only when it lands
      if (hitBy(ef.episode_id, src, ef.kind)) voidEffect(back, `${label(src)} 本赛段已被「${ef.item_name}」作用过`);
      else if (checkedIn(ef.episode_id).has(src)) voidEffect(back, `${label(src)} 已经签到`);
    }
    settleAt(ef.episode_id, ef.target_team_id!, ef.leg_id!, ef.wait_from!);
  });
  audit(user, `twist_${answer}`, 'twist_effect', ef.id);
  notify('progress', ef.episode_id); notify('ledger', ef.episode_id); notify('teams');
}

// ---------------- Duel ----------------

/** Net time on a leg: end − start, minus the side quest run during it */
function netMs(episodeId: number, teamId: number, leg: Leg): number | null {
  const p = progressOf(episodeId, teamId, leg.id);
  if (!p?.arrived_at || !p.completed_at) return null;
  let ms = new Date(p.completed_at).getTime() - new Date(p.arrived_at).getTime();
  const br = get<{ id: number; type: string }>('SELECT id, type FROM legs WHERE episode_id = ? AND sort > ? ORDER BY sort, id LIMIT 1', episodeId, leg.sort);
  if (br?.type === 'SQ') { const b = progressOf(episodeId, teamId, br.id); if (b?.arrived_at && b.completed_at) ms -= new Date(b.completed_at).getTime() - new Date(b.arrived_at).getTime(); }
  return ms;
}
/** h:mm:ss.SSS (the duel compares to the millisecond) */
const fmtDur = (ms: number) => { const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; };
/** Settle a duel once both teams have finished its task: the loser pays 4 coins, missing coins become 5 minutes of penalty each */
function settleDuel(ef: Effect) {
  if (ef.status !== 'pending' || !ef.leg_id || !ef.target_team_id) return;
  const leg = legOf(ef.leg_id)!;
  const a = netMs(ef.episode_id, ef.source_team_id, leg), b = netMs(ef.episode_id, ef.target_team_id, leg);
  if (a === null || b === null) return;
  const times = `${label(ef.source_team_id)} 净用时 ${fmtDur(a)}，${label(ef.target_team_id)} 净用时 ${fmtDur(b)}`;
  let result: string;
  {
    // no draw: net times are compared to the millisecond, an exact tie goes to the team that finished first
    const finished = (t: number) => progressOf(ef.episode_id, t, leg.id)!.completed_at as string;
    const sourceWins = a !== b ? a < b : finished(ef.source_team_id) <= finished(ef.target_team_id!);
    const [win, lose] = sourceWins ? [ef.source_team_id, ef.target_team_id] : [ef.target_team_id, ef.source_team_id];
    const balance = get<{ currency: number }>('SELECT currency FROM teams WHERE id = ?', lose)!.currency;
    const pay = Math.min(DUEL_STAKE, Math.max(0, balance));
    const lackCoins = Math.ceil((DUEL_STAKE - pay) / 100);
    if (pay > 0) {
      addLedgerEntry({ episodeId: ef.episode_id, teamId: lose, delta: -pay, reason: `${ef.item_name}：输给 ${label(win)}`, legId: leg.id, kind: 'other', user: SYSTEM });
      addLedgerEntry({ episodeId: ef.episode_id, teamId: win, delta: pay, reason: `${ef.item_name}：赢 ${label(lose)}`, legId: leg.id, kind: 'other', user: SYSTEM });
    }
    if (lackCoins > 0) {
      run('INSERT INTO penalties(episode_id, team_id, minutes, reason, applied_by, applied_at, leg_id) VALUES (?,?,?,?,?,?,?)',
        ef.episode_id, lose, lackCoins * DUEL_MIN_PER_COIN, `${ef.item_name}：星币不足 ${lackCoins} 币，罚时`, SYSTEM.id, now(), leg.id);
    }
    result = `${label(win)} 胜，${label(lose)} 付给 ${label(win)} ${pay / 100} 币${lackCoins ? `，不足 ${lackCoins} 币罚时 ${lackCoins * DUEL_MIN_PER_COIN} 分钟` : ''}`;
  }
  run("UPDATE twist_effects SET status = 'hit', note = ?, resolved_at = ? WHERE id = ?", result, now(), ef.id);
  for (const t of [ef.source_team_id, ef.target_team_id]) announce(ef.episode_id, `「${ef.item_name}」结果（${leg.name}）：${times}；${result}`, toFollow(ef.episode_id, t));
  notify('ledger', ef.episode_id); notify('teams');
}
/** Completion hook: a team finished a leg; duels on it involving the team may now be settled */
export function onLegCompleted(episodeId: number, teamId: number, legId: number) {
  for (const ef of all<Effect>("SELECT * FROM twist_effects WHERE episode_id = ? AND kind = 'duel' AND status = 'pending' AND leg_id = ? AND (source_team_id = ? OR target_team_id = ?)", episodeId, legId, teamId, teamId)) settleDuel(ef);
}

// ---------------- Scheduler ----------------

/**
 * Every tick (cheap when nothing waits):
 *  - waits that ended free their team at the point again (the next effect there may land)
 *  - missiles still looking for a target are void once a team has checked in; so is a reflected effect whose target has checked in
 *  - cards aimed at a team that is out of the race, and everything still open in a finished episode, are void
 */
export function settleTwists() {
  const t = now();
  const touched = new Set<number>();
  for (const ef of all<Effect>("SELECT * FROM twist_effects WHERE status = 'hit' AND mode = 'delay_start' AND released = 0 AND wait_until <= ?", t)) {
    tx(() => {
      run('UPDATE twist_effects SET released = 1 WHERE id = ?', ef.id);
      settleAt(ef.episode_id, ef.target_team_id!, ef.leg_id!, ef.wait_until!);
    });
    touched.add(ef.episode_id);
  }
  const open = all<Effect & { ep_status: string; team_status: string | null }>(
    `SELECT f.*, e.status AS ep_status, tm.status AS team_status FROM twist_effects f JOIN episodes e ON e.id = f.episode_id LEFT JOIN teams tm ON tm.id = f.target_team_id
     WHERE f.status IN ('pending', 'queued') ORDER BY f.id`,
  );
  for (const ef of open) {
    let why: string | null = null;
    if (ef.ep_status === 'finished') why = '赛段已结束';
    else if (ef.team_status && ef.team_status !== 'alive') why = `${label(ef.target_team_id)} 已不在比赛中`;
    else if (ef.kind === 'missile' && ef.status === 'pending' && !ef.target_team_id && checkedIn(ef.episode_id).size) why = '已有队伍签到';
    else if (ef.reflected_from_id && ef.status === 'pending' && ef.target_team_id && checkedIn(ef.episode_id).has(ef.target_team_id)) why = `${label(ef.target_team_id)} 已经签到`;
    if (why) { voidEffect(ef, why); touched.add(ef.episode_id); }
  }
  for (const id of touched) {
    notify('progress', id);
    if (recomputeEliminations(eventOf(id))) notify('teams');
  }
}

/** Answer permission: hosts, or the follow of the hit team */
export function assertCanAnswer(user: AuthUser, ef: Effect, isHost: boolean, followTeamId: number | null) {
  if (!isHost && followTeamId !== ef.target_team_id) throw forbidden('只有主办或被作用队伍的跟队可以处理');
}
