<script setup lang="ts">
import { computed } from 'vue';
import { useRace } from '@/stores/race';
import { fmtDateTime } from '@/utils/time';
import { typeCode } from '@/types';

const race = useRace();
const ep = computed(() => race.currentEpisode);
const legs = computed(() => (ep.value?.legs ?? []).filter((l) => l.record_mode !== 'none'));
const hhmm = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String((d.getUTCHours() + 8) % 24).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
function cell(teamId: number, legId: number) {
  const p = race.progressOf(teamId, legId);
  if (!p) return { cls: 'mx-empty', text: '', title: '' };
  if (p.completed_at) return { cls: 'mx-done', text: hhmm(p.completed_at), title: `到达 ${fmtDateTime(p.arrived_at)}\n完成 ${fmtDateTime(p.completed_at)}` };
  if (p.arrived_at) return { cls: 'mx-arrived', text: hhmm(p.arrived_at), title: `到达 ${fmtDateTime(p.arrived_at)}，未完成` };
  return { cls: 'mx-empty', text: '', title: '' };
}
const doneCount = (legId: number) => race.aliveTeams.filter((t) => race.progressOf(t.id, legId)?.completed_at).length;
</script>

<template>
  <div class="matrix">
    <div class="matrix-head">
      <span class="section-title">{{ ep?.code ?? '-' }} 进度</span>
      <span class="text-xs text-gray">绿 = 完成，黄 = 已到达</span>
    </div>
    <div v-if="!ep" class="text-gray text-sm">暂无赛段</div>
    <div v-else class="matrix-scroll">
      <table class="mx-table">
        <thead>
          <tr>
            <th class="mx-team">队伍</th>
            <th v-for="l in legs" :key="l.id" :title="l.name"><span class="tag mx-tag" :class="'tag-' + l.type">{{ typeCode(l.type) }}</span><div class="mx-count">{{ doneCount(l.id) }}/{{ race.aliveTeams.length }}</div></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in race.teams" :key="t.id" :class="{ 'mx-dead': t.status !== 'alive' }">
            <td class="mx-team" :title="t.label"><strong>{{ t.name }}</strong></td>
            <td v-for="l in legs" :key="l.id" class="mx-cell" :class="cell(t.id, l.id).cls" :title="cell(t.id, l.id).title">{{ cell(t.id, l.id).text || '·' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
