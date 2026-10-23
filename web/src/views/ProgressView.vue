<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { fmtTime, fmtTimeSec, fmtDurMs } from '@/utils/time';
import { legName, endLabel, hasStart, type LegType } from '@/types';
import EpSelector from '@/components/EpSelector.vue';
import LegTag from '@/components/LegTag.vue';
import PenaltyPanel from '@/components/PenaltyPanel.vue';
import TeamStatus from '@/components/TeamStatus.vue';

const auth = useAuth();
const race = useRace();
const ep = computed(() => race.currentEpisode);
const legs = computed(() => ep.value?.legs ?? []);

// 进行中的用时按当前时间计算，每 15 秒刷新一次
const now = ref(Date.now() + auth.serverOffsetMs);
let timer: number | undefined;
onMounted(() => { timer = window.setInterval(() => { now.value = Date.now() + auth.serverOffsetMs; }, 15000); });
onUnmounted(() => clearInterval(timer));

function cell(teamId: number, legId: number, single: boolean, isPs = false) {
  const p = race.progressOf(teamId, legId);
  // 起跑线没有开始时间，只看出发（completed_at）
  if (single) return p?.completed_at ? { start: (isPs ? fmtTimeSec : fmtTime)(p.completed_at), end: '-', dur: '-', cls: 'mx-done' } : { start: '-', end: '-', dur: '-', cls: '' };
  if (!p || !p.arrived_at) return { start: '-', end: p?.completed_at ? fmtTime(p.completed_at) : '-', dur: '-', cls: p?.completed_at ? 'mx-done' : '' };
  const startMs = new Date(p.arrived_at).getTime();
  if (p.completed_at) return { start: fmtTime(p.arrived_at), end: (isPs ? fmtTimeSec : fmtTime)(p.completed_at), dur: fmtDurMs(new Date(p.completed_at).getTime() - startMs), cls: 'mx-done' };
  return { start: fmtTime(p.arrived_at), end: '进行中', dur: fmtDurMs(now.value - startMs), cls: 'mx-arrived' };
}
/** 需要附加信息的环节在组末尾多几列；中继站多“罚时”“结算”两列 */
function extraCols(l: { type: string }): string[] {
  if (l.type === 'DT') return ['绕道选择'];
  if (l.type === 'RB') return ['完成人'];
  if (l.type === 'FF') return ['快进结果'];
  if (l.type === 'UT' || l.type === 'YD') return ['施加对象'];
  if (l.type === 'PS') return ['罚时', '结算'];
  return [];
}
const extraCol = (l: { type: string }) => extraCols(l).length > 0;
function extraVal(teamId: number, l: { id: number; type: string }, i = 0): string {
  if (l.type === 'PS') {
    const r = race.pitstop.find((x) => x.team_id === teamId);
    if (i === 0) return !r || !r.penalty_minutes ? '-' : r.penalty_minutes > 0 ? `+${r.penalty_minutes} 分` : `${r.penalty_minutes} 分`;
    return r?.final_time ? fmtTimeSec(r.final_time) : '-';
  }
  const p = race.progressOf(teamId, l.id);
  if (!p) return '-';
  if (l.type === 'DT') return p.detour_choice || '-';
  if (l.type === 'RB') return p.roadblock_by || '-';
  if (l.type === 'FF') return p.ff_result === 'success' ? '成功' : p.ff_result === 'fail' ? '失败' : '-';
  if (l.type === 'UT' || l.type === 'YD') return p.target_team_id ? race.teamById.get(p.target_team_id)?.label ?? '-' : '-';
  return '-';
}
/** 起跑线只有“出发”一列；其余环节：开始 / 结束 / 用时 */
const isSingleCol = (l: { type: string }) => !hasStart(l.type as LegType);
const colspanOf = (l: { type: string }) => (isSingleCol(l) ? 1 : 3) + extraCols(l).length;
function lastAgo(teamId: number): string {
  let last = 0;
  for (const l of legs.value) {
    const p = race.progressOf(teamId, l.id);
    for (const t of [p?.arrived_at, p?.completed_at]) if (t) last = Math.max(last, new Date(t).getTime());
  }
  if (!last) return '';
  const m = Math.max(0, Math.floor((now.value - last) / 60000));
  return `${m} 分钟前`;
}

// ---- 进度结算：矩阵行按实时名次排列（有名次的在前，其余按队伍顺序） ----
const rankOf = computed(() => new Map(race.pitstop.map((r) => [r.team_id, r.rank])));
const orderedTeams = computed(() => {
  const idx = new Map(race.teams.map((t, i) => [t.id, i]));
  return [...race.teams].sort((a, b) => (rankOf.value.get(a.id) ?? 999) - (rankOf.value.get(b.id) ?? 999) || (idx.get(a.id)! - idx.get(b.id)!));
});
</script>

<template>
  <EpSelector />

  <!-- 进度矩阵 -->
  <div class="card">
    <div class="card-header"><span>进度结算</span><span class="text-xs text-gray">按实时名次排列：名次 = 签到时间 + 净罚时；绿 = 已完成，黄 = 进行中</span></div>
    <div v-if="!legs.length" class="empty-state">本赛段没有需要记录的环节</div>
    <div v-else class="matrix-scroll">
      <table class="table mx2">
        <thead>
          <tr>
            <th class="mx2-team" rowspan="2">队伍</th>
            <th v-for="l in legs" :key="l.id" :colspan="colspanOf(l)" class="mx2-leg mx2-first mx2-last"><LegTag :type="l.type" /> {{ legName(l) }}</th>
          </tr>
          <tr>
            <template v-for="l in legs" :key="l.id">
              <th v-if="isSingleCol(l)" class="mx2-sub mx2-first" :class="{ 'mx2-last': !extraCol(l) }">{{ endLabel(l.type) }}</th>
              <template v-else><th class="mx2-sub mx2-first">开始</th><th class="mx2-sub">{{ endLabel(l.type) }}</th><th class="mx2-sub" :class="{ 'mx2-last': !extraCol(l) }">用时</th></template>
              <th v-for="(c, i) in extraCols(l)" :key="c" class="mx2-sub" :class="{ 'mx2-last': i === extraCols(l).length - 1 }">{{ c }}</th>
            </template>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in orderedTeams" :key="t.id" :class="{ 'mx-dead': t.status !== 'alive' }">
            <td class="mx2-team">
              <div class="flex" style="gap: 6px; flex-wrap: nowrap"><span v-if="rankOf.get(t.id)" class="mx2-rank" :class="'rank-' + rankOf.get(t.id)">#{{ rankOf.get(t.id) }}</span><strong>{{ t.label }}</strong><TeamStatus :status="t.status" /></div>
              <div class="text-xs text-gray">{{ lastAgo(t.id) || '尚无记录' }}</div>
            </td>
            <template v-for="l in legs" :key="l.id">
              <template v-if="isSingleCol(l)">
                <td class="mx2-cell mx2-first" :class="[cell(t.id, l.id, true, l.type === 'PS').cls, { 'mx2-last': !extraCol(l) }]">{{ cell(t.id, l.id, true, l.type === 'PS').start }}</td>
              </template>
              <template v-else>
                <td class="mx2-cell mx2-first" :class="cell(t.id, l.id, false, l.type === 'PS').cls">{{ cell(t.id, l.id, false, l.type === 'PS').start }}</td>
                <td class="mx2-cell" :class="cell(t.id, l.id, false, l.type === 'PS').cls">{{ cell(t.id, l.id, false, l.type === 'PS').end }}</td>
                <td class="mx2-cell" :class="[cell(t.id, l.id, false, l.type === 'PS').cls, { 'mx2-last': !extraCol(l) }]">{{ cell(t.id, l.id, false, l.type === 'PS').dur }}</td>
              </template>
              <td v-for="(c, i) in extraCols(l)" :key="c" class="mx2-cell mx2-extra" :class="{ 'mx2-last': i === extraCols(l).length - 1 }">{{ extraVal(t.id, l, i) }}</td>
            </template>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- 罚时与补时 -->
  <PenaltyPanel />

</template>
