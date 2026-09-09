import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { api } from '@/api';
import { useAuth } from './auth';
import type { Announcement, Assignment, Episode, LedgerEntry, Penalty, PitstopRow, Progress, Team, User } from '@/types';

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

  function canRecord(teamId: number, legId: number) {
    if (auth.isHost) return true;
    const a = myAssignment.value;
    if (!a) return false;
    return (a.role === 'follow' && a.team_id === teamId) || (a.role === 'station' && a.leg_id === legId);
  }
  const canAdjustCurrency = computed(() => auth.isHost || myAssignment.value?.role === 'station');
  function canUploadTo(legId: number) {
    return auth.isHost || (myAssignment.value?.role === 'station' && myAssignment.value.leg_id === legId);
  }

  async function loadEpisodes() {
    episodes.value = (await api('/episodes')).episodes;
    if (!episodes.value.some((e) => e.id === currentEpisodeId.value) && episodes.value[0]) selectEpisode(episodes.value[0].id);
  }
  async function loadTeams() { teams.value = (await api('/teams')).teams; }
  async function loadUsers() { users.value = (await api('/auth/users')).users; }
  async function loadAnnouncements() { announcements.value = (await api('/announcements')).announcements; }
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
    episodes, teams, users, announcements, currentEpisodeId, currentEpisode, assignments, progress, penalties, pitstop, ledger, loaded,
    aliveTeams, myAssignment, teamById, legById, progressOf, canRecord, canAdjustCurrency, canUploadTo,
    loadAll, loadEpisodes, loadTeams, loadUsers, loadAnnouncements, loadAssignments, loadProgress, loadLedger, selectEpisode, invalidate,
  };
});
