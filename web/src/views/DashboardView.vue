<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { fmtTime, fmtDateTime, fmtAgo } from '@/utils/time';
import EpSelector from '@/components/EpSelector.vue';
import LegTag from '@/components/LegTag.vue';
import TeamStatus from '@/components/TeamStatus.vue';

const race = useRace();
const data = ref<any>(null);
const updatedAt = ref('');
let timer: number | undefined;

async function load() {
  if (!race.currentEpisode) return;
  try { data.value = await api(`/dashboard/${race.currentEpisode.id}`); updatedAt.value = new Date().toISOString(); } catch { /* keep last */ }
}
onMounted(() => { load(); timer = window.setInterval(load, 30000); });
onUnmounted(() => clearInterval(timer));
watch(() => [race.currentEpisodeId, race.progress, race.teams, race.pitstop], load, { deep: true });

const cell = (teamId: number, legId: number) => data.value?.progress.find((p: any) => p.team_id === teamId && p.leg_id === legId);
const matrixLegs = computed(() => (data.value?.legs ?? []).filter((l: any) => l.record_mode !== 'none'));
const ranking = computed(() => (data.value?.pitstop ?? []).filter((r: any) => r.rank).sort((a: any, b: any) => a.rank - b.rank));
const legCompletion = (legId: number) => {
  const alive = (data.value?.teams ?? []).filter((t: any) => t.status === 'alive');
  return `${alive.filter((t: any) => cell(t.id, legId)?.completed_at).length}/${alive.length}`;
};
</script>

<template>
  <EpSelector />
  <div v-if="!data" class="empty-state">加载中…</div>
  <template v-else>
    <div class="flex-between mb-2">
      <div class="section-title">📺 {{ data.episode?.code }} 实时大屏</div>
      <span class="text-xs text-gray">更新于 {{ fmtTime(updatedAt) }} · 每 30 秒自动刷新，有记录时实时刷新</span>
    </div>

    <div v-if="data.alerts.length" class="mb-2">
      <div v-for="(a, i) in data.alerts" :key="i" class="alert" :class="'alert-' + a.level">⚠️ {{ a.text }}</div>
    </div>

    <div class="grid grid-2" style="align-items: start">
      <div class="card">
        <div class="card-header">📍 队伍当前位置</div>
        <div class="scroll-table">
          <table class="table">
            <thead><tr><th>队伍</th><th>状态</th><th>当前环节</th><th>最近记录</th><th>余额</th></tr></thead>
            <tbody>
              <tr v-for="t in data.teams" :key="t.id" :class="{ 'team-stale': t.stale }">
                <td><strong>{{ t.name }}</strong></td>
                <td><TeamStatus :status="t.status" /></td>
                <td>
                  <template v-if="t.finished">🏁 已到终点</template>
                  <template v-else-if="t.currentLeg"><LegTag :type="t.currentLeg.type" /> {{ t.currentLeg.name }} <span class="text-xs text-gray">{{ t.currentLeg.completed ? '已完成' : '进行中' }}</span></template>
                  <span v-else class="text-gray">未出发</span>
                </td>
                <td><span class="record-time">{{ fmtTime(t.lastActivity) }}</span> <span v-if="t.staleMinutes !== null" class="text-xs" :class="t.stale ? 'text-danger' : 'text-gray'">{{ fmtAgo(t.staleMinutes) }}</span></td>
                <td>💰 {{ t.currency }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="card-header">🏆 本赛段名次 <router-link to="/pitstop" class="btn btn-outline btn-sm">去结算</router-link></div>
        <div v-if="!ranking.length" class="text-gray text-sm">尚未结算。队伍到达终点并记录完成后，在「终点结算」点击自动排名。</div>
        <table v-else class="table">
          <thead><tr><th>名次</th><th>队伍</th><th>签到</th><th>罚时</th><th>最终</th></tr></thead>
          <tbody>
            <tr v-for="r in ranking" :key="r.team_id">
              <td :class="'rank-' + r.rank">#{{ r.rank }}</td>
              <td>{{ r.team_name }} <span v-if="r.eliminated" class="status-eliminated">淘汰</span></td>
              <td class="record-time">{{ fmtTime(r.checkin_at) }}</td>
              <td>{{ r.penalty_minutes ? `+${r.penalty_minutes}min` : '-' }}</td>
              <td class="record-time">{{ fmtTime(r.final_time) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-header">🗺️ 进度矩阵（🟩 完成 / 🟨 已到达）</div>
      <div class="scroll-table">
        <table class="table matrix">
          <thead>
            <tr>
              <th>队伍</th>
              <th v-for="l in matrixLegs" :key="l.id" style="text-align: center"><LegTag :type="l.type" /><br /><span class="text-xs">{{ l.name }}</span><br /><span class="text-xs text-gray">{{ legCompletion(l.id) }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in data.teams" :key="t.id" :style="t.status !== 'alive' ? 'opacity:.5' : ''">
              <td><strong>{{ t.name }}</strong></td>
              <td v-for="l in matrixLegs" :key="l.id" class="cell" :class="cell(t.id, l.id)?.completed_at ? 'cell-done' : cell(t.id, l.id)?.arrived_at ? 'cell-arrived' : 'cell-empty'" :title="cell(t.id, l.id) ? `到达 ${fmtDateTime(cell(t.id, l.id).arrived_at)} / 完成 ${fmtDateTime(cell(t.id, l.id).completed_at)}` : ''">
                <template v-if="cell(t.id, l.id)?.completed_at">{{ fmtTime(cell(t.id, l.id).completed_at) }}</template>
                <template v-else-if="cell(t.id, l.id)?.arrived_at">{{ fmtTime(cell(t.id, l.id).arrived_at) }}</template>
                <template v-else>·</template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>
</template>
