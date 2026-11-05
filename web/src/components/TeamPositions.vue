<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { fmtTime } from '@/utils/time';
import { fmtMoney, moneyUnit } from '@/utils/money';
import LegTag from './LegTag.vue';
import { legName } from '@/types';
import TeamStatus from './TeamStatus.vue';

const race = useRace();
const data = ref<any>(null);
// Spin only until the first response; with no episode or no teams show an empty state instead of spinning forever
const loading = ref(true);
let timer: number | undefined;
// Row height is computed so 12 teams exactly fill the grid: fewer teams leave blank space, more teams scroll inside
const ROWS = 12;
const grid = ref<HTMLElement | null>(null);
const rowH = ref(44);
let ro: ResizeObserver | undefined;
function fitRows() {
  const g = grid.value; if (!g) return;
  const head = g.querySelector('.live-row-head') as HTMLElement | null;
  const avail = g.clientHeight - (head?.offsetHeight ?? 34);
  if (avail > 0) rowH.value = Math.max(32, Math.floor(avail / ROWS));
}
/**
 * The live board shows the running episode; otherwise the next pending one; when all are finished, the last one.
 * While a continuous episode overlaps its predecessor both are running: each team shows where it is in the later
 * episode once it has departed there, otherwise in the earlier one.
 */
const liveEpisodes = computed(() => {
  const eps = race.episodes;
  const running = eps.filter((e) => e.status === 'running');
  if (running.length) return running;
  const one = eps.find((e) => e.status === 'pending') ?? eps[eps.length - 1];
  return one ? [one] : [];
});
const liveEpisode = computed(() => liveEpisodes.value[liveEpisodes.value.length - 1] ?? null);
const liveTitle = computed(() => liveEpisodes.value.map((e) => e.code).join(' / ') || '-');
const statusText = computed(() => (!liveEpisode.value ? '暂无赛段' : liveEpisode.value.status === 'running' ? '进行中' : liveEpisode.value.status === 'pending' ? '即将开始' : '已结束'));
async function load() {
  if (!liveEpisodes.value.length) { data.value = null; loading.value = false; return; }
  try {
    const all = await Promise.all(liveEpisodes.value.map((e) => api(`/dashboard/${e.id}`)));
    // later episodes win for teams that have started there; with two episodes each row names its episode
    const tag = (d: any) => d.teams.map((t: any) => ({ ...t, epCode: all.length > 1 ? d.episode.code : '' }));
    const merged = { ...all[0], teams: tag(all[0]) };
    for (const d of all.slice(1)) {
      const later = new Map(tag(d).map((t: any) => [t.id, t]));
      merged.teams = merged.teams.map((t: any) => { const l: any = later.get(t.id); return l?.currentLeg ? l : t; });
    }
    data.value = merged;
  } catch { /* keep last */ } finally { loading.value = false; }
  await nextTick(); fitRows();
}
watch(() => liveEpisodes.value.map((e) => e.id).join(), () => { load(); });
onMounted(() => { load(); timer = window.setInterval(load, 30000); if (grid.value) { ro = new ResizeObserver(fitRows); ro.observe(grid.value); } window.addEventListener('resize', fitRows); fitRows(); });
onUnmounted(() => { clearInterval(timer); ro?.disconnect(); window.removeEventListener('resize', fitRows); });
watch(() => [liveEpisodes.value.map((e) => e.id).join(), race.progress, race.teams, race.episodes], load, { deep: true });
</script>

<template>
  <div class="card live-card">
    <div class="live-head">
      <span class="section-title">{{ liveTitle }} 队伍当前位置</span>
      <span class="text-xs text-gray">{{ statusText }}</span>
    </div>
    <div ref="grid" class="live-grid" :style="{ '--row-h': rowH + 'px' }">
      <div v-if="loading" class="loading"><span class="spinner"></span></div>
      <div v-else-if="!data" class="empty-state">暂无赛段</div>
      <div v-else-if="!data.teams.length" class="empty-state">暂无队伍</div>
      <template v-else>
      <div class="live-row live-row-head">
        <div>队伍</div><div>当前环节</div><div>最近记录</div><div>余额（{{ moneyUnit() }}）</div>
      </div>
      <div v-for="t in data.teams" :key="t.id" class="live-row">
        <div class="live-team"><strong>{{ t.label }}</strong><TeamStatus v-if="t.status !== 'alive'" :status="t.status" /></div>
        <div class="live-leg">
          <span v-if="t.epCode" class="text-xs text-gray live-ep">{{ t.epCode }}</span>
          <template v-if="t.finished"><span class="text-success">已到中继站</span></template>
          <template v-else-if="t.currentLeg"><LegTag :type="t.currentLeg.type" /> <span class="live-legname">{{ legName(t.currentLeg) }}</span></template>
          <span v-else class="text-gray">未出发</span>
        </div>
        <div class="live-time"><span class="record-time">{{ fmtTime(t.lastActivity) }}</span></div>
        <div class="live-money">{{ fmtMoney(t.currency) }}</div>
      </div>
      </template>
    </div>
  </div>
</template>
