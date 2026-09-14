<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { fmtTime, fmtAgo } from '@/utils/time';
import LegTag from './LegTag.vue';
import TeamStatus from './TeamStatus.vue';

const race = useRace();
const data = ref<any>(null);
let timer: number | undefined;
async function load() {
  if (!race.currentEpisode) return;
  try { data.value = await api(`/dashboard/${race.currentEpisode.id}`); } catch { /* keep last */ }
}
onMounted(() => { load(); timer = window.setInterval(load, 30000); });
onUnmounted(() => clearInterval(timer));
watch(() => [race.currentEpisodeId, race.progress, race.teams], load, { deep: true });
</script>

<template>
  <div class="live-panel">
    <div class="live-head">
      <span class="section-title">{{ race.currentEpisode?.code ?? '-' }} 队伍当前位置</span>
      <span class="text-xs text-gray">实时</span>
    </div>
    <div v-if="!data" class="text-gray text-sm">加载中…</div>
    <table v-else class="table live-table">
      <thead><tr><th>队伍</th><th>当前环节</th><th>最近记录</th></tr></thead>
      <tbody>
        <tr v-for="t in data.teams" :key="t.id" :class="{ 'mx-dead': t.status !== 'alive' }">
          <td class="wrap"><strong>{{ t.label }}</strong> <TeamStatus v-if="t.status !== 'alive'" :status="t.status" /></td>
          <td class="wrap">
            <template v-if="t.finished">已到中继站</template>
            <template v-else-if="t.currentLeg"><LegTag :type="t.currentLeg.type" /> {{ t.currentLeg.name }}<span class="text-xs text-gray"> {{ t.currentLeg.completed ? '已完成' : '进行中' }}</span></template>
            <span v-else class="text-gray">未出发</span>
          </td>
          <td><span class="record-time">{{ fmtTime(t.lastActivity) }}</span><div v-if="t.staleMinutes !== null" class="text-xs text-gray">{{ fmtAgo(t.staleMinutes) }}</div></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
