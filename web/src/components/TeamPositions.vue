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
/** The live board shows the running episode; otherwise the next pending one; when all are finished, the last one */
const liveEpisode = computed(() => {
  const eps = race.episodes;
  return eps.find((e) => e.status === 'running') ?? eps.find((e) => e.status === 'pending') ?? eps[eps.length - 1] ?? null;
});
const statusText = computed(() => (!liveEpisode.value ? '暂无赛段' : liveEpisode.value.status === 'running' ? '进行中' : liveEpisode.value.status === 'pending' ? '即将开始' : '已结束'));
async function load() {
  if (!liveEpisode.value) { data.value = null; loading.value = false; return; }
  try { data.value = await api(`/dashboard/${liveEpisode.value.id}`); } catch { /* keep last */ } finally { loading.value = false; }
  await nextTick(); fitRows();
}
watch(() => liveEpisode.value?.id, () => { load(); });
onMounted(() => { load(); timer = window.setInterval(load, 30000); if (grid.value) { ro = new ResizeObserver(fitRows); ro.observe(grid.value); } window.addEventListener('resize', fitRows); fitRows(); });
onUnmounted(() => { clearInterval(timer); ro?.disconnect(); window.removeEventListener('resize', fitRows); });
watch(() => [liveEpisode.value?.id, race.progress, race.teams, race.episodes], load, { deep: true });
</script>

<template>
  <div class="card live-card">
    <div class="live-head">
      <span class="section-title">{{ liveEpisode?.code ?? '-' }} 队伍当前位置</span>
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
      <div v-for="t in data.teams" :key="t.id" class="live-row" :class="{ 'mx-dead': t.status === 'withdrawn' }">
        <div class="live-team"><strong>{{ t.label }}</strong><TeamStatus v-if="t.status !== 'alive'" :status="t.status" /></div>
        <div class="live-leg">
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
