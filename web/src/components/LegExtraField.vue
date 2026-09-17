<script setup lang="ts">
import { computed } from 'vue';
import { useRace } from '@/stores/race';
import { useRecord } from '@/composables/record';
import type { Leg, Progress } from '@/types';

// 环节附加信息：绕道选择 / 路障完成人 / 快进结果 / 回转·让路施加对象
const props = defineProps<{ leg: Leg; teamId: number; progress: Progress | null; can: boolean }>();
const race = useRace();
const rec = useRecord();
const kind = computed(() => {
  const t = props.leg.type;
  if (t === 'DT') return 'detour';
  if (t === 'RB') return 'roadblock';
  if (t === 'FF') return 'ff';
  if (t === 'UT' || t === 'YD') return 'target';
  return null;
});
const detourOptions = computed(() => [props.leg.detour_a || 'A', props.leg.detour_b || 'B']);
const others = computed(() => race.teams.filter((x) => x.id !== props.teamId));
const text = computed(() => {
  const p = props.progress;
  switch (kind.value) {
    case 'detour': return p?.detour_choice || '-';
    case 'roadblock': return p?.roadblock_by || '-';
    case 'ff': return p?.ff_result === 'success' ? '成功' : p?.ff_result === 'fail' ? '失败' : '-';
    case 'target': return p?.target_team_id ? race.teamById.get(p.target_team_id)?.label ?? '-' : '-';
    default: return '';
  }
});
</script>

<template>
  <template v-if="!kind"><span class="text-gray">-</span></template>
  <template v-else-if="!can"><span>{{ text }}</span></template>
  <select v-else-if="kind === 'detour'" class="input-sm input-inline extra-ctl" :value="progress?.detour_choice ?? ''" @change="rec.setValue('detour', teamId, leg.id, ($event.target as HTMLSelectElement).value)">
    <option value="">绕道未选</option>
    <option v-for="o in detourOptions" :key="o" :value="o">{{ o }}</option>
  </select>
  <select v-else-if="kind === 'roadblock'" class="input-sm input-inline extra-ctl" :value="progress?.roadblock_by ?? ''" @change="rec.setValue('roadblock', teamId, leg.id, ($event.target as HTMLSelectElement).value)">
    <option value="">路障完成人</option>
    <option v-for="m in race.memberOptions(teamId, progress?.roadblock_by)" :key="m" :value="m">{{ m }}</option>
  </select>
  <select v-else-if="kind === 'ff'" class="input-sm input-inline extra-ctl" :value="progress?.ff_result ?? ''" @change="rec.setValue('ff', teamId, leg.id, ($event.target as HTMLSelectElement).value)">
    <option value="">快进未尝试</option><option value="success">快进成功</option><option value="fail">快进失败</option>
  </select>
  <select v-else class="input-sm input-inline extra-ctl" :value="progress?.target_team_id ?? ''" @change="rec.setValue('target', teamId, leg.id, ($event.target as HTMLSelectElement).value)">
    <option value="">未使用</option>
    <option v-for="t in others" :key="t.id" :value="t.id">{{ t.label }}</option>
  </select>
</template>
