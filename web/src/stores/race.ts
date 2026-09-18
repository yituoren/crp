import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { api } from '@/api';
import { useAuth } from './auth';
import { legName, type Announcement, type Assignment, type Episode, type LedgerEntry, type Penalty, type PitstopRow, type Progress, type Team, type User } from '@/types';


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
  const loaded = ref(false);

  const currentEpisode = computed(() => episodes.value.find((e) => e.id === currentEpisodeId.value) ?? episodes.value[0] ?? null);
  const aliveTeams = computed(() => teams.value.filter((t) => t.status === 'alive'));
  const myAssignment = computed(() => assignments.value.find((a) => a.user_id === auth.user?.id) ?? null);
  const teamById = computed(() => new Map(teams.value.map((t) => [t.id, t])));
  const legById = computed(() => new Map(episodes.value.flatMap((e) => e.legs).map((l) => [l.id, l])));
  /** 最后一个赛段：它的中继站显示为“终点” */
  const lastEpisodeId = computed(() => episodes.value[episodes.value.length - 1]?.id ?? 0);
  const isLastEpisode = (episodeId?: number | null) => (episodeId ?? currentEpisode.value?.id) === lastEpisodeId.value;

  function progressOf(teamId: number, legId: number) {
    return progress.value.find((p) => p.team_id === teamId && p.leg_id === legId) ?? null;
  }

  // 赛段状态锁：管理员不受任何状态限制，所以这两个锁对管理员恒为 false
  /** 当前赛段尚未开始（且非管理员）：环节记录、经费、罚时都不能操作 */
  const episodePending = computed(() => !auth.isAdmin && currentEpisode.value?.status === 'pending');
  /** 当前赛段已结束（且非管理员）：记录锁定，常规记录按钮全部收起；只有主办能通过“修改记录”修正，普通幕后只读 */
  const episodeFinished = computed(() => !auth.isAdmin && currentEpisode.value?.status === 'finished');
  /** 时间记录（常规按钮）：管理员任意；主办任意；跟队仅所跟队伍；站点不记时间；赛段结束后所有人都不能 */
  function canRecord(teamId: number, _legId: number) {
    if (auth.isAdmin) return true;
    if (episodeFinished.value) return false;
    if (auth.isHost) return true;
    const a = myAssignment.value;
    return !!a && a.role === 'follow' && a.team_id === teamId;
  }
  /** 修改记录（弹窗修正）：管理员任意；主办随时可用（未开始除外）；跟队仅在进行中对所跟队伍可用 */
  function canEdit(teamId: number) {
    if (auth.isAdmin) return true;
    if (episodePending.value) return false;
    if (auth.isHost) return true;
    if (episodeFinished.value) return false;
    const a = myAssignment.value;
    return !!a && a.role === 'follow' && a.team_id === teamId;
  }
  /** 罚时/补时：主办；本赛段站点任意队伍；跟队仅所跟队伍（赛段结束后仅主办） */
  const canManagePenalty = computed(() => auth.isHost || (!episodeFinished.value && (myAssignment.value?.role === 'station' || myAssignment.value?.role === 'follow')));
  function canManagePenaltyFor(teamId: number) {
    if (auth.isHost) return true;
    if (episodeFinished.value) return false;
    const a = myAssignment.value;
    return a?.role === 'station' || (a?.role === 'follow' && a.team_id === teamId);
  }
  /** 撤销罚时/经费：只有发出记录的本人和主办 */
  function canRevert(authorId: number | null | undefined) {
    if (auth.isHost) return true;
    if (episodeFinished.value) return false;
    return !!authorId && authorId === auth.user?.id;
  }
  /** 经费：主办任意；跟队仅所跟队伍（赛段结束后仅主办）；站点无 */
  const canAdjustCurrency = computed(() => auth.isHost || (!episodeFinished.value && myAssignment.value?.role === 'follow'));
  /** 淘汰权限：主办，或本赛段站在中继站的站点人员；不受赛段开始/结束限制 */
  const canEliminate = computed(() => {
    if (auth.isHost) return true;
    const a = myAssignment.value;
    if (!a || a.role !== 'station' || !a.leg_ids?.length) return false;
    return currentEpisode.value?.legs.some((l) => a.leg_ids.includes(l.id) && l.type === 'PS') ?? false;
  });
  function canAdjustCurrencyFor(teamId: number) {
    if (auth.isHost) return true;
    if (episodeFinished.value) return false;
    const a = myAssignment.value;
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
  /** 记录完成前必须填好的附加信息：返回缺什么，null 表示齐了 */
  function extraMissing(leg: { type: string }, p: { detour_choice?: string | null; roadblock_by?: string | null; ff_result?: string | null } | null): string | null {
    if (leg.type === 'DT' && !p?.detour_choice) return '先填写绕道选择';
    if (leg.type === 'RB' && !p?.roadblock_by) return '先填写路障完成人';
    if (leg.type === 'FF' && !p?.ff_result) return '先填写快进结果';
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
    progress.value = d.progress; penalties.value = d.penalties; pitstop.value = d.pitstop;
  }
  async function loadLedger() {
    if (!currentEpisode.value) return;
    ledger.value = (await api(`/ledger?episodeId=${currentEpisode.value.id}`)).ledger;
  }
  async function loadEpisodeScoped() {
    await Promise.all([loadAssignments(), loadProgress(), loadLedger()]);
  }
  async function loadAll() {
    await Promise.all([loadEpisodes(), loadTeams(), loadUsers(), loadAnnouncements()]);
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
      case 'admin': await Promise.all([loadUsers(), loadEpisodes(), loadTeams()]); break;
    }
  }

  return {
    episodes, teams, users, announcements, unreadAnnouncements, markAnnouncementsRead, currentEpisodeId, currentEpisode, assignments, progress, penalties, pitstop, ledger, loaded,
    aliveTeams, myAssignment, teamById, legById, lastEpisodeId, isLastEpisode, progressOf, canRecord, canEdit, canAdjustCurrency, canAdjustCurrencyFor, canManagePenalty, canManagePenaltyFor, canRevert, canEliminate, episodePending, episodeFinished, canUploadTo, blockReason, extraMissing, memberOptions,
    loadAll, reset, loadEpisodes, loadTeams, loadUsers, loadAnnouncements, loadAssignments, loadProgress, loadLedger, selectEpisode, invalidate,
  };
});
