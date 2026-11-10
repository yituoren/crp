// The event's data and the rules derived from it: a plain-JS port of the website's race store (web/src/stores/race.ts).
// Pages subscribe and re-render their view models when it changes (mini programs have no Vue reactivity).
const { api } = require('./api');
const auth = require('./auth');
const { legName } = require('./types');
const { fmtTime } = require('./time');

const MANDATORY_TYPES = new Set(['SL', 'RI', 'TI', 'DT', 'RB', 'Union', 'Shuffle', 'Trap', 'PS']);
const ACK_KEY = 'crp.ackedDepartureNotices';

const race = {
  episodes: [], teams: [], users: [], announcements: [], shopItems: [],
  currentEpisodeId: 0, assignments: [], progress: [], penalties: [], pitstop: [], ledger: [], itemLog: [], cutoffUses: [], effects: [],
  lastReadId: 0, loaded: false,
  // derived indexes, rebuilt after loads
  teamById: new Map(), legById: new Map(), legOrderIndex: new Map(),
  ackedPopups: new Set(wx.getStorageSync(ACK_KEY) || []),
};

// ---------- change notification ----------
const listeners = new Set();
/** Called after any data change; returns the unsubscribe function */
race.subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
let pending = false;
function changed() {
  rebuild();
  if (pending) return;
  pending = true; // several loads finishing together notify once
  setTimeout(() => { pending = false; listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }, 0);
}
function rebuild() {
  race.teamById = new Map(race.teams.map((t) => [t.id, t]));
  const legs = race.episodes.reduce((a, e) => a.concat(e.legs), []);
  race.legById = new Map(legs.map((l) => [l.id, l]));
  race.legOrderIndex = new Map(legs.map((l, i) => [l.id, i]));
}

// ---------- episode / assignment ----------
const epKey = () => `crp.currentEpisodeId.${auth.event.hash || 'none'}`;
race.currentEpisode = () => race.episodes.find((e) => e.id === race.currentEpisodeId) || race.episodes[0] || null;
race.aliveTeams = () => race.teams.filter((t) => t.status === 'alive');
race.myAssignment = () => race.assignments.find((a) => a.user_id === (auth.user && auth.user.id)) || null;
race.lastEpisodeId = () => (race.episodes.length ? race.episodes[race.episodes.length - 1].id : 0);
race.isLastEpisode = (episodeId) => (episodeId || (race.currentEpisode() || {}).id) === race.lastEpisodeId();
race.progressOf = (teamId, legId) => race.progress.find((p) => p.team_id === teamId && p.leg_id === legId) || null;

// ---------- twist effects, waits and settlement ----------
/** Twist effects that delayed the start of a team's leg (missile / 让路 / 让行), in the order they ran */
race.effectsOn = (teamId, legId) => race.effects
  .filter((e) => e.status === 'hit' && e.mode === 'delay_start' && e.target_team_id === teamId && e.leg_id === legId)
  .sort((a, b) => (a.wait_from || '').localeCompare(b.wait_from || ''));
/** The last of them (its end is when the team may start) */
race.effectOn = (teamId, legId) => { const l = race.effectsOn(teamId, legId); return l[l.length - 1] || null; };
/** A 回转 that sent the team back to this detour leg (its new completion shows in red) */
race.uturnOn = (teamId, legId) => race.effects.find((e) => e.status === 'hit' && e.mode === 'uturn' && e.target_team_id === teamId && e.leg_id === legId) || null;
/** Task start on a leg: the start time (after any twist wait) + the penalties waited out there (sudden death) */
race.taskStart = (teamId, legId) => {
  const p = race.progressOf(teamId, legId);
  if (!p || !p.arrived_at) return null;
  return p.settle_min ? new Date(new Date(p.arrived_at).getTime() + p.settle_min * 60000).toISOString() : p.arrived_at;
};
/** Still waiting on the spot (a twist effect, then the penalties settled there): the time it ends */
race.waitingUntil = (teamId, legId) => {
  const t = auth.nowMs;
  const e = race.effectOn(teamId, legId);
  if (e && e.wait_until && new Date(e.wait_until).getTime() > t) return e.wait_until;
  const p = race.progressOf(teamId, legId);
  const s = race.taskStart(teamId, legId);
  return p && p.settle_min && !p.completed_at && s && new Date(s).getTime() > t ? s : null;
};
/** What the team is waiting for (see waitingUntil): the twist card, or the settlement */
race.waitLabel = (teamId, legId) => {
  const e = race.effectOn(teamId, legId);
  return e && e.wait_until && new Date(e.wait_until).getTime() > auth.nowMs ? `「${e.item_name}」` : '结算补时罚时';
};
/** The start was moved (twist wait or settlement): shown in red */
race.startDelayed = (teamId, legId) => !!race.effectOn(teamId, legId) || !!(race.progressOf(teamId, legId) || {}).settle_min;
/** Net penalty minutes recorded on a leg for a team (reverts included as their negative rows) */
race.legPenalty = (teamId, legId) => race.penalties.reduce((s, x) => (x.team_id === teamId && x.leg_id === legId ? s + x.minutes : s), 0);

// ---------- team status ----------
/**
 * A team's status as an episode saw it: an elimination or withdrawal in a later episode does not count there. The stop
 * episode is the elimination leg's, or for a withdrawal the first locked leg's; a withdrawal with nothing locked counts everywhere.
 */
race.statusIn = (teamId, episodeId) => {
  const t = race.teamById.get(teamId);
  if (!t || t.status === 'alive') return 'alive';
  const stopLeg = t.status === 'eliminated' ? t.eliminated_leg_id : t.locked_from_leg_id;
  const leg = stopLeg ? race.legById.get(stopLeg) : null;
  const order = (id) => race.episodes.findIndex((e) => e.id === id);
  return leg && episodeId != null && order(leg.episode_id) > order(episodeId) ? 'alive' : t.status;
};
/** A team out of the race at this leg's episode: its unfinished legs show this instead of running */
race.stoppedLabel = (teamId, legId) => {
  const leg = race.legById.get(legId);
  const s = race.statusIn(teamId, leg && leg.episode_id);
  return s === 'eliminated' ? '已淘汰' : s === 'withdrawn' ? '已退赛' : null;
};
/** Whether a leg is locked for a team: legs after elimination or withdrawal cannot be recorded and show no actions */
race.isLocked = (teamId, legId) => {
  const t = race.teamById.get(teamId);
  if (!t || !t.locked_from_leg_id) return false;
  const from = race.legOrderIndex.get(t.locked_from_leg_id), cur = race.legOrderIndex.get(legId);
  return from !== undefined && cur !== undefined && cur >= from;
};

// ---------- permissions (admins ignore episode status) ----------
/** Current episode not started (and not admin): no records, money or penalties */
race.episodePending = () => !auth.isAdmin && (race.currentEpisode() || {}).status === 'pending';
/** Current episode finished (and not admin): everything is locked, admin only */
race.episodeFinished = () => !auth.isAdmin && (race.currentEpisode() || {}).status === 'finished';
/** Team eliminated / withdrawn (and not admin): all of its records are locked, admin only */
race.teamLocked = (teamId) => {
  if (auth.isAdmin) return false;
  const t = race.teamById.get(teamId);
  return !!t && t.status !== 'alive';
};
race.lockReason = (teamId) => {
  if (race.episodeFinished()) return '赛段已结束，只有管理员可以修改';
  if (teamId !== undefined && race.teamLocked(teamId)) return `该队伍已${race.teamById.get(teamId).status === 'withdrawn' ? '退赛' : '淘汰'}，只有管理员可以修改`;
  return null;
};
/** Time records: admin any; host any; follow only its team; stations never; nobody after the episode ends */
race.canRecord = (teamId) => {
  if (auth.isAdmin) return true;
  if (race.episodeFinished() || race.teamLocked(teamId)) return false;
  if (auth.isHost) return true;
  const a = race.myAssignment();
  return !!a && a.role === 'follow' && a.team_id === teamId;
};
/** Edit records: admin any; host any time except before start; follow only its team while running */
race.canEdit = (teamId) => {
  if (auth.isAdmin) return true;
  if (race.episodePending() || race.episodeFinished() || race.teamLocked(teamId)) return false;
  if (auth.isHost) return true;
  const a = race.myAssignment();
  return !!a && a.role === 'follow' && a.team_id === teamId;
};
race.canManagePenalty = () => {
  const a = race.myAssignment();
  return auth.isAdmin || (!race.episodeFinished() && (auth.isHost || (a && (a.role === 'station' || a.role === 'follow'))));
};
race.canManagePenaltyFor = (teamId) => {
  if (auth.isAdmin) return true;
  if (race.episodeFinished() || race.teamLocked(teamId)) return false;
  if (auth.isHost) return true;
  const a = race.myAssignment();
  return !!a && (a.role === 'station' || (a.role === 'follow' && a.team_id === teamId));
};
/** Revert penalties / money: only the author or a host */
race.canRevert = (authorId, teamId) => {
  if (auth.isAdmin) return true;
  if (race.episodeFinished() || (teamId !== undefined && race.teamLocked(teamId))) return false;
  if (auth.isHost) return true;
  return !!authorId && authorId === (auth.user && auth.user.id);
};
/** Money: host any; follow only its team; stations on their own legs (nobody but admins after the episode ends) */
race.canAdjustCurrency = () => {
  const a = race.myAssignment();
  return auth.isAdmin || (!race.episodeFinished() && (auth.isHost || (a && (a.role === 'follow' || (a.role === 'station' && (a.leg_ids || []).length > 0)))));
};
race.canAdjustCurrencyFor = (teamId) => {
  if (auth.isAdmin) return true;
  if (race.episodeFinished() || race.teamLocked(teamId)) return false;
  if (auth.isHost) return true;
  const a = race.myAssignment();
  if (a && a.role === 'station') return (a.leg_ids || []).length > 0; // station: any team, legs restricted
  return !!a && a.role === 'follow' && a.team_id === teamId;
};
/** Legs selectable for money and penalty operations: stations only their own legs with no "other"; other roles all legs + other */
race.currencyLegIds = () => { const a = race.myAssignment(); return !auth.isHost && a && a.role === 'station' ? (a.leg_ids || []) : null; };

// ---------- roadblock people, cutoffs ----------
/** Roadblock person options: member names by team size; options over the roadblock-gap limit are hidden (saved / selected always stay) */
race.memberOptions = (teamId, saved, selected) => {
  const t = race.teamById.get(teamId);
  const size = Math.max(1, auth.event.teamSize || 1, t ? t.members.length : 0);
  const all = Array.from({ length: size }, (_, i) => (t && t.members[i]) || `成员${i + 1}`);
  const counts = {};
  for (const m of all) counts[m] = (t && t.rbCounts && t.rbCounts[m]) || 0;
  if (saved && counts[saved] !== undefined) counts[saved] = Math.max(0, counts[saved] - 1);
  const gap = Math.max(0, auth.event.rbGap === undefined ? 2 : auth.event.rbGap);
  const ok = all.filter((m) => {
    const others = all.filter((x) => x !== m).map((x) => counts[x] || 0);
    const min = others.length ? Math.min.apply(null, others) : counts[m];
    return counts[m] + 1 - min <= gap;
  });
  for (const v of [saved, selected]) if (v && !ok.includes(v)) ok.push(v);
  return ok;
};
race.cutoffUseCount = (teamId, cutoffId) => race.cutoffUses.filter((u) => u.team_id === teamId && u.cutoff_id === cutoffId).length;
/** When a team's cutoff is next available (ms); null = the team is not on this leg (same rule as the server) */
race.cutoffReadyAt = (teamId, leg, cf) => {
  const p = race.progressOf(teamId, leg.id);
  if (!p || !p.arrived_at || p.completed_at) return null;
  let ready = new Date(race.taskStart(teamId, leg.id)).getTime() + cf.start_min * 60000; // from the task start: waiting is not part of it
  const uses = race.cutoffUses.filter((u) => u.team_id === teamId && u.cutoff_id === cf.id).map((u) => new Date(u.used_at).getTime());
  if (uses.length) ready = Math.max(ready, Math.max.apply(null, uses) + cf.interval_min * 60000);
  return ready;
};

// ---------- side quests, record order ----------
/** A side quest follows its main leg: parent = previous leg; branch = next leg (if it is a side quest) */
race.parentOf = (legId) => {
  const ep = race.currentEpisode(); if (!ep) return null;
  const i = ep.legs.findIndex((l) => l.id === legId);
  return i > 0 && ep.legs[i].type === 'SQ' ? ep.legs[i - 1] : null;
};
race.branchOf = (legId) => {
  const ep = race.currentEpisode(); if (!ep) return null;
  const i = ep.legs.findIndex((l) => l.id === legId);
  const n = i >= 0 ? ep.legs[i + 1] : undefined;
  return n && n.type === 'SQ' && ep.legs[i].type !== 'SQ' ? n : null;
};
/** Once the main leg completes, ordinary crew cannot edit its side quest */
race.branchLocked = (teamId, legId) => {
  const parent = race.parentOf(legId); if (!parent) return false;
  return !!(race.progressOf(teamId, parent.id) || {}).completed_at && !auth.isHost;
};
/** Extra info required before completion: what is missing, null when complete */
race.extraMissing = (leg, p, teamId) => {
  p = p || {};
  if (leg.type === 'DT' && !p.detour_choice) return '先填写绕道选择';
  if (leg.type === 'RB' && !p.roadblock_by) return '先填写路障完成人';
  if (leg.type === 'FF' && !p.ff_result) return '先填写快进结果';
  if (leg.type === 'Union') {
    if (!p.target_team_id) return '先选择合作队伍';
    if (leg.id !== undefined && teamId !== undefined && (race.progressOf(p.target_team_id, leg.id) || {}).target_team_id !== teamId) return '等待合作队伍选择本队';
  }
  return null;
};
/** Order check matching the server: why recording is blocked, null when allowed */
race.blockReason = (teamId, legId) => {
  const ep = race.currentEpisode();
  if (!ep) return null;
  if (!auth.isAdmin) {
    if (ep.status === 'pending') return '赛段尚未开始';
    if (ep.status !== 'running' && !auth.isHost) return '赛段已结束';
  }
  const idx = ep.legs.findIndex((l) => l.id === legId);
  const self = ep.legs[idx];
  const w = race.waitingUntil(teamId, legId);
  if (w) return `${race.waitLabel(teamId, legId)}原地等待中，${fmtTime(w)} 后可记录`;
  if (self && self.type === 'SQ') {
    const parent = race.parentOf(legId); const pp = parent ? race.progressOf(teamId, parent.id) : null;
    if (!pp || !pp.arrived_at) return '主线还没有开始';
    if (parent && race.waitingUntil(teamId, parent.id)) return '主线还在原地等待，开始后才能进入支线';
    if (pp.completed_at) return auth.isHost ? null : '主线已完成';
    return null;
  }
  const br = race.branchOf(legId);
  if (br) { const bp = race.progressOf(teamId, br.id); if (bp && bp.arrived_at && !bp.completed_at) return '支线进行中，先结束支线'; }
  const missing = [];
  for (let i = 0; i < idx; i++) {
    const l = ep.legs[i];
    const p = race.progressOf(teamId, l.id);
    if (l.type === 'FF' && p && p.ff_result === 'success') return null;
    if (!MANDATORY_TYPES.has(l.type)) continue;
    if (!p || !p.completed_at) missing.push(legName(l));
  }
  return missing.length ? `先完成：${missing.join('、')}` : null;
};

// ---------- announcements ----------
// Own posts are never unread; system notices to one team's follows count only for the team this account follows (a.mine)
const countsAsUnread = (a) => a.id > race.lastReadId && a.author_id !== (auth.user && auth.user.id) && (!a.audience.startsWith('follow:') || a.mine);
race.unreadAnnouncements = () => race.announcements.filter(countsAsUnread).length;
/** Pop-ups: unread system notices (departure, twist cards) for the team this account follows, not acknowledged on this device */
race.popupAnnouncements = () => race.announcements.filter((a) => a.audience.startsWith('follow:') && countsAsUnread(a) && !race.ackedPopups.has(a.id)).sort((a, b) => a.id - b.id);
race.dismissPopup = async () => {
  const shown = race.popupAnnouncements().map((a) => a.id);
  shown.forEach((id) => race.ackedPopups.add(id));
  wx.setStorageSync(ACK_KEY, Array.from(race.ackedPopups).slice(-200));
  // the read mark moves up to just before the first other unread announcement
  const otherUnread = race.announcements.filter((a) => countsAsUnread(a) && !race.ackedPopups.has(a.id)).map((a) => a.id);
  const max = Math.min(Math.max.apply(null, [0].concat(shown)), otherUnread.length ? Math.min.apply(null, otherUnread) - 1 : Infinity);
  if (max > race.lastReadId) {
    race.lastReadId = max;
    try { await api('/announcements/read', { method: 'POST', body: { id: max } }); } catch (e) { /* sync next time */ }
  }
  changed();
};
race.markAnnouncementsRead = async () => {
  const max = Math.max.apply(null, [0].concat(race.announcements.map((a) => a.id)));
  if (max > race.lastReadId) {
    race.lastReadId = max;
    changed();
    try { await api('/announcements/read', { method: 'POST', body: { id: max } }); } catch (e) { /* sync next time */ }
  }
};

// ---------- loading ----------
race.selectEpisode = (id) => {
  if (id === race.currentEpisodeId) return;
  race.currentEpisodeId = id;
  wx.setStorageSync(epKey(), id);
  changed();
  if (race.loaded) race.loadEpisodeScoped();
};
race.loadEpisodes = async () => {
  race.episodes = (await api('/episodes')).episodes;
  if (!race.loaded) {
    // first load: the running episode (the later one while a continuous episode overlaps its predecessor), else the last selection, else the first
    const running = race.episodes.slice().reverse().find((e) => e.status === 'running');
    if (running) race.currentEpisodeId = running.id;
    else if (!race.episodes.some((e) => e.id === race.currentEpisodeId) && race.episodes[0]) race.currentEpisodeId = race.episodes[0].id;
  } else if (!race.episodes.some((e) => e.id === race.currentEpisodeId) && race.episodes[0]) {
    race.currentEpisodeId = race.episodes[0].id;
  }
  wx.setStorageSync(epKey(), race.currentEpisodeId);
  changed();
};
race.loadTeams = async () => { race.teams = (await api('/teams')).teams; changed(); };
race.loadUsers = async () => { race.users = (await api('/members')).users; changed(); };
race.loadShopItems = async () => { try { race.shopItems = (await api('/shop/items')).items; } catch (e) { race.shopItems = []; } changed(); };
race.loadAnnouncements = async () => {
  const d = await api('/announcements');
  race.announcements = d.announcements;
  race.lastReadId = Math.max(race.lastReadId, Number(d.lastReadId || 0));
  changed();
};
race.loadAssignments = async () => {
  const ep = race.currentEpisode(); if (!ep) return;
  race.assignments = (await api(`/episodes/${ep.id}/assignments`)).assignments;
  changed();
};
race.loadProgress = async () => {
  const ep = race.currentEpisode(); if (!ep) return;
  const d = await api(`/episodes/${ep.id}/progress`);
  Object.assign(race, { progress: d.progress, penalties: d.penalties, pitstop: d.pitstop, cutoffUses: d.cutoffUses || [], effects: d.effects || [] });
  changed();
};
race.loadLedger = async () => {
  const ep = race.currentEpisode(); if (!ep) return;
  const [l, i] = await Promise.all([api(`/ledger?episodeId=${ep.id}`), api(`/item-log?episodeId=${ep.id}`)]);
  race.ledger = l.ledger; race.itemLog = i.items;
  changed();
};
race.loadEpisodeScoped = () => Promise.all([race.loadAssignments(), race.loadProgress(), race.loadLedger()]);
race.loadAll = async () => {
  await Promise.all([race.loadEpisodes(), race.loadTeams(), race.loadUsers(), race.loadAnnouncements(), race.loadShopItems()]);
  await race.loadEpisodeScoped();
  race.loaded = true;
  changed();
};
/** Entering another event: clear the previous one */
race.reset = () => {
  Object.assign(race, { loaded: false, episodes: [], teams: [], users: [], announcements: [], assignments: [], progress: [], effects: [], penalties: [], pitstop: [], ledger: [], itemLog: [], cutoffUses: [], lastReadId: 0 });
  race.currentEpisodeId = Number(wx.getStorageSync(epKey()) || 0);
  rebuild();
};
/** Realtime "this data changed" notice from the server */
race.invalidate = async (scope, episodeId) => {
  const ep = race.currentEpisode();
  const mine = !episodeId || episodeId === (ep && ep.id);
  switch (scope) {
    case 'episodes': await race.loadEpisodes(); if (mine) await race.loadAssignments(); break;
    case 'teams': await race.loadTeams(); break;
    case 'assignments': if (mine) await race.loadAssignments(); break;
    case 'progress': case 'pitstop': await Promise.all([mine ? race.loadProgress() : null, race.loadTeams()]); break; // roadblock counts change with progress
    case 'ledger': await race.loadTeams(); if (mine) await race.loadLedger(); break;
    case 'announcements': await race.loadAnnouncements(); break;
    case 'admin': await Promise.all([race.loadUsers(), race.loadEpisodes(), race.loadTeams(), race.loadShopItems()]); break;
    default: break;
  }
};
/** The hit team answers a twist effect (shield / reflect / accept) */
race.answerTwist = async (effectId, answer) => {
  await api(`/effects/${effectId}/answer`, { method: 'POST', body: { answer } });
  await Promise.all([race.loadProgress(), race.loadTeams(), race.loadLedger(), race.loadAnnouncements()]);
};

module.exports = race;
