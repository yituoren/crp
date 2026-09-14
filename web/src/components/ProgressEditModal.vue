<script setup lang="ts">
import { reactive } from 'vue';
import Modal from './Modal.vue';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { toLocalInput, fromLocalInput } from '@/utils/time';
import { singleLabel, type Leg, type Progress, type Team } from '@/types';
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
const isSingle = props.leg.record_mode === 'single';
const label = singleLabel(props.leg.type);
const teams = useRaceStore().teams;

async function save() {
  try {
    await api(`/progress/${props.leg.episode_id}/${props.team.id}/${props.leg.id}`, {
      method: 'PUT',
      body: { ...form, arrivedAt: isSingle ? fromLocalInput(form.completedAt) : fromLocalInput(form.arrivedAt), completedAt: fromLocalInput(form.completedAt) },
    });
    await race.loadProgress();
    ui.toast('记录已更新');
    emit('close');
  } catch (e) { ui.error(e); }
}
</script>

<template>
  <Modal :title="`修改记录 · ${team.name} · ${leg.name}`" small @close="emit('close')">
    <template v-if="isSingle">
      <div class="form-group"><label>{{ label }}时间（留空 = 未{{ label }}）</label><input v-model="form.completedAt" type="datetime-local" step="1" /></div>
    </template>
    <template v-else>
      <div class="form-group"><label>到达时间（留空 = 未到达）</label><input v-model="form.arrivedAt" type="datetime-local" step="1" /></div>
      <div class="form-group"><label>完成时间（留空 = 未完成）</label><input v-model="form.completedAt" type="datetime-local" step="1" /></div>
    </template>
    <div v-if="leg.type === 'UT' || leg.type === 'YD'" class="form-group"><label>施加对象</label>
      <select v-model="form.targetTeamId"><option value="">未使用</option><option v-for="t in teams.filter((x) => x.id !== team.id)" :key="t.id" :value="t.id">{{ t.name }}</option></select>
    </div>
    <div v-if="leg.type === 'DT'" class="form-group"><label>绕道选择</label><input v-model="form.detourChoice" /></div>
    <div v-if="leg.type === 'RB'" class="form-group"><label>路障完成人</label><input v-model="form.roadblockBy" /></div>
    <div v-if="leg.type === 'FO'" class="form-group"><label>快进结果</label>
      <select v-model="form.ffResult"><option value="">未尝试</option><option value="success">成功</option><option value="fail">失败</option></select>
    </div>
    <div class="form-group"><label>备注</label><textarea v-model="form.note" style="min-height: 60px" /></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" @click="emit('close')">取消</button>
      <button class="btn" @click="save">保存</button>
    </div>
  </Modal>
</template>
