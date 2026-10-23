import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { api } from '@/api';
import { useAuth } from './auth';
import { legName, type ShopItem, type CutoffUse, type Cutoff, type Announcement, type Assignment, type Episode, type LedgerEntry, type Penalty, type PitstopRow, type Progress, type Team, type User } from '@/types';


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
  const shopItems = ref<ShopItem[]>([]);
  const cutoffUses = ref<CutoffUse[]>([]);
  const loaded = ref(false);

  const currentEpisode = computed(() => episodes.value.find((e) => e.id === currentEpisodeId.value) ?? episodes.value[0] ?? null);
  const aliveTeams = computed(() => teams.value.filter((t) => t.status === 'alive'));
  const myAssignment = computed(() => assignments.value.find((a) => a.user_id === auth.user?.id) ?? null);
  const teamById = computed(() => new Map(teams.value.map((t) => [t.id, t])));
  const legById = computed(() => new Map(episodes.value.flatMap((e) => e.legs).map((l) => [l.id, l])));
  /** 全比赛环节顺序（赛段顺序 × 环节顺序），用于判断“淘汰/退赛之后的环节” */
  const legOrderIndex = computed(() => new Map(episodes.value.flatMap((e) => e.legs).map((l, i) => [l.id, i])));
  /** 某队在某环节是否已锁定：淘汰或退赛之后的环节不能再记录、不显示操作 */
  function isLocked(teamId: number, legId: number) {
    const t = teamById.value.get(teamId);
    if (!t?.locked_from_leg_id) return false;
    const from = legOrderIndex.value.get(t.locked_from_leg_id), cur = legOrderIndex.value.get(legId);
    return from !== undefined && cur !== undefined && cur >= from;
  }
  /** 最后一个赛段：它的中继站显示为“终点” */
  const lastEpisodeId = computed(() => episodes.value[episodes.value.length - 1]?.id ?? 0);
  const isLastEpisode = (episodeId?: number | null) => (episodeId ?? currentEpisode.value?.id) === lastEpisodeId.value;

  function progressOf(teamId: number, legId: number) {
    return progress.value.find((p) => p.team_id === teamId && p.leg_id === legId) ?? null;
  }

  // 赛段状态锁：管理员不受任何状态限制，所以这两个锁对管理员恒为 false
  /** 当前赛段尚未开始（且非管理员）：环节记录、经费、罚时都不能操作 */
  const episodePending = computed(() => !auth.isAdmin && currentEpisode.value?.status === 'pending');
  /** 当前赛段已结束（且非管理员）：所有记录锁定，只有管理员能改 */
  const episodeFinished = computed(() => !auth.isAdmin && currentEpisode.value?.status === 'finished');
  /** 队伍已淘汰 / 退赛（且非管理员）：该队的所有记录锁定，只有管理员能改 */
  function teamLocked(teamId: number) {
    if (auth.isAdmin) return false;
    const t = teamById.value.get(teamId);
    return !!t && t.status !== 'alive';
  }
  /** 统一的“不能改”原因：赛段已结束 / 队伍已淘汰退赛 */
  function lockReason(teamId?: number): string | null {
    if (episodeFinished.value) return '赛段已结束，只有管理员可以修改';
    if (teamId !== undefined && teamLocked(teamId)) return `该队伍已${teamById.value.get(teamId)?.status === 'withdrawn' ? '退赛' : '淘汰'}，只有管理员可以修改`;
    return null;
  }
  /** 时间记录（常规按钮）：管理员任意；主办任意；跟队仅所跟队伍；站点不记时间；赛段结束后所有人都不能 */
  function canRecord(teamId: number, _legId: number) {
    if (auth.isAdmin) return true;
    if (episodeFinished.value || teamLocked(teamId)) return false;
    if (auth.isHost) return true;
    const a = myAssignment.value;
    return !!a && a.role === 'follow' && a.team_id === teamId;
  }
  /** 修改记录（弹窗修正）：管理员任意；主办随时可用（未开始除外）；跟队仅在进行中对所跟队伍可用 */
  function canEdit(teamId: number) {
    if (auth.isAdmin) return true;
    if (episodePending.value || episodeFinished.value || teamLocked(teamId)) return false;
    if (auth.isHost) return true;
    const a = myAssignment.value;
    return !!a && a.role === 'follow' && a.team_id === teamId;
  }
  /** 罚时/补时：主办；本赛段站点任意队伍；跟队仅所跟队伍（赛段结束后仅主办） */
  const canManagePenalty = computed(() => auth.isAdmin || (!episodeFinished.value && (auth.isHost || myAssignment.value?.role === 'station' || myAssignment.value?.role === 'follow')));
  function canManagePenaltyFor(teamId: number) {
    if (auth.isAdmin) return true;
    if (episodeFinished.value || teamLocked(teamId)) return false;
    if (auth.isHost) return true;
    const a = myAssignment.value;
    return a?.role === 'station' || (a?.role === 'follow' && a.team_id === teamId);
  }
  /** 撤销罚时/经费：只有发出记录的本人和主办 */
  function canRevert(authorId: number | null | undefined, teamId?: number) {
    if (auth.isAdmin) return true;
    if (episodeFinished.value || (teamId !== undefined && teamLocked(teamId))) return false;
    if (auth.isHost) return true;
    return !!authorId && authorId === auth.user?.id;
  }
  /** 经费：主办任意；跟队仅所跟队伍（赛段结束后仅主办）；站点无 */
  const canAdjustCurrency = computed(() => auth.isAdmin || (!episodeFinished.value && (auth.isHost || myAssignment.value?.role === 'follow' || (myAssignment.value?.role === 'station' && (myAssignment.value.leg_ids?.length ?? 0) > 0))));
  /** 经费操作可选的环节：站点只能选自己驻守的环节，且没有“其他”；其他角色可选全部环节 + 其他 */
  const currencyLegIds = computed<number[] | null>(() => (!auth.isHost && myAssignment.value?.role === 'station' ? (myAssignment.value.leg_ids ?? []) : null));
  /** 淘汰权限：主办，或本赛段站在中继站的站点人员；不受赛段开始/结束限制 */
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
    if (a?.role === 'station') return (a.leg_ids?.length ?? 0) > 0; // 站点：任意队伍，环节受限
    return a?.role === 'follow' && a.team_id === teamId;
  }

  /**
   * 路障完成人下拉选项：按队伍人数列出成员名，没登记名字的写成“成员1/成员2”。
   * 路障限制：选了某人之后，他的路障次数减去队内最少的人不能超过设置值；超出的选项直接不显示。
   * saved = 这条记录里已存的人选（计数时要先扣掉），selected = 当前选中的值（始终保留在选项里）
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
    for (const v of [saved, selected]) if (v && !ok.includes(v)) ok.push(v); // 已存/已选的值始终可见
    return ok;
  }
  /** 熔断：某队某种熔断的使用次数 / 下次可用时间（毫秒）；null = 该队不在此环节进行中（与服务端同一规则） */
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
  /** 赛段开始后环节结构（增删、顺序、类型、淘汰、熔断设置）只有管理员能改 */
  const structureEditable = computed(() => auth.isAdmin || currentEpisode.value?.status === 'pending');
  /** 支线紧跟在主线之后：主线 = 前一个环节；支线 = 后一个环节（若是支线） */
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
  /** 支线对该队是否已锁定：主线记录完成后，普通幕后不能再改支线 */
  function branchLocked(teamId: number, legId: number) {
    const parent = parentOf(legId); if (!parent) return false;
    return !!progressOf(teamId, parent.id)?.completed_at && !auth.isHost;
  }
  /** 记录完成前必须填好的附加信息：返回缺什么，null 表示齐了 */
  function extraMissing(leg: { id?: number; type: string }, p: { detour_choice?: string | null; roadblock_by?: string | null; ff_result?: string | null; target_team_id?: number | null } | null, teamId?: number): string | null {
    if (leg.type === 'DT' && !p?.detour_choice) return '先填写绕道选择';
    if (leg.type === 'RB' && !p?.roadblock_by) return '先填写路障完成人';
    if (leg.type === 'FF' && !p?.ff_result) return '先填写快进结果';
    if (leg.type === 'Union') {
      // 联合：双方互选后才能记录完成
      if (!p?.target_team_id) return '先选择合作队伍';
      if (leg.id !== undefined && teamId !== undefined && progressOf(p.target_team_id, leg.id)?.target_team_id !== teamId) return '等待合作队伍选择本队';
    }
    return null;
  }
  /** 与服务端一致的打卡顺序检查：返回不能打卡的原因，null 表示可以 */
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
      // 支线：只要主线在进行中就能进入，不检查前面的必经环节
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
      // 首次打开：默认选进行中的赛段；没有就沿用上次选择，再没有就选第一个。之后完全由用户手动切换。
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
  // 未读公告：最后已读的公告 id 存在账号上，跨设备一致
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
      try { await api('/announcements/read', { method: 'POST', body: { id: max } }); } catch { /* 下次再同步 */ }
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
    ledger.value = (await api(`/ledger?episodeId=${currentEpisode.value.id}`)).ledger;
  }
  async function loadEpisodeScoped() {
    await Promise.all([loadAssignments(), loadProgress(), loadLedger()]);
  }
  async function loadAll() {
    await Promise.all([loadEpisodes(), loadTeams(), loadUsers(), loadAnnouncements(), loadShopItems()]);
    await loadEpisodeScoped();
    loaded.value = true;
  }
  /** 切换比赛：清空上一场的数据 */
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

  /** 实时失效通知 */
  async function invalidate(scope: string, episodeId: number | null) {
    const mine = !episodeId || episodeId === currentEpisode.value?.id;
    switch (scope) {
      case 'episodes': await loadEpisodes(); if (mine) await loadAssignments(); break;
      case 'teams': await loadTeams(); break;
      case 'assignments': if (mine) await loadAssignments(); break;
      case 'progress': case 'pitstop': await Promise.all([mine ? loadProgress() : Promise.resolve(), loadTeams()]); break; // 路障次数随进度变
      case 'ledger': await loadTeams(); if (mine) await loadLedger(); break;
      case 'announcements': await loadAnnouncements(); break;
      case 'admin': await Promise.all([loadUsers(), loadEpisodes(), loadTeams(), loadShopItems()]); break;
    }
  }

  return {
    episodes, teams, users, announcements, shopItems, loadShopItems, unreadAnnouncements, markAnnouncementsRead, currentEpisodeId, currentEpisode, assignments, progress, penalties, pitstop, ledger, loaded,
    aliveTeams, myAssignment, teamById, legById, lastEpisodeId, isLastEpisode, progressOf, isLocked, teamLocked, lockReason, structureEditable, cutoffUses, cutoffUseCount, cutoffReadyAt, parentOf, branchOf, branchLocked, canRecord, canEdit, canAdjustCurrency, canAdjustCurrencyFor, currencyLegIds, canManagePenalty, canManagePenaltyFor, canRevert, canEliminate, episodePending, episodeFinished, canUploadTo, blockReason, extraMissing, memberOptions,
    loadAll, reset, loadEpisodes, loadTeams, loadUsers, loadAnnouncements, loadAssignments, loadProgress, loadLedger, selectEpisode, invalidate,
  };
});
