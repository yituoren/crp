import { all, get, run, tx, now } from './db.js';
import { audit, notify, bad, forbidden } from './util.js';
import type { AuthUser } from './auth.js';
import { teamLabelMap, inventoryCount } from './routes/teams.js';
import { upsertProgress } from './progressCore.js';

/**
 * Twist cards with built-in logic, recognised by item name.
 *  - 一号飞弹 (missile): fired from the bag (not any more once a team has the check-in clue, i.e. finished the second-to-last leg), it waits for the first team to
 *    arrive (Route Info "arrival") at a destination no team has reached yet; that team's next leg starts 15 minutes later. All crew are
 *    told when it is fired.
 *  - 护盾 (shield) cancels an effect on the team; 反弹 (reflect) turns it on the card's user, who gets the same effect at its own next
 *    arrival (a reflected effect cannot be reflected again, only shielded).
 * Rules: in one episode a team is hit by each kind of twist card at most once (shield / reflect do not count; a reflected effect that
 * lands counts for its new target).
 * Publicity: the public announcement names the user when a missile lands; 决斗 / 盗窃 / 验牌 name user and target on use, 合流 the
 * user. Settlement details (target of a missile, shield, reflect, void) are never announced: only the hit team's follow is told. Effects meeting the same team are settled in firing order: if the first is shielded or reflected the next one
 * comes, once one lands the rest are void. 让路 / 让行 can be used once per episode per team.
 *
 * Effect rows: pending (no target yet: a fired missile; or a reflected one waiting for its target's next arrival) → hit → shielded /
 * reflected, or void; queued = waiting behind another effect on the same team at the same arrival; cancelled = the use was reverted.
 */
export const isMissile = (name: string) => name.includes('飞弹');
export const isShield = (name: string) => name.includes('护盾');
export const isReflect = (name: string) => name.includes('反弹');
export const oncePerEpisode = (name: string) => ['让路', '让行'].some((k) => name.includes(k));

export type Effect = {
  id: number; episode_id: number; item_name: string; item_log_id: number | null; source_team_id: number; target_team_id: number | null;
  leg_id: number | null; mode: 'delay_start'; status: string; wait_min: number; wait_from: string | null; wait_until: string | null;
  reflected_from_id: number | null; decided: number; note: string; created_at: string; resolved_at: string | null;
};

const SYSTEM: AuthUser = { id: 0, username: 'system', displayName: '系统', role: 'admin' };
const addMin = (iso: string, m: number) => new Date(new Date(iso).getTime() + m * 60000).toISOString();
const hm = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
const legLabel = (legId: number | null) => { const l = legId ? get<{ type: string; name: string }>('SELECT type, name FROM legs WHERE id = ?', legId) : null; return l ? (l.type === 'RI' ? `→ ${l.name}` : l.name) : ''; };
const eventOf = (episodeId: number) => get<{ event_id: number }>('SELECT event_id FROM episodes WHERE id = ?', episodeId)!.event_id;
const label = (teamId: number | null) => (teamId ? teamLabelMap().get(teamId) ?? '' : '');

export function listEffects(episodeId: number) {
  const labels = teamLabelMap();
  return all<Effect>('SELECT * FROM twist_effects WHERE episode_id = ? ORDER BY id', episodeId)
    .map((e) => ({ ...e, source_name: labels.get(e.source_team_id) ?? '', target_name: e.target_team_id ? labels.get(e.target_team_id) ?? '' : null }));
}

/** Whether a team has already been hit by this kind of twist card in this episode */
export function hitThisEpisode(episodeId: number, teamId: number, itemName: string) {
  return !!get("SELECT 1 FROM twist_effects WHERE episode_id = ? AND target_team_id = ? AND item_name = ? AND status = 'hit'", episodeId, teamId, itemName);
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

/** Card use hook (inside the use request): per-episode limits, and no missile once a team has the check-in clue */
export function checkUse(episodeId: number | null, teamId: number, itemName: string) {
  if (!episodeId) { if (isMissile(itemName)) throw bad('请先选择赛段'); return; }
  if (isMissile(itemName) && checkinClueTaken(episodeId)) throw bad('已有队伍领到签到线索（完成倒数第二个环节），一号飞弹不能再使用');
  if (oncePerEpisode(itemName) && get('SELECT 1 FROM item_log WHERE episode_id = ? AND team_id = ? AND item_name = ? AND kind = ? AND reverted = 0 AND reverts_id IS NULL', episodeId, teamId, itemName, 'use')) {
    throw bad(`「${itemName}」每个赛段每队只能使用一次`);
  }
}
/**
 * Card use hook (after the use is written): a missile becomes a pending effect (announced when it lands);
 * 决斗 / 盗窃 / 验牌 announce user and target, 合流 the user
 */
export function afterUse(episodeId: number | null, teamId: number, itemName: string, itemLogId: number, targetTeamId: number | null) {
  if (!episodeId) return;
  if (['决斗', '盗窃', '验牌'].some((k) => itemName.includes(k))) announce(episodeId, `${label(teamId)} 对 ${label(targetTeamId)} 使用了「${itemName}」`, 'all');
  if (itemName.includes('合流')) announce(episodeId, `${label(teamId)} 使用了「${itemName}」`, 'all');
  if (!isMissile(itemName)) return;
  const r = run('INSERT INTO twist_effects(episode_id, item_name, item_log_id, source_team_id, status, created_at) VALUES (?,?,?,?,?,?)', episodeId, itemName, itemLogId, teamId, 'pending', now());
  audit(SYSTEM, 'twist_fire', 'twist_effect', Number(r.lastInsertRowid), undefined, { itemName, teamId });
  notify('progress', episodeId);
}
/** Reverting a card use: a pending missile is withdrawn; once it has a target, or for a shield / reflect answer, it cannot be reverted */
export function beforeRevertUse(itemLog: { id: number; effect_id: number | null }) {
  if (itemLog.effect_id) throw bad('这次使用回应了一次飞弹，不能撤销');
  const ef = get<Effect>('SELECT * FROM twist_effects WHERE item_log_id = ?', itemLog.id);
  if (!ef) return;
  if (ef.status !== 'pending' || ef.target_team_id) throw bad('飞弹已经结算，不能撤销');
  run("UPDATE twist_effects SET status = 'cancelled', resolved_at = ? WHERE id = ?", now(), ef.id);
  notify('progress', ef.episode_id);
}

/** Which answers the target team can give right now (empty when there is nothing to decide) */
export function answerOptions(ef: Effect) {
  if (ef.status !== 'hit' || ef.decided || !ef.target_team_id || !ef.wait_until || Date.now() >= new Date(ef.wait_until).getTime()) return { shield: false, reflect: false };
  const names = heldItems(ef.target_team_id);
  return {
    shield: names.some(isShield),
    reflect: names.some(isReflect) && !ef.reflected_from_id && ef.source_team_id !== ef.target_team_id,
  };
}
const heldItems = (teamId: number) => all<{ name: string; n: number }>('SELECT item_name AS name, SUM(delta) AS n FROM item_log WHERE team_id = ? AND reverted = 0 AND reverts_id IS NULL GROUP BY item_name HAVING n > 0', teamId).map((i) => i.name);

/**
 * Land an effect on a team: its leg `legId` starts wait_min after `from` (the arrival). The target's follow is asked about shield /
 * reflect in the pop-up; when the team has neither, the effect is final at once and the effects queued behind it are void.
 */
function landEffect(ef: Effect, teamId: number, legId: number, from: string) {
  const until = addMin(from, ef.wait_min);
  run("UPDATE twist_effects SET status = 'hit', target_team_id = ?, leg_id = ?, mode = 'delay_start', wait_from = ?, wait_until = ?, resolved_at = ? WHERE id = ?", teamId, legId, from, until, now(), ef.id);
  const p = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', ef.episode_id, teamId, legId);
  if (p && !p.completed_at) upsertProgress(ef.episode_id, teamId, legId, { ...p, arrived_at: until }, SYSTEM.id);
  const by = ef.reflected_from_id ? `被 ${label(ef.source_team_id)} 反弹回来的` : `被 ${label(ef.source_team_id)} 的`;
  announce(ef.episode_id, `${label(teamId)} ${by}「${ef.item_name}」击中：在「${legLabel(legId)}」原地等待 ${ef.wait_min} 分钟，${hm(until)} 后开始`, toFollow(ef.episode_id, teamId), ef.id);
  // public: only who used it, and only when it lands (a reflected one landing is a settlement detail)
  if (!ef.reflected_from_id) announce(ef.episode_id, `${label(ef.source_team_id)} 使用了「${ef.item_name}」`, 'all');
  const landed = get<Effect>('SELECT * FROM twist_effects WHERE id = ?', ef.id)!;
  const o = answerOptions(landed);
  if (!o.shield && !o.reflect) voidQueued(ef.episode_id, teamId);
}
/** One effect landed for good on a team: the ones queued behind it are void */
function voidQueued(episodeId: number, teamId: number) {
  for (const q of all<Effect>("SELECT * FROM twist_effects WHERE episode_id = ? AND target_team_id = ? AND status = 'queued' ORDER BY id", episodeId, teamId)) voidEffect(q, `${label(teamId)} 本赛段已被「${q.item_name}」作用`);
}
/** The landed effect was shielded / reflected: the next queued one (if any) lands on the same team at the same arrival */
function promoteQueued(episodeId: number, teamId: number, legId: number, from: string) {
  const q = get<Effect>("SELECT * FROM twist_effects WHERE episode_id = ? AND target_team_id = ? AND status = 'queued' ORDER BY id LIMIT 1", episodeId, teamId);
  if (q) landEffect(q, teamId, legId, from);
}

/**
 * Arrival hook: a team recorded "arrival" on a Route Info leg (inside the progress transaction, after chaining).
 * Candidates in firing order: reflected effects waiting for this team's next arrival, plus pending missiles when no other team has
 * arrived here yet. The first lands (unless the team was hit already this episode: then all are void), the rest queue behind it.
 */
export function onArrival(episodeId: number, teamId: number, legId: number, sort: number, endAt: string) {
  const frontier = !get('SELECT 1 FROM progress WHERE episode_id = ? AND leg_id = ? AND team_id != ? AND completed_at IS NOT NULL', episodeId, legId, teamId);
  const candidates = all<Effect>(
    `SELECT * FROM twist_effects WHERE episode_id = ? AND status = 'pending' AND (target_team_id = ? OR (target_team_id IS NULL AND ? = 1)) ORDER BY id`,
    episodeId, teamId, frontier ? 1 : 0,
  );
  if (!candidates.length) return;
  const nextLeg = get<{ id: number }>("SELECT id FROM legs WHERE episode_id = ? AND sort > ? AND type != 'SQ' ORDER BY sort, id LIMIT 1", episodeId, sort);
  if (!nextLeg || hitThisEpisode(episodeId, teamId, candidates[0]!.item_name)) {
    for (const ef of candidates) voidEffect(ef, nextLeg ? `${label(teamId)} 本赛段已被「${ef.item_name}」作用过` : '没有下一个环节', teamId);
  } else {
    const [first, ...rest] = candidates;
    for (const ef of rest) run("UPDATE twist_effects SET status = 'queued', target_team_id = ?, leg_id = ?, wait_from = ? WHERE id = ?", teamId, nextLeg.id, endAt, ef.id);
    landEffect(first!, teamId, nextLeg.id, endAt);
  }
  notify('progress', episodeId);
}

/** Undo the start delay (shielded / reflected): the leg starts at the original time again */
function liftDelay(ef: Effect) {
  if (!ef.leg_id || !ef.target_team_id || !ef.wait_from) return;
  const p = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', ef.episode_id, ef.target_team_id, ef.leg_id);
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
 * The target answers a landed effect (once, before the wait ends): accept keeps it; shield cancels it; reflect cancels it and sends the
 * same effect to the card's user, landing at that team's next arrival. After shield / reflect the next queued effect lands
 */
export function answerEffect(ef: Effect, answer: 'shield' | 'reflect' | 'accept', user: AuthUser) {
  if (ef.status !== 'hit' || ef.decided) throw bad('这次作用已经处理过了');
  const opts = answerOptions(ef);
  if (answer === 'shield' && !opts.shield) throw bad('现在不能使用护盾');
  if (answer === 'reflect' && !opts.reflect) throw bad(ef.reflected_from_id ? '被反弹的效果不能再反弹' : '现在不能使用反弹');
  tx(() => {
    run('UPDATE twist_effects SET decided = 1 WHERE id = ?', ef.id);
    if (answer === 'accept') { voidQueued(ef.episode_id, ef.target_team_id!); return; }
    const card = useCard(ef, ef.target_team_id!, answer === 'shield' ? isShield : isReflect, user);
    run('UPDATE twist_effects SET status = ?, note = ? WHERE id = ?', answer === 'shield' ? 'shielded' : 'reflected', card, ef.id);
    liftDelay(ef);
    if (answer === 'reflect') {
      // the card's user gets the same effect at its own next arrival
      const src = ef.source_team_id;
      const r = run('INSERT INTO twist_effects(episode_id, item_name, source_team_id, target_team_id, status, wait_min, reflected_from_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
        ef.episode_id, ef.item_name, ef.target_team_id, src, 'pending', ef.wait_min, ef.id, now());
      const back = get<Effect>('SELECT * FROM twist_effects WHERE id = ?', Number(r.lastInsertRowid))!;
      // the user's follow learns about it only when it lands
      if (hitThisEpisode(ef.episode_id, src, ef.item_name)) voidEffect(back, `${label(src)} 本赛段已被「${ef.item_name}」作用过`);
      else if (checkedIn(ef.episode_id).has(src)) voidEffect(back, `${label(src)} 已经签到`);
    }
    promoteQueued(ef.episode_id, ef.target_team_id!, ef.leg_id!, ef.wait_from!);
  });
  audit(user, `twist_${answer}`, 'twist_effect', ef.id);
  notify('progress', ef.episode_id); notify('ledger', ef.episode_id); notify('teams');
}

/**
 * Scheduler hook (every tick, cheap when nothing waits):
 *  - a landed effect whose wait ended without an answer counts as accepted: the ones queued behind it are void
 *  - once a team has checked in, missiles still waiting for a target can never land: void; so is a reflected one whose target checked in
 */
export function settleTwists() {
  const open = all<Effect>("SELECT * FROM twist_effects WHERE status IN ('pending', 'queued') ORDER BY id");
  if (!open.length) return;
  const t = now();
  const touched = new Set<number>();
  for (const q of open.filter((e) => e.status === 'queued')) {
    const blocker = get<Effect>("SELECT * FROM twist_effects WHERE episode_id = ? AND target_team_id = ? AND status = 'hit' ORDER BY id DESC LIMIT 1", q.episode_id, q.target_team_id);
    if (blocker && (blocker.decided || (blocker.wait_until && blocker.wait_until <= t))) { voidEffect(q, `${label(q.target_team_id)} 本赛段已被「${q.item_name}」作用`); touched.add(q.episode_id); }
  }
  for (const p of open.filter((e) => e.status === 'pending')) {
    const done = checkedIn(p.episode_id);
    if (!p.target_team_id && done.size) { voidEffect(p, '已有队伍签到'); touched.add(p.episode_id); }
    else if (p.target_team_id && done.has(p.target_team_id)) { voidEffect(p, `${label(p.target_team_id)} 已经签到`); touched.add(p.episode_id); }
  }
  for (const id of touched) notify('progress', id);
}

/** Answer permission: hosts, or the follow of the hit team */
export function assertCanAnswer(user: AuthUser, ef: Effect, isHost: boolean, followTeamId: number | null) {
  if (!isHost && followTeamId !== ef.target_team_id) throw forbidden('只有主办或被作用队伍的跟队可以处理');
}
