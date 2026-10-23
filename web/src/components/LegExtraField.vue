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
  <MSelect v-else-if="kind === 'detour'" sm class="extra-ctl" :model-value="progress?.detour_choice ?? ''" :options="[{ value: '', label: '绕道未选' }, ...detourOptions.map((o) => ({ value: o, label: o }))]" @update:model-value="rec.setValue('detour', teamId, leg.id, String($event))" />
  <MSelect v-else-if="kind === 'roadblock'" sm class="extra-ctl" :model-value="progress?.roadblock_by ?? ''" placeholder="路障完成人" :options="race.memberOptions(teamId, progress?.roadblock_by).map((m) => ({ value: m, label: m }))" @update:model-value="rec.setValue('roadblock', teamId, leg.id, String($event))" />
  <MSelect v-else-if="kind === 'ff'" sm class="extra-ctl" :model-value="progress?.ff_result ?? ''" :options="[{ value: '', label: '快进未尝试' }, { value: 'success', label: '快进成功' }, { value: 'fail', label: '快进失败' }]" @update:model-value="rec.setValue('ff', teamId, leg.id, String($event))" />
  <MSelect v-else sm class="extra-ctl" :model-value="progress?.target_team_id ?? ''" :options="[{ value: '', label: '未使用' }, ...others.map((t) => ({ value: t.id, label: t.label }))]" @update:model-value="rec.setValue('target', teamId, leg.id, String($event))" />
</template>
