import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { api } from '@/api';
import { useAuth } from './auth';
import { legName, type Announcement, type Assignment, type Episode, type LedgerEntry, type Penalty, type PitstopRow, type Progress, type Team, type User } from '@/types';

const EP_KEY = 'crp.currentEpisodeId';

export const useRace = defineStore('race', () => {
  const auth = useAuth();
  const episodes = ref<Episode[]>([]);
  const teams = ref<Team[]>([]);
  const users = ref<User[]>([]);
  const announcements = ref<Announcement[]>([]);
  const currentEpisodeId = ref<number>(Number(localStorage.getItem(EP_KEY) ?? 0) || 0);
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
  /** 罚时/补时：主办、本赛段站点（赛段结束后仅主办） */
  const canManagePenalty = computed(() => auth.isHost || (!episodeFinished.value && myAssignment.value?.role === 'station'));
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

  /** 记录完成前必须填好的附加信息：返回缺什么，null 表示齐了 */
  function extraMissing(leg: { type: string }, p: { detour_choice?: string | null; roadblock_by?: string | null; ff_result?: string | null } | null): string | null {
    if (leg.type === 'DT' && !p?.detour_choice) return '先填写绕道选择';
    if (leg.type === 'RB' && !p?.roadblock_by) return '先填写路障完成人';
    if (leg.type === 'FF' && !p?.ff_result) return '先填写快进结果';
    return null;
  }
  /** 与服务端一致的打卡顺序检查：返回不能打卡的原因，null 表示可以 */
  const MANDATORY_TYPES = new Set(['SL', 'TI', 'DT', 'RB', 'Union', 'Shuffle', 'Trap', 'PS']);
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
      if (l.record_mode === 'none' || !MANDATORY_TYPES.has(l.type)) continue;
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
  async function loadUsers() { users.value = (await api('/auth/users')).users; }
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

  function selectEpisode(id: number) {
    currentEpisodeId.value = id;
    localStorage.setItem(EP_KEY, String(id));
  }
  watch(currentEpisodeId, () => { if (loaded.value) loadEpisodeScoped(); });

  /** 实时失效通知 */
  async function invalidate(scope: string, episodeId: number | null) {
    const mine = !episodeId || episodeId === currentEpisode.value?.id;
    switch (scope) {
      case 'episodes': await loadEpisodes(); if (mine) await loadAssignments(); break;
      case 'teams': await loadTeams(); break;
      case 'assignments': if (mine) await loadAssignments(); break;
      case 'progress': case 'pitstop': if (mine) await loadProgress(); break;
      case 'ledger': await loadTeams(); if (mine) await loadLedger(); break;
      case 'announcements': await loadAnnouncements(); break;
      case 'admin': await Promise.all([loadUsers(), loadEpisodes(), loadTeams()]); break;
    }
  }

  return {
    episodes, teams, users, announcements, unreadAnnouncements, markAnnouncementsRead, currentEpisodeId, currentEpisode, assignments, progress, penalties, pitstop, ledger, loaded,
    aliveTeams, myAssignment, teamById, legById, progressOf, canRecord, canEdit, canAdjustCurrency, canAdjustCurrencyFor, canManagePenalty, canEliminate, episodePending, episodeFinished, canUploadTo, blockReason, extraMissing,
    loadAll, loadEpisodes, loadTeams, loadUsers, loadAnnouncements, loadAssignments, loadProgress, loadLedger, selectEpisode, invalidate,
  };
});
