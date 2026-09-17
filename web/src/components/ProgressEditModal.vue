<script setup lang="ts">
import { reactive } from 'vue';
import Modal from './Modal.vue';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { toLocalInput, fromLocalInput } from '@/utils/time';
import { legName, endLabel, hasStart, type Leg, type Progress, type Team } from '@/types';
import { useRace as useRaceStore } from '@/stores/race';

const props = defineProps<{ leg: Leg; team: Team; progress: Progress | null }>();
const emit = defineEmits<{ close: [] }>();
const race = useRace();
const ui = useUi();
const form = reactive({
  arrivedAt: toLocalInput(props.progress?.arrived_at),
  completedAt: toLocalInput(props.progress?.completed_at),
  detourChoice: props.progress?.detour_choice ?? '',
  roadblockBy: props.progress?.roadblock_by ?? '',
  ffResult: props.progress?.ff_result ?? '',
  targetTeamId: props.progress?.target_team_id ?? '',
  note: props.progress?.note ?? '',
});
const withStart = hasStart(props.leg.type);
const label = endLabel(props.leg.type);
const teams = useRaceStore().teams;
const detourOptions = [props.leg.detour_a || 'A', props.leg.detour_b || 'B'];

async function save() {
  try {
    await api(`/progress/${props.leg.episode_id}/${props.team.id}/${props.leg.id}`, {
      method: 'PUT',
      body: { ...form, arrivedAt: withStart ? fromLocalInput(form.arrivedAt) : null, completedAt: fromLocalInput(form.completedAt) },
    });
    await race.loadProgress();
    ui.toast('记录已更新');
    emit('close');
  } catch (e) { ui.error(e); }
}
</script>

<template>
  <Modal :title="`修改记录 · ${team.label} · ${legName(leg)}`" small @close="emit('close')">
    <div v-if="withStart" class="form-group"><label>开始时间<span class="text-gray">（默认 = 上一环节的{{ label === '完成' ? '结束' : '结束' }}时间，留空 = 未开始）</span></label><input v-model="form.arrivedAt" type="datetime-local" step="1" /></div>
    <div class="form-group"><label>{{ label }}时间<span class="text-gray">（留空 = 未{{ label }}；改动会同步为下一环节的开始时间）</span></label><input v-model="form.completedAt" type="datetime-local" step="1" /></div>
    <div v-if="leg.type === 'UT' || leg.type === 'YD'" class="form-group"><label>施加对象</label>
      <select v-model="form.targetTeamId"><option value="">未使用</option><option v-for="t in teams.filter((x) => x.id !== team.id)" :key="t.id" :value="t.id">{{ t.label }}</option></select>
    </div>
    <div v-if="leg.type === 'DT'" class="form-group"><label>绕道选择</label>
      <select v-model="form.detourChoice"><option value="">未选</option><option v-for="o in detourOptions" :key="o" :value="o">{{ o }}</option></select>
    </div>
    <div v-if="leg.type === 'RB'" class="form-group"><label>路障完成人</label><input v-model="form.roadblockBy" placeholder="姓名" /></div>
    <div v-if="leg.type === 'FF'" class="form-group"><label>快进结果</label>
      <select v-model="form.ffResult"><option value="">未尝试</option><option value="success">成功</option><option value="fail">失败</option></select>
    </div>
    <div class="form-group"><label>备注</label><textarea v-model="form.note" style="min-height: 60px" /></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" @click="emit('close')">取消</button>
      <button class="btn" @click="save">保存</button>
    </div>
  </Modal>
</template>
