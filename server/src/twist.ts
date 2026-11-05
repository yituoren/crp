import { all, get, run, tx, now } from './db.js';
import { audit, notify, bad, forbidden } from './util.js';
import type { AuthUser } from './auth.js';
import { teamLabelMap, inventoryCount } from './routes/teams.js';
import { upsertProgress } from './progressCore.js';

/**
 * Twist cards with built-in logic, recognised by item name.
 *  - 一号飞弹 (missile): fired from the bag, it waits for the first team to arrive (Route Info "arrival") at a destination no team has
 *    reached yet; that team's next leg starts 15 minutes later. All teams are told when it is fired.
 *  - 护盾 (shield) cancels an effect on the team; 反弹 (reflect) turns it on the card's user, who then waits 15 minutes in place
 *    (a reflected effect cannot be reflected again, only shielded).
 * Rules: in one episode a team is hit by at most one twist effect; a missile whose target was already hit is void (shield / reflect do
 * not count, a reflected effect that lands counts for its new target). Missile / 让路 / 让行 can be used once per episode per team.
 */
export const isMissile = (name: string) => name.includes('飞弹');
export const isShield = (name: string) => name.includes('护盾');
export const isReflect = (name: string) => name.includes('反弹');
export const oncePerEpisode = (name: string) => ['飞弹', '让路', '让行'].some((k) => name.includes(k));

export type Effect = {
  id: number; episode_id: number; item_name: string; item_log_id: number | null; source_team_id: number; target_team_id: number | null;
  leg_id: number | null; mode: 'delay_start' | 'hold'; status: string; wait_min: number; wait_from: string | null; wait_until: string | null;
  reflected_from_id: number | null; decided: number; note: string; created_at: string; resolved_at: string | null;
};

const SYSTEM: AuthUser = { id: 0, username: 'system', displayName: '系统', role: 'admin' };
const addMin = (iso: string, m: number) => new Date(new Date(iso).getTime() + m * 60000).toISOString();
const hm = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
const legLabel = (legId: number | null) => { const l = legId ? get<{ type: string; name: string }>('SELECT type, name FROM legs WHERE id = ?', legId) : null; return l ? (l.type === 'RI' ? `→ ${l.name}` : l.name) : ''; };
const eventOf = (episodeId: number) => get<{ event_id: number }>('SELECT event_id FROM episodes WHERE id = ?', episodeId)!.event_id;

export function listEffects(episodeId: number) {
  const labels = teamLabelMap();
  return all<Effect>('SELECT * FROM twist_effects WHERE episode_id = ? ORDER BY id', episodeId)
    .map((e) => ({ ...e, source_name: labels.get(e.source_team_id) ?? '', target_name: e.target_team_id ? labels.get(e.target_team_id) ?? '' : null }));
}

/** Whether a team has already been hit by a twist effect in this episode */
export function hitThisEpisode(episodeId: number, teamId: number) {
  return !!get("SELECT 1 FROM twist_effects WHERE episode_id = ? AND target_team_id = ? AND status = 'hit'", episodeId, teamId);
}

function announce(episodeId: number, content: string, audience: string, effectId: number | null = null) {
  run('INSERT INTO announcements(content, level, created_by, created_at, audience, event_id, effect_id) VALUES (?,?,?,?,?,?,?)',
    content, 'warning', SYSTEM.displayName, now(), audience, eventOf(episodeId), effectId);
  notify('announcements');
}
const toFollow = (episodeId: number, teamId: number) => `follow:${episodeId}:${teamId}`;

/** Card use hook (inside the use request): checks the per-episode limit before the use is written */
export function checkUse(episodeId: number | null, teamId: number, itemName: string) {
  if (!episodeId) { if (isMissile(itemName)) throw bad('请先选择赛段'); return; }
  if (oncePerEpisode(itemName) && get('SELECT 1 FROM item_log WHERE episode_id = ? AND team_id = ? AND item_name = ? AND kind = ? AND reverted = 0 AND reverts_id IS NULL', episodeId, teamId, itemName, 'use')) {
    throw bad(`「${itemName}」每个赛段每队只能使用一次`);
  }
}
/** Card use hook (after the use is written): a missile becomes a pending effect and every team is told */
export function afterUse(episodeId: number | null, teamId: number, itemName: string, itemLogId: number) {
  if (!episodeId || !isMissile(itemName)) return;
  const r = run('INSERT INTO twist_effects(episode_id, item_name, item_log_id, source_team_id, status, created_at) VALUES (?,?,?,?,?,?)', episodeId, itemName, itemLogId, teamId, 'pending', now());
  audit(SYSTEM, 'twist_fire', 'twist_effect', Number(r.lastInsertRowid), undefined, { itemName, teamId });
  announce(episodeId, `${teamLabelMap().get(teamId) ?? ''} 使用了「${itemName}」：下一个领到还没有队伍领到的主线线索的队伍将原地等待 15 分钟`, 'all');
  notify('progress', episodeId);
}
/** Reverting a card use: a pending missile is withdrawn; once it has a target, or for a shield / reflect answer, it cannot be reverted */
export function beforeRevertUse(itemLog: { id: number; effect_id: number | null }) {
  if (itemLog.effect_id) throw bad('这次使用回应了一次飞弹，不能撤销');
  const ef = get<Effect>('SELECT * FROM twist_effects WHERE item_log_id = ?', itemLog.id);
  if (!ef) return;
  if (ef.status !== 'pending') throw bad('飞弹已经结算，不能撤销');
  run("UPDATE twist_effects SET status = 'cancelled', resolved_at = ? WHERE id = ?", now(), ef.id);
  notify('progress', ef.episode_id);
}

/**
 * Arrival hook: a team recorded "arrival" on a Route Info leg (inside the progress transaction, after chaining).
 * If no other team has arrived there yet, pending missiles resolve on this team: the first one hits (unless the team was already hit
 * this episode), the others are void. The hit delays the start of the next leg by 15 minutes.
 */
export function onArrival(episodeId: number, teamId: number, legId: number, sort: number, endAt: string) {
  const pending = all<Effect>("SELECT * FROM twist_effects WHERE episode_id = ? AND status = 'pending' ORDER BY id", episodeId);
  if (!pending.length) return;
  if (get('SELECT 1 FROM progress WHERE episode_id = ? AND leg_id = ? AND team_id != ? AND completed_at IS NOT NULL', episodeId, legId, teamId)) return;
  const nextLeg = get<{ id: number }>("SELECT id FROM legs WHERE episode_id = ? AND sort > ? AND type != 'SQ' ORDER BY sort, id LIMIT 1", episodeId, sort);
  const label = teamLabelMap().get(teamId) ?? '';
  for (const ef of pending) {
    const already = hitThisEpisode(episodeId, teamId);
    if (already || !nextLeg) {
      run("UPDATE twist_effects SET status = 'void', target_team_id = ?, note = ?, resolved_at = ? WHERE id = ?", teamId, already ? '目标本赛段已被作用' : '没有下一个环节', now(), ef.id);
      announce(episodeId, `「${ef.item_name}」落空：${label} 本赛段已经被作用过，飞弹无效`, toFollow(episodeId, ef.source_team_id));
      continue;
    }
    const until = addMin(endAt, ef.wait_min);
    run("UPDATE twist_effects SET status = 'hit', target_team_id = ?, leg_id = ?, mode = 'delay_start', wait_from = ?, wait_until = ?, resolved_at = ? WHERE id = ?", teamId, nextLeg.id, endAt, until, now(), ef.id);
    const np = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', episodeId, teamId, nextLeg.id);
    if (np && !np.completed_at) upsertProgress(episodeId, teamId, nextLeg.id, { ...np, arrived_at: until }, SYSTEM.id);
    const source = teamLabelMap().get(ef.source_team_id) ?? '';
    announce(episodeId, `${label} 被 ${source} 的「${ef.item_name}」击中：在「${legLabel(nextLeg.id)}」原地等待 15 分钟，${hm(until)} 后开始`, toFollow(episodeId, teamId), ef.id);
    announce(episodeId, `「${ef.item_name}」击中了 ${label}`, toFollow(episodeId, ef.source_team_id));
  }
  notify('progress', episodeId);
}

/** The leg a team is on right now (started, not finished; side quests count) */
function currentLegOf(episodeId: number, teamId: number) {
  return get<{ leg_id: number }>(
    `SELECT p.leg_id FROM progress p JOIN legs l ON l.id = p.leg_id WHERE p.episode_id = ? AND p.team_id = ? AND p.arrived_at IS NOT NULL AND p.completed_at IS NULL ORDER BY l.sort DESC, l.id DESC LIMIT 1`,
    episodeId, teamId,
  )?.leg_id ?? null;
}
/** Undo the start delay of a delay_start effect (shielded / reflected): the leg starts at the original time again */
function liftDelay(ef: Effect) {
  if (ef.mode !== 'delay_start' || !ef.leg_id || !ef.target_team_id || !ef.wait_from) return;
  const p = get('SELECT * FROM progress WHERE episode_id = ? AND team_id = ? AND leg_id = ?', ef.episode_id, ef.target_team_id, ef.leg_id);
  if (p && !p.completed_at && p.arrived_at === ef.wait_until) upsertProgress(ef.episode_id, ef.target_team_id, ef.leg_id, { ...p, arrived_at: ef.wait_from }, SYSTEM.id);
}
function useCard(ef: Effect, teamId: number, match: (n: string) => boolean, user: AuthUser) {
  const name = all<{ name: string; n: number }>('SELECT item_name AS name, SUM(delta) AS n FROM item_log WHERE team_id = ? AND reverted = 0 AND reverts_id IS NULL GROUP BY item_name HAVING n > 0', teamId).find((i) => match(i.name))?.name;
  if (!name || inventoryCount(teamId, name) < 1) throw bad('背包里没有这张卡');
  run('INSERT INTO item_log(episode_id, team_id, leg_id, item_name, delta, kind, operator_id, operator_name, created_at, effect_id) VALUES (?,?,?,?,-1,?,?,?,?,?)',
    ef.episode_id, teamId, ef.leg_id, name, 'use', user.id, user.displayName, now(), ef.id);
  return name;
}

/** Which answers the target team can give right now (empty when there is nothing to decide) */
export function answerOptions(ef: Effect) {
  if (ef.status !== 'hit' || ef.decided || !ef.target_team_id || !ef.wait_until || Date.now() >= new Date(ef.wait_until).getTime()) return { shield: false, reflect: false };
  const names = all<{ name: string; n: number }>('SELECT item_name AS name, SUM(delta) AS n FROM item_log WHERE team_id = ? AND reverted = 0 AND reverts_id IS NULL GROUP BY item_name HAVING n > 0', ef.target_team_id).map((i) => i.name);
  return {
    shield: names.some(isShield),
    reflect: names.some(isReflect) && !ef.reflected_from_id && ef.source_team_id !== ef.target_team_id,
  };
}

/** The target answers an effect: shield cancels it, reflect turns it on the source team (who waits 15 minutes from now), accept keeps it */
export function answerEffect(ef: Effect, answer: 'shield' | 'reflect' | 'accept', user: AuthUser) {
  if (ef.status !== 'hit' || ef.decided) throw bad('这次作用已经处理过了');
  const opts = answerOptions(ef);
  if (answer === 'shield' && !opts.shield) throw bad('现在不能使用护盾');
  if (answer === 'reflect' && !opts.reflect) throw bad(ef.reflected_from_id ? '被反弹的效果不能再反弹' : '现在不能使用反弹');
  const labels = teamLabelMap();
  const target = labels.get(ef.target_team_id!) ?? '';
  tx(() => {
    run('UPDATE twist_effects SET decided = 1 WHERE id = ?', ef.id);
    if (answer === 'accept') return;
    const card = useCard(ef, ef.target_team_id!, answer === 'shield' ? isShield : isReflect, user);
    run('UPDATE twist_effects SET status = ?, note = ? WHERE id = ?', answer === 'shield' ? 'shielded' : 'reflected', card, ef.id);
    liftDelay(ef);
    if (answer === 'shield') {
      announce(ef.episode_id, `${target} 用「${card}」挡下了「${ef.item_name}」`, toFollow(ef.episode_id, ef.source_team_id));
      return;
    }
    // Reflect: the source team waits in place from now, unless it was already hit this episode or is not on a leg
    const src = ef.source_team_id;
    const leg = currentLegOf(ef.episode_id, src);
    const t = now();
    if (hitThisEpisode(ef.episode_id, src) || !leg) {
      run('INSERT INTO twist_effects(episode_id, item_name, source_team_id, target_team_id, status, reflected_from_id, note, created_at, resolved_at) VALUES (?,?,?,?,?,?,?,?,?)',
        ef.episode_id, ef.item_name, ef.target_team_id, src, 'void', ef.id, leg ? '目标本赛段已被作用' : '目标不在环节中', t, t);
      announce(ef.episode_id, `${target} 用「${card}」反弹了「${ef.item_name}」，但 ${labels.get(src) ?? ''} ${leg ? '本赛段已经被作用过' : '不在环节中'}，反弹无效`, toFollow(ef.episode_id, src));
      return;
    }
    const until = addMin(t, ef.wait_min);
    const r = run('INSERT INTO twist_effects(episode_id, item_name, source_team_id, target_team_id, leg_id, mode, status, wait_min, wait_from, wait_until, reflected_from_id, created_at, resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ef.episode_id, ef.item_name, ef.target_team_id, src, leg, 'hold', 'hit', ef.wait_min, t, until, ef.id, t, t);
    announce(ef.episode_id, `${labels.get(src) ?? ''} 的「${ef.item_name}」被 ${target} 用「${card}」反弹：在「${legLabel(leg)}」原地等待 15 分钟，${hm(until)} 前不能记录`, toFollow(ef.episode_id, src), Number(r.lastInsertRowid));
  });
  audit(user, `twist_${answer}`, 'twist_effect', ef.id);
  notify('progress', ef.episode_id); notify('ledger', ef.episode_id); notify('teams');
}

/** Recording guard: a team held by a reflected effect cannot record on that leg before the wait ends */
export function holdReason(episodeId: number, teamId: number, legId: number, at: string): string | null {
  const ef = get<Effect>("SELECT * FROM twist_effects WHERE episode_id = ? AND target_team_id = ? AND leg_id = ? AND status = 'hit' AND mode = 'hold'", episodeId, teamId, legId);
  return ef?.wait_until && at < ef.wait_until ? `「${ef.item_name}」原地等待中，${hm(ef.wait_until)} 后才能记录` : null;
}

/** Answer permission: hosts, or the follow of the hit team */
export function assertCanAnswer(user: AuthUser, ef: Effect, isHost: boolean, followTeamId: number | null) {
  if (!isHost && followTeamId !== ef.target_team_id) throw forbidden('只有主办或被作用队伍的跟队可以处理');
}
