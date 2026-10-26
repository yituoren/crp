<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { fmtTime, fmtTimeSec, fmtDurMs } from '@/utils/time';
import { legName, endLabel, startLabel, hasStart, type LegType } from '@/types';
import EpSelector from '@/components/EpSelector.vue';
import LegTag from '@/components/LegTag.vue';
import PenaltyPanel from '@/components/PenaltyPanel.vue';
import TeamStatus from '@/components/TeamStatus.vue';

const auth = useAuth();
const race = useRace();
const ep = computed(() => race.currentEpisode);
const allLegs = computed(() => ep.value?.legs ?? []);
/** Matrix column groups: side quests join the main leg's group instead of forming their own */
const legs = computed(() => allLegs.value.filter((l) => l.type !== 'SQ'));
const branchOf = (l: { id: number }) => { const i = allLegs.value.findIndex((x) => x.id === l.id); const n = allLegs.value[i + 1]; return n && n.type === 'SQ' ? n : null; };

// durations of running legs use the current time, refreshed every 15 s
const now = ref(Date.now() + auth.serverOffsetMs);
let timer: number | undefined;
onMounted(() => { timer = window.setInterval(() => { now.value = Date.now() + auth.serverOffsetMs; }, 15000); });
onUnmounted(() => clearInterval(timer));

/** Time spent on the side quest (subtracted from the main leg): actual when ended, otherwise until now (or the main leg's end) */
function branchElapsed(teamId: number, legId: number, mainEndMs: number | null): number {
  const br = branchOf({ id: legId }); if (!br) return 0;
  const bp = race.progressOf(teamId, br.id); if (!bp?.arrived_at) return 0;
  const s = new Date(bp.arrived_at).getTime();
  const e = bp.completed_at ? new Date(bp.completed_at).getTime() : (mainEndMs ?? now.value);
  return Math.max(0, e - s);
}
function cell(teamId: number, legId: number, single: boolean, isPs = false) {
  const p = race.progressOf(teamId, legId);
  // single-column legs only look at the end time (completed_at)
  if (single) return p?.completed_at ? { start: (isPs ? fmtTimeSec : fmtTime)(p.completed_at), end: '-', dur: '-', cls: 'mx-done' } : { start: '-', end: '-', dur: '-', cls: '' };
  if (!p || !p.arrived_at) return { start: '-', end: p?.completed_at ? fmtTime(p.completed_at) : '-', dur: '-', cls: p?.completed_at ? 'mx-done' : '' };
  const startMs = new Date(p.arrived_at).getTime();
  if (p.completed_at) { const endMs = new Date(p.completed_at).getTime(); return { start: fmtTime(p.arrived_at), end: (isPs ? fmtTimeSec : fmtTime)(p.completed_at), dur: fmtDurMs(endMs - startMs - branchElapsed(teamId, legId, endMs)), cls: 'mx-done' }; }
  return { start: fmtTime(p.arrived_at), end: '进行中', dur: fmtDurMs(now.value - startMs - branchElapsed(teamId, legId, null)), cls: 'mx-arrived' };
}
/** Side quest columns: start / end / duration */
function branchCell(teamId: number, legId: number) {
  const br = branchOf({ id: legId }); const bp = br ? race.progressOf(teamId, br.id) : null;
  if (!bp?.arrived_at) return { start: '-', end: '-', dur: '-', cls: '' };
  const s = new Date(bp.arrived_at).getTime();
  if (bp.completed_at) return { start: fmtTime(bp.arrived_at), end: fmtTime(bp.completed_at), dur: fmtDurMs(new Date(bp.completed_at).getTime() - s), cls: 'mx-done' };
  return { start: fmtTime(bp.arrived_at), end: '进行中', dur: fmtDurMs(now.value - s), cls: 'mx-arrived' };
}
/** Legs with extra info get extra columns at the end of the group; pit stops get "penalty" and "final" */
function extraCols(l: { type: string }): string[] {
  if (l.type === 'DT') return ['绕道选择'];
  if (l.type === 'RB') return ['完成人'];
  if (l.type === 'FF') return ['快进结果'];
  if (l.type === 'UT' || l.type === 'YD') return ['施加对象'];
  if (l.type === 'Union') return ['合作队伍'];
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
  if (l.type === 'UT' || l.type === 'YD' || l.type === 'Union') return p.target_team_id ? race.teamById.get(p.target_team_id)?.label ?? '-' : '-';
  return '-';
}
/** Cell contents: start / end / duration */
const isSingleCol = (l: { type: string }) => !hasStart(l.type as LegType);
const colspanOf = (l: { id: number; type: string }) => (isSingleCol(l) ? 1 : 3) + (branchOf(l) ? 3 : 0) + extraCols(l).length;
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

// ---- Standings: live ranks ----
// Teams at the pit stop come first by check-in + net penalty (server rank); the rest by progress depth (which leg, started or completed), ties by the latest record time (earlier first); unstarted teams in team order; withdrawn teams last and unranked
const finalRank = computed(() => new Map(race.pitstop.map((r) => [r.team_id, r.rank])));
function progressKey(teamId: number): { depth: number; t: number } {
  let depth = 0, t = 0;
  legs.value.forEach((l, i) => {
    const p = race.progressOf(teamId, l.id);
    if (p?.completed_at && 2 * i + 2 > depth) { depth = 2 * i + 2; t = new Date(p.completed_at).getTime(); }
    if (p?.arrived_at && 2 * i + 1 > depth) { depth = 2 * i + 1; t = new Date(p.arrived_at).getTime(); }
  });
  return { depth, t };
}
const orderedTeams = computed(() => {
  const idx = new Map(race.teams.map((t, i) => [t.id, i]));
  const key = new Map(race.teams.map((t) => [t.id, progressKey(t.id)]));
  return [...race.teams].sort((a, b) => {
    const wa = a.status === 'withdrawn' ? 1 : 0, wb = b.status === 'withdrawn' ? 1 : 0;
    if (wa !== wb) return wa - wb;
    const ra = finalRank.value.get(a.id) ?? null, rb = finalRank.value.get(b.id) ?? null;
    if (ra && rb) return ra - rb;
    if (ra || rb) return ra ? -1 : 1;
    const ka = key.get(a.id)!, kb = key.get(b.id)!;
    if (ka.depth !== kb.depth) return kb.depth - ka.depth;
    if (ka.t !== kb.t) return ka.t - kb.t;
    return idx.get(a.id)! - idx.get(b.id)!;
  });
});
const rankOf = computed(() => { const m = new Map<number, number>(); let n = 0; for (const t of orderedTeams.value) if (t.status !== 'withdrawn') m.set(t.id, ++n); return m; });
</script>

<template>
  <EpSelector />

  <!-- Progress matrix -->
  <div class="card card-table">
    <div class="card-header"><span>进度结算</span></div>
    <div v-if="!legs.length" class="empty-state">本赛段没有需要记录的环节</div>
    <div v-else class="matrix-scroll">
      <table class="table mx2">
        <thead>
          <tr>
            <th class="mx2-team" rowspan="2">队伍</th>
            <th v-for="l in legs" :key="l.id" :colspan="colspanOf(l)" class="mx2-leg mx2-first mx2-last">
              <span class="mx2-leg-title"><LegTag :type="l.type" /><span>{{ legName(l) }}</span></span>
              <span v-if="branchOf(l)" class="mx2-leg-title mx2-leg-branch"><LegTag type="SQ" /><span>{{ legName(branchOf(l)!) }}</span></span>
            </th>
          </tr>
          <tr>
            <template v-for="l in legs" :key="l.id">
              <th v-if="isSingleCol(l)" class="mx2-sub mx2-first" :class="{ 'mx2-last': !extraCol(l) }">{{ endLabel(l.type) }}</th>
              <template v-else>
                <th class="mx2-sub mx2-first">{{ startLabel(l.type) }}</th>
                <template v-if="branchOf(l)"><th class="mx2-sub mx2-branch" :title="legName(branchOf(l)!)">支线开始</th><th class="mx2-sub mx2-branch">支线结束</th><th class="mx2-sub mx2-branch">支线用时</th></template>
                <th class="mx2-sub">{{ endLabel(l.type) }}</th><th class="mx2-sub" :class="{ 'mx2-last': !extraCol(l) }">用时</th>
              </template>
              <th v-for="(c, i) in extraCols(l)" :key="c" class="mx2-sub" :class="{ 'mx2-last': i === extraCols(l).length - 1 }">{{ c }}</th>
            </template>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in orderedTeams" :key="t.id" :class="{ 'mx-dead': t.status !== 'alive' }">
            <td class="mx2-team">
              <div class="flex" style="gap: 6px; flex-wrap: nowrap"><span v-if="rankOf.get(t.id)" class="mx2-rank" :class="'rank-' + rankOf.get(t.id)">#{{ rankOf.get(t.id) }}</span><strong><span class="mx2-team-full">{{ t.label }}</span><span class="mx2-team-short">{{ t.name }}</span></strong><TeamStatus :status="t.status" class="mx2-team-status" /></div>
              <div class="text-xs text-gray mx2-team-ago">{{ lastAgo(t.id) || '尚无记录' }}</div>
            </td>
            <template v-for="l in legs" :key="l.id">
              <template v-if="isSingleCol(l)">
                <td class="mx2-cell mx2-first" :class="[cell(t.id, l.id, true, l.type === 'PS').cls, { 'mx2-last': !extraCol(l) }]">{{ cell(t.id, l.id, true, l.type === 'PS').start }}</td>
              </template>
              <template v-else>
                <td class="mx2-cell mx2-first" :class="cell(t.id, l.id, false, l.type === 'PS').cls">{{ cell(t.id, l.id, false, l.type === 'PS').start }}</td>
                <template v-if="branchOf(l)">
                  <td class="mx2-cell mx2-branch" :class="branchCell(t.id, l.id).cls">{{ branchCell(t.id, l.id).start }}</td>
                  <td class="mx2-cell mx2-branch" :class="branchCell(t.id, l.id).cls">{{ branchCell(t.id, l.id).end }}</td>
                  <td class="mx2-cell mx2-branch" :class="branchCell(t.id, l.id).cls">{{ branchCell(t.id, l.id).dur }}</td>
                </template>
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

  <!-- Penalties and credits -->
  <PenaltyPanel />

</template>
