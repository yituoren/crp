<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { fmtTime, fmtAgo } from '@/utils/time';
import { fmtMoney, moneyUnit } from '@/utils/money';
import LegTag from './LegTag.vue';
import TeamStatus from './TeamStatus.vue';

const race = useRace();
const data = ref<any>(null);
let timer: number | undefined;
/** 大屏只看正在进行的赛段；没有进行中的就看下一个未开始的；都结束了看最后一个 */
const liveEpisode = computed(() => {
  const eps = race.episodes;
  return eps.find((e) => e.status === 'running') ?? eps.find((e) => e.status === 'pending') ?? eps[eps.length - 1] ?? null;
});
const statusText = computed(() => (liveEpisode.value?.status === 'running' ? '进行中' : liveEpisode.value?.status === 'pending' ? '即将开始' : '已结束'));
async function load() {
  if (!liveEpisode.value) return;
  try { data.value = await api(`/dashboard/${liveEpisode.value.id}`); } catch { /* keep last */ }
}
onMounted(() => { load(); timer = window.setInterval(load, 30000); });
onUnmounted(() => clearInterval(timer));
watch(() => [liveEpisode.value?.id, race.progress, race.teams, race.episodes], load, { deep: true });
</script>

<template>
  <div class="card live-card">
    <div class="live-head">
      <span class="section-title">{{ liveEpisode?.code ?? '-' }} 队伍当前位置</span>
      <span class="text-xs text-gray">{{ statusText }} · 实时更新</span>
    </div>
    <div v-if="!data" class="text-gray text-sm">加载中…</div>
    <div v-else class="live-grid">
      <div class="live-row live-row-head">
        <div>队伍</div><div>当前环节</div><div>最近记录</div><div class="live-right">余额（{{ moneyUnit() }}）</div>
      </div>
      <div v-for="t in data.teams" :key="t.id" class="live-row" :class="{ 'mx-dead': t.status !== 'alive' }">
        <div class="live-team"><strong>{{ t.label }}</strong><TeamStatus v-if="t.status !== 'alive'" :status="t.status" /></div>
        <div class="live-leg">
          <template v-if="t.finished"><span class="text-success">已到中继站</span></template>
          <template v-else-if="t.currentLeg"><LegTag :type="t.currentLeg.type" /> <span class="live-legname">{{ t.currentLeg.name }}</span><span class="text-xs text-gray"> {{ t.currentLeg.completed ? '已完成' : '进行中' }}</span></template>
          <span v-else class="text-gray">未出发</span>
        </div>
        <div class="live-time"><span class="record-time">{{ fmtTime(t.lastActivity) }}</span><span v-if="t.staleMinutes !== null" class="text-xs text-gray"> · {{ fmtAgo(t.staleMinutes) }}</span></div>
        <div class="live-right live-money">{{ fmtMoney(t.currency) }}</div>
      </div>
    </div>
  </div>
</template>
