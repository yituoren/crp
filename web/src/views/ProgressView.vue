<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { fmtTime, fmtTimeSec, fmtDurMs } from '@/utils/time';
import { legName, endLabel, startLabel, hasStart, typeCode, type LegType } from '@/types';
import { exportProgressXlsx, type ExportCell, type ExportGroup, type ExportRow } from '@/utils/progressExport';
import { useUi } from '@/stores/ui';
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
/**
 * Teams shown in this episode: a team that was eliminated or withdrew in an earlier episode is left out; in the episode
 * where it stopped it still shows (greyed, later legs empty). The stop leg is the elimination leg, or for a withdrawal
 * the first locked leg; a withdrawal after the last leg (nothing locked) keeps the team everywhere.
 */
const epIndex = computed(() => new Map(race.episodes.map((e, i) => [e.id, i])));
const visibleTeams = computed(() => {
  const cur = epIndex.value.get(ep.value?.id ?? 0) ?? 0;
  return race.teams.filter((t) => {
    if (t.status === 'alive') return true;
    const stopLeg = t.status === 'eliminated' ? t.eliminated_leg_id : t.locked_from_leg_id;
    const stopEp = stopLeg ? race.legById.get(stopLeg)?.episode_id : null;
    return stopEp == null || (epIndex.value.get(stopEp) ?? cur) >= cur;
  });
});
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
  const key = new Map(visibleTeams.value.map((t) => [t.id, progressKey(t.id)]));
  return [...visibleTeams.value].sort((a, b) => {
    const wa = a.status !== 'alive' ? 1 : 0, wb = b.status !== 'alive' ? 1 : 0; // eliminated and withdrawn teams go last, unranked
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
const rankOf = computed(() => { const m = new Map<number, number>(); let n = 0; for (const t of orderedTeams.value) if (t.status === 'alive') m.set(t.id, ++n); return m; });
/** Cell background by column kind (shared with the export): times, durations / penalties, task details, blanks */
type CellKind = 'time' | 'dur' | 'extra';
const kindCls = (text: string, kind: CellKind) => (text === '-' ? 'mx2-c-blank' : `mx2-c-${kind}`);
/** Extra columns: pit stop penalty counts as a duration, the settled time as a time, the rest are task details */
const extraKind = (l: { type: string }, i: number): CellKind => (l.type === 'PS' ? (i === 0 ? 'dur' : 'time') : 'extra');

// ---- Export (.xlsx): the on-screen columns plus a rank per leg, teams in number order, full team labels ----
const ui = useUi();
/** Rank on a leg by the time it was finished (pit stop: settled time = check-in + net penalty); equal times share a rank */
function legRanks(l: { id: number; type: string }): Map<number, number> {
  const done: { id: number; t: number }[] = [];
  for (const tm of visibleTeams.value) {
    const fin = l.type === 'PS' ? race.pitstop.find((x) => x.team_id === tm.id)?.final_time ?? race.progressOf(tm.id, l.id)?.completed_at : race.progressOf(tm.id, l.id)?.completed_at;
    if (fin) done.push({ id: tm.id, t: new Date(fin).getTime() });
  }
  done.sort((a, b) => a.t - b.t);
  const m = new Map<number, number>();
  done.forEach((x, i) => m.set(x.id, i > 0 && x.t === done[i - 1]!.t ? m.get(done[i - 1]!.id)! : i + 1));
  return m;
}
const exporting = ref(false);
async function exportXlsx() {
  const e = ep.value; if (!e) return;
  const state = (cls: string) => (cls === 'mx-done' ? 'done' as const : cls === 'mx-arrived' ? 'arrived' as const : undefined);
  const cellOf = (text: string, kind: CellKind | 'rank', cls = ''): ExportCell => ({ text, kind: text === '-' ? 'blank' : kind, state: state(cls) });
  const groups: ExportGroup[] = legs.value.map((l) => {
    const br = branchOf(l);
    const subs = isSingleCol(l)
      ? [{ label: endLabel(l.type) }]
      : [{ label: startLabel(l.type) }, ...(br ? [{ label: '支线开始', branch: true }, { label: '支线结束', branch: true }, { label: '支线用时', branch: true }] : []), { label: endLabel(l.type) }, { label: '用时' }];
    // the rank is the last column of every leg group
    return { title: `${typeCode(l.type)} · ${legName(l)}${br ? `　/　SQ · ${legName(br)}` : ''}`, type: l.type, subs: [...subs, ...extraCols(l).map((c) => ({ label: c })), { label: '排名' }] };
  });
  const ranks = legs.value.map((l) => legRanks(l));
  // teams in number order (race.teams is sorted by number), only those shown in this episode
  const rows: ExportRow[] = visibleTeams.value.map((t) => ({
    label: t.full_label,
    dead: t.status === 'withdrawn', // only withdrawn teams are greyed; eliminated ones keep normal colours
    groups: legs.value.map((l, li) => {
      const isPs = l.type === 'PS';
      const r = ranks[li]!.get(t.id);
      const tail = [...extraCols(l).map((_, i) => cellOf(extraVal(t.id, l, i), extraKind(l, i))), cellOf(r ? String(r) : '-', 'rank')];
      if (isSingleCol(l)) { const c = cell(t.id, l.id, true, isPs); return [cellOf(c.start, 'time', c.cls), ...tail]; }
      const c = cell(t.id, l.id, false, isPs); const b = branchCell(t.id, l.id);
      return [
        cellOf(c.start, 'time', c.cls),
        ...(branchOf(l) ? [cellOf(b.start, 'time', b.cls), cellOf(b.end, 'time', b.cls), cellOf(b.dur, 'dur', b.cls)] : []),
        cellOf(c.end, 'time', c.cls), cellOf(c.dur, 'dur', c.cls),
        ...tail,
      ];
    }),
  }));
  const day = new Date(now.value).toISOString().slice(0, 10);
  exporting.value = true;
  try { await exportProgressXlsx({ title: `${e.code} 进度结算`, groups, rows }, `${auth.event.name}_${e.code}_进度结算_${day}.xlsx`); }
  catch (err) { ui.error(err); }
  finally { exporting.value = false; }
}
</script>

<template>
  <EpSelector />

  <!-- Progress matrix -->
  <div class="card card-table">
    <div class="card-header"><span>进度结算</span><button v-if="legs.length" class="btn btn-text btn-sm" :disabled="exporting" @click="exportXlsx"><Icon name="download" size="16" />{{ exporting ? '导出中…' : '导出表格' }}</button></div>
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
          <tr v-for="t in orderedTeams" :key="t.id" :class="{ 'mx-dead': t.status === 'withdrawn' }">
            <td class="mx2-team">
              <div class="flex" style="gap: 6px; flex-wrap: nowrap"><span v-if="rankOf.get(t.id)" class="mx2-rank" :class="'rank-' + rankOf.get(t.id)">#{{ rankOf.get(t.id) }}</span><strong><span class="mx2-team-full">{{ t.full_label }}</span><span class="mx2-team-short">{{ t.name }}</span></strong><TeamStatus :status="t.status" class="mx2-team-status" /></div>
              <div class="text-xs text-gray mx2-team-ago">{{ lastAgo(t.id) || '尚无记录' }}</div>
            </td>
            <template v-for="l in legs" :key="l.id">
              <template v-if="isSingleCol(l)">
                <td class="mx2-cell mx2-first" :class="[cell(t.id, l.id, true, l.type === 'PS').cls, kindCls(cell(t.id, l.id, true, l.type === 'PS').start, 'time'), { 'mx2-last': !extraCol(l) }]">{{ cell(t.id, l.id, true, l.type === 'PS').start }}</td>
              </template>
              <template v-else>
                <td class="mx2-cell mx2-first" :class="[cell(t.id, l.id, false, l.type === 'PS').cls, kindCls(cell(t.id, l.id, false, l.type === 'PS').start, 'time')]">{{ cell(t.id, l.id, false, l.type === 'PS').start }}</td>
                <template v-if="branchOf(l)">
                  <td class="mx2-cell mx2-branch" :class="[branchCell(t.id, l.id).cls, kindCls(branchCell(t.id, l.id).start, 'time')]">{{ branchCell(t.id, l.id).start }}</td>
                  <td class="mx2-cell mx2-branch" :class="[branchCell(t.id, l.id).cls, kindCls(branchCell(t.id, l.id).end, 'time')]">{{ branchCell(t.id, l.id).end }}</td>
                  <td class="mx2-cell mx2-branch" :class="[branchCell(t.id, l.id).cls, kindCls(branchCell(t.id, l.id).dur, 'dur')]">{{ branchCell(t.id, l.id).dur }}</td>
                </template>
                <td class="mx2-cell" :class="[cell(t.id, l.id, false, l.type === 'PS').cls, kindCls(cell(t.id, l.id, false, l.type === 'PS').end, 'time')]">{{ cell(t.id, l.id, false, l.type === 'PS').end }}</td>
                <td class="mx2-cell" :class="[cell(t.id, l.id, false, l.type === 'PS').cls, kindCls(cell(t.id, l.id, false, l.type === 'PS').dur, 'dur'), { 'mx2-last': !extraCol(l) }]">{{ cell(t.id, l.id, false, l.type === 'PS').dur }}</td>
              </template>
              <td v-for="(c, i) in extraCols(l)" :key="c" class="mx2-cell mx2-extra" :class="[kindCls(extraVal(t.id, l, i), extraKind(l, i)), { 'mx2-last': i === extraCols(l).length - 1 }]">{{ extraVal(t.id, l, i) }}</td>
            </template>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Penalties and credits -->
  <PenaltyPanel />

</template>
