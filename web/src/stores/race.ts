import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { api } from '@/api';
import { useAuth } from './auth';
import { legName, type ShopItem, type CutoffUse, type Cutoff, type Announcement, type Assignment, type Episode, type LedgerEntry, type Penalty, type PitstopRow, type Progress, type Team, type User, type ItemLogEntry } from '@/types';


export const useRace = defineStore('race', () => {
  const auth = useAuth();
  const epKey = () => `crp.currentEpisodeId.${auth.event.hash || 'none'}`;
  const episodes = ref<Episode[]>([]);
  const teams = ref<Team[]>([]);
  const users = ref<User[]>([]);
  const announcements = ref<Announcement[]>([]);
  const currentEpisodeId = ref<number>(0);
  const assignments = ref<Assignment[]>([]);
  const progress = ref<Progress[]>([]);
  const penalties = ref<Penalty[]>([]);
  const pitstop = ref<PitstopRow[]>([]);
  const ledger = ref<LedgerEntry[]>([]);
  const itemLog = ref<ItemLogEntry[]>([]);
  const shopItems = ref<ShopItem[]>([]);
  const cutoffUses = ref<CutoffUse[]>([]);
  const loaded = ref(false);

  const currentEpisode = computed(() => episodes.value.find((e) => e.id === currentEpisodeId.value) ?? episodes.value[0] ?? null);
  const aliveTeams = computed(() => teams.value.filter((t) => t.status === 'alive'));
  const myAssignment = computed(() => assignments.value.find((a) => a.user_id === auth.user?.id) ?? null);
  const teamById = computed(() => new Map(teams.value.map((t) => [t.id, t])));
  const legById = computed(() => new Map(episodes.value.flatMap((e) => e.legs).map((l) => [l.id, l])));
  /** Leg order across the event (episode order × leg order), used to find legs after elimination / withdrawal */
  const legOrderIndex = computed(() => new Map(episodes.value.flatMap((e) => e.legs).map((l, i) => [l.id, i])));
  /** Whether a leg is locked for a team: legs after elimination or withdrawal cannot be recorded and show no actions */
  function isLocked(teamId: number, legId: number) {
    const t = teamById.value.get(teamId);
    if (!t?.locked_from_leg_id) return false;
    const from = legOrderIndex.value.get(t.locked_from_leg_id), cur = legOrderIndex.value.get(legId);
    return from !== undefined && cur !== undefined && cur >= from;
  }
  /** The last episode: its pit stop is labelled "finish" */
  const lastEpisodeId = computed(() => episodes.value[episodes.value.length - 1]?.id ?? 0);
  const isLastEpisode = (episodeId?: number | null) => (episodeId ?? currentEpisode.value?.id) === lastEpisodeId.value;

  function progressOf(teamId: number, legId: number) {
    return progress.value.find((p) => p.team_id === teamId && p.leg_id === legId) ?? null;
  }

  // Episode status locks: admins ignore status, so both are always false for them
  /** Current episode not started (and not admin): no records, money or penalties */
  const episodePending = computed(() => !auth.isAdmin && currentEpisode.value?.status === 'pending');
  /** Current episode finished (and not admin): everything is locked, admin only */
  const episodeFinished = computed(() => !auth.isAdmin && currentEpisode.value?.status === 'finished');
  /** Team eliminated / withdrawn (and not admin): all of its records are locked, admin only */
  function teamLocked(teamId: number) {
    if (auth.isAdmin) return false;
    const t = teamById.value.get(teamId);
    return !!t && t.status !== 'alive';
  }
  /** Unified reason for being locked: episode finished / team eliminated or withdrawn */
  function lockReason(teamId?: number): string | null {
    if (episodeFinished.value) return '赛段已结束，只有管理员可以修改';
    if (teamId !== undefined && teamLocked(teamId)) return `该队伍已${teamById.value.get(teamId)?.status === 'withdrawn' ? '退赛' : '淘汰'}，只有管理员可以修改`;
    return null;
  }
  /** Time records (regular buttons): admin any; host any; follow only its team; stations never; nobody after the episode ends */
  function canRecord(teamId: number, _legId: number) {
    if (auth.isAdmin) return true;
    if (episodeFinished.value || teamLocked(teamId)) return false;
    if (auth.isHost) return true;
    const a = myAssignment.value;
    return !!a && a.role === 'follow' && a.team_id === teamId;
  }
  /** Edit records (dialog): admin any; host any time except before start; follow only its team while running */
  function canEdit(teamId: number) {
    if (auth.isAdmin) return true;
    if (episodePending.value || episodeFinished.value || teamLocked(teamId)) return false;
    if (auth.isHost) return true;
    const a = myAssignment.value;
    return !!a && a.role === 'follow' && a.team_id === teamId;
  }
  /** Penalties / credits: host; this episode's stations any team; follow only its team (host only after the episode ends) */
  const canManagePenalty = computed(() => auth.isAdmin || (!episodeFinished.value && (auth.isHost || myAssignment.value?.role === 'station' || myAssignment.value?.role === 'follow')));
  function canManagePenaltyFor(teamId: number) {
    if (auth.isAdmin) return true;
    if (episodeFinished.value || teamLocked(teamId)) return false;
    if (auth.isHost) return true;
    const a = myAssignment.value;
    return a?.role === 'station' || (a?.role === 'follow' && a.team_id === teamId);
  }
  /** Revert penalties / money: only the author or a host */
  function canRevert(authorId: number | null | undefined, teamId?: number) {
    if (auth.isAdmin) return true;
    if (episodeFinished.value || (teamId !== undefined && teamLocked(teamId))) return false;
    if (auth.isHost) return true;
    return !!authorId && authorId === auth.user?.id;
  }
  /** Money: host any; follow only its team (host only after the episode ends); stations none */
  const canAdjustCurrency = computed(() => auth.isAdmin || (!episodeFinished.value && (auth.isHost || myAssignment.value?.role === 'follow' || (myAssignment.value?.role === 'station' && (myAssignment.value.leg_ids?.length ?? 0) > 0))));
  /** Legs selectable for money operations: stations only their own legs with no "other"; other roles all legs + other */
  const currencyLegIds = computed<number[] | null>(() => (!auth.isHost && myAssignment.value?.role === 'station' ? (myAssignment.value.leg_ids ?? []) : null));
  /** Elimination rights: host, or the pit-stop station of this episode; independent of episode status */
  const canEliminate = computed(() => {
    if (auth.isHost) return true;
    const a = myAssignment.value;
    if (!a || a.role !== 'station' || !a.leg_ids?.length) return false;
    return currentEpisode.value?.legs.some((l) => a.leg_ids.includes(l.id) && l.type === 'PS') ?? false;
  });
  function canAdjustCurrencyFor(teamId: number) {
    if (auth.isAdmin) return true;
    if (episodeFinished.value || teamLocked(teamId)) return false;
    if (auth.isHost) return true;
    const a = myAssignment.value;
    if (a?.role === 'station') return (a.leg_ids?.length ?? 0) > 0; // station: any team, legs restricted
    return a?.role === 'follow' && a.team_id === teamId;
  }

  /**
   * Roadblock person options: member names by team size, unnamed ones shown as 成员1 / 成员2.
   * Roadblock limit: after picking someone, their count minus the team's minimum must not exceed the setting; options over it are hidden.
   * saved = the person already stored in this record (subtracted before counting), selected = the current value (always kept)
   */
  function memberOptions(teamId: number, saved?: string | null, selected?: string | null): string[] {
    const t = teamById.value.get(teamId);
    const size = Math.max(1, auth.event.teamSize || 1, t?.members.length ?? 0);
    const all = Array.from({ length: size }, (_, i) => t?.members[i] || `成员${i + 1}`);
    const counts: Record<string, number> = {};
    for (const m of all) counts[m] = t?.rbCounts?.[m] ?? 0;
    if (saved && counts[saved] !== undefined) counts[saved] = Math.max(0, counts[saved]! - 1);
    const gap = Math.max(0, auth.event.rbGap ?? 2);
    const ok = all.filter((m) => {
      const others = all.filter((x) => x !== m).map((x) => counts[x] ?? 0);
      const min = others.length ? Math.min(...others) : counts[m]!;
      return (counts[m]! + 1) - min <= gap;
    });
    for (const v of [saved, selected]) if (v && !ok.includes(v)) ok.push(v); // saved / selected values are always visible
    return ok;
  }
  /** Cutoffs: a team's use count / next availability (ms); null = the team is not on this leg (same rule as the server) */
  function cutoffUseCount(teamId: number, cutoffId: number) {
    return cutoffUses.value.filter((u) => u.team_id === teamId && u.cutoff_id === cutoffId).length;
  }
  function cutoffReadyAt(teamId: number, leg: { id: number }, cf: Cutoff): number | null {
    const p = progressOf(teamId, leg.id);
    if (!p?.arrived_at || p.completed_at) return null;
    let ready = new Date(p.arrived_at).getTime() + cf.start_min * 60000;
    const last = cutoffUses.value.filter((u) => u.team_id === teamId && u.cutoff_id === cf.id).map((u) => new Date(u.used_at).getTime()).sort((a, b) => b - a)[0];
    if (last !== undefined) ready = Math.max(ready, last + cf.interval_min * 60000);
    return ready;
  }
  /** After an episode starts, leg structure (add / delete / order / type / elimination / cutoffs) is admin only */
  const structureEditable = computed(() => auth.isAdmin || currentEpisode.value?.status === 'pending');
  /** A side quest follows its main leg: parent = previous leg; branch = next leg (if it is a side quest) */
  function parentOf(legId: number) {
    const ep = currentEpisode.value; if (!ep) return null;
    const i = ep.legs.findIndex((l) => l.id === legId);
    return i > 0 && ep.legs[i]!.type === 'SQ' ? ep.legs[i - 1]! : null;
  }
  function branchOf(legId: number) {
    const ep = currentEpisode.value; if (!ep) return null;
    const i = ep.legs.findIndex((l) => l.id === legId);
    const n = i >= 0 ? ep.legs[i + 1] : undefined;
    return n && n.type === 'SQ' && ep.legs[i]!.type !== 'SQ' ? n : null;
  }
  /** Whether the side quest is locked for a team: once the main leg completes, ordinary crew cannot edit it */
  function branchLocked(teamId: number, legId: number) {
    const parent = parentOf(legId); if (!parent) return false;
    return !!progressOf(teamId, parent.id)?.completed_at && !auth.isHost;
  }
  /** Extra info required before completion: returns what is missing, null when complete */
  function extraMissing(leg: { id?: number; type: string }, p: { detour_choice?: string | null; roadblock_by?: string | null; ff_result?: string | null; target_team_id?: number | null } | null, teamId?: number): string | null {
    if (leg.type === 'DT' && !p?.detour_choice) return '先填写绕道选择';
    if (leg.type === 'RB' && !p?.roadblock_by) return '先填写路障完成人';
    if (leg.type === 'FF' && !p?.ff_result) return '先填写快进结果';
    if (leg.type === 'Union') {
      // Union: both teams must pick each other before completion
      if (!p?.target_team_id) return '先选择合作队伍';
      if (leg.id !== undefined && teamId !== undefined && progressOf(p.target_team_id, leg.id)?.target_team_id !== teamId) return '等待合作队伍选择本队';
    }
    return null;
  }
  /** Order check matching the server: returns why recording is blocked, null when allowed */
  const MANDATORY_TYPES = new Set(['SL', 'RI', 'TI', 'DT', 'RB', 'Union', 'Shuffle', 'Trap', 'PS']);
  function blockReason(teamId: number, legId: number): string | null {
    const ep = currentEpisode.value;
    if (!ep) return null;
    if (!auth.isAdmin) {
      if (ep.status === 'pending') return '赛段尚未开始';
      if (ep.status !== 'running' && !auth.isHost) return '赛段已结束';
    }
    const idx = ep.legs.findIndex((l) => l.id === legId);
    const self = ep.legs[idx];
    if (self?.type === 'SQ') {
      // Side quest: can be entered while the main leg runs, mandatory legs are not checked
      const parent = parentOf(legId); const pp = parent ? progressOf(teamId, parent.id) : null;
      if (!pp?.arrived_at) return '主线还没有开始';
      if (pp.completed_at) return auth.isHost ? null : '主线已完成';
      return null;
    }
    const br = branchOf(legId);
    if (br) { const bp = progressOf(teamId, br.id); if (bp?.arrived_at && !bp.completed_at) return '支线进行中，先结束支线'; }
    const missing: string[] = [];
    for (let i = 0; i < idx; i++) {
      const l = ep.legs[i]!;
      const p = progressOf(teamId, l.id);
      if (l.type === 'FF' && p?.ff_result === 'success') return null;
      if (!MANDATORY_TYPES.has(l.type)) continue;
      if (!p?.completed_at) missing.push(legName(l));
    }
    return missing.length ? `先完成：${missing.join('、')}` : null;
  }
  function canUploadTo(legId: number) {
    return auth.isHost || (myAssignment.value?.role === 'station' && (myAssignment.value.leg_ids ?? []).includes(legId));
  }

  async function loadEpisodes() {
    episodes.value = (await api('/episodes')).episodes;
    if (!loaded.value) {
      // First load: default to the running episode; otherwise the last selection, otherwise the first. After that only the user switches.
      const running = episodes.value.find((e) => e.status === 'running');
      if (running) selectEpisode(running.id);
      else if (!episodes.value.some((e) => e.id === currentEpisodeId.value) && episodes.value[0]) selectEpisode(episodes.value[0].id);
    } else if (!episodes.value.some((e) => e.id === currentEpisodeId.value) && episodes.value[0]) {
      selectEpisode(episodes.value[0].id);
    }
  }
  async function loadTeams() { teams.value = (await api('/teams')).teams; }
  async function loadShopItems() { try { shopItems.value = (await api('/shop/items')).items; } catch { shopItems.value = []; } }
  async function loadUsers() { users.value = (await api('/members')).users; }
  // Unread announcements: the last read id is stored on the account, consistent across devices
  const lastReadId = ref<number>(0);
  async function loadAnnouncements() {
    const d = await api('/announcements');
    announcements.value = d.announcements;
    lastReadId.value = Math.max(lastReadId.value, Number(d.lastReadId ?? 0));
  }
  const unreadAnnouncements = computed(() => announcements.value.filter((a) => a.id > lastReadId.value).length);
  async function markAnnouncementsRead() {
    const max = Math.max(0, ...announcements.value.map((a) => a.id));
    if (max > lastReadId.value) {
      lastReadId.value = max;
      try { await api('/announcements/read', { method: 'POST', body: { id: max } }); } catch { /* sync next time */ }
    }
  }
  async function loadAssignments() {
    if (!currentEpisode.value) return;
    assignments.value = (await api(`/episodes/${currentEpisode.value.id}/assignments`)).assignments;
  }
  async function loadProgress() {
    if (!currentEpisode.value) return;
    const d = await api(`/episodes/${currentEpisode.value.id}/progress`);
    progress.value = d.progress; penalties.value = d.penalties; pitstop.value = d.pitstop; cutoffUses.value = d.cutoffUses ?? [];
  }
  async function loadLedger() {
    if (!currentEpisode.value) return;
    const id = currentEpisode.value.id;
    const [l, i] = await Promise.all([api(`/ledger?episodeId=${id}`), api(`/item-log?episodeId=${id}`)]);
    ledger.value = l.ledger; itemLog.value = i.items;
  }
  const loadItemLog = loadLedger;
  async function loadEpisodeScoped() {
    await Promise.all([loadAssignments(), loadProgress(), loadLedger()]);
  }
  async function loadAll() {
    await Promise.all([loadEpisodes(), loadTeams(), loadUsers(), loadAnnouncements(), loadShopItems()]);
    await loadEpisodeScoped();
    loaded.value = true;
  }
  /** Switching events: clear the previous event's data */
  function reset() {
    loaded.value = false;
    episodes.value = []; teams.value = []; users.value = []; announcements.value = [];
    assignments.value = []; progress.value = []; penalties.value = []; pitstop.value = []; ledger.value = [];
    lastReadId.value = 0;
    currentEpisodeId.value = Number(localStorage.getItem(epKey()) ?? 0) || 0;
  }

  function selectEpisode(id: number) {
    currentEpisodeId.value = id;
    localStorage.setItem(epKey(), String(id));
  }
  watch(currentEpisodeId, () => { if (loaded.value) loadEpisodeScoped(); });

  /** Live invalidation notice */
  async function invalidate(scope: string, episodeId: number | null) {
    const mine = !episodeId || episodeId === currentEpisode.value?.id;
    switch (scope) {
      case 'episodes': await loadEpisodes(); if (mine) await loadAssignments(); break;
      case 'teams': await loadTeams(); break;
      case 'assignments': if (mine) await loadAssignments(); break;
      case 'progress': case 'pitstop': await Promise.all([mine ? loadProgress() : Promise.resolve(), loadTeams()]); break; // roadblock counts change with progress
      case 'ledger': await loadTeams(); if (mine) await loadLedger(); break;
      case 'announcements': await loadAnnouncements(); break;
      case 'admin': await Promise.all([loadUsers(), loadEpisodes(), loadTeams(), loadShopItems()]); break;
    }
  }

  return {
    episodes, teams, users, announcements, shopItems, loadShopItems, unreadAnnouncements, markAnnouncementsRead, currentEpisodeId, currentEpisode, assignments, progress, penalties, pitstop, ledger, loaded,
    aliveTeams, myAssignment, teamById, legById, lastEpisodeId, isLastEpisode, progressOf, isLocked, teamLocked, lockReason, structureEditable, cutoffUses, cutoffUseCount, cutoffReadyAt, parentOf, branchOf, branchLocked, canRecord, canEdit, canAdjustCurrency, canAdjustCurrencyFor, currencyLegIds, canManagePenalty, canManagePenaltyFor, canRevert, canEliminate, episodePending, episodeFinished, canUploadTo, blockReason, extraMissing, memberOptions,
    loadAll, reset, loadEpisodes, loadTeams, loadUsers, loadAnnouncements, loadAssignments, loadProgress, loadLedger, loadItemLog, itemLog, selectEpisode, invalidate,
  };
});
