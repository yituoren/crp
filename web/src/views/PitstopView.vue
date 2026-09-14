<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtTime, fmtDateTime, toLocalInput, fromLocalInput } from '@/utils/time';
import EpSelector from '@/components/EpSelector.vue';
import Modal from '@/components/Modal.vue';
import TeamStatus from '@/components/TeamStatus.vue';
import type { PitstopRow } from '@/types';

const race = useRace();
const ui = useUi();
const ep = computed(() => race.currentEpisode);
const hasPsLeg = computed(() => ep.value?.legs.some((l) => l.type === 'PS'));

const editing = ref<PitstopRow | null>(null);
const form = reactive({ checkinAt: '', rank: '' as string | number, eliminated: false, note: '' });
function open(r: PitstopRow) {
  editing.value = r;
  Object.assign(form, { checkinAt: toLocalInput(r.checkin_at), rank: r.rank ?? '', eliminated: r.eliminated, note: r.note });
}
async function save() {
  if (!editing.value || !ep.value) return;
  try {
    await api(`/episodes/${ep.value.id}/pitstop/${editing.value.team_id}`, {
      method: 'PUT',
      body: { checkinAt: fromLocalInput(form.checkinAt), rank: form.rank === '' ? null : Number(form.rank), eliminated: form.eliminated, note: form.note },
    });
    await Promise.all([race.loadProgress(), race.loadTeams()]);
    editing.value = null;
    ui.toast('已保存');
  } catch (e) { ui.error(e); }
}
async function autoRank() {
  if (!ep.value) return;
  if (!(await ui.confirm('自动排名', '按「签到时间 + 罚时」对已签到队伍重新排名（会覆盖手工排名）。确定？'))) return;
  try { await api(`/episodes/${ep.value.id}/pitstop/auto`, { method: 'POST' }); await race.loadProgress(); ui.toast('已排名'); } catch (e) { ui.error(e); }
}

const penForm = reactive({ teamId: '' as number | '', minutes: '', reason: '' });
async function addPenalty() {
  if (!ep.value || !penForm.teamId || !Number(penForm.minutes)) { ui.toast('请选择队伍并填写分钟数', 'error'); return; }
  try {
    await api(`/episodes/${ep.value.id}/penalties`, { method: 'POST', body: { teamId: penForm.teamId, minutes: Number(penForm.minutes), reason: penForm.reason } });
    penForm.minutes = ''; penForm.reason = '';
    await race.loadProgress();
    ui.toast('罚时已添加');
  } catch (e) { ui.error(e); }
}
async function removePenalty(id: number) {
  if (!(await ui.confirm('删除罚时', '确定删除这条罚时？', { danger: true }))) return;
  try { await api(`/penalties/${id}`, { method: 'DELETE' }); await race.loadProgress(); } catch (e) { ui.error(e); }
}
const sorted = computed(() => [...race.pitstop].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || (a.final_time ?? 'z').localeCompare(b.final_time ?? 'z')));
watch(() => race.currentEpisodeId, () => { editing.value = null; });
</script>

<template>
  <EpSelector />
  <div v-if="!hasPsLeg" class="alert alert-warning">本赛段没有「PS 终点」类型的环节。请在赛段信息里添加一个终点环节，跟队记录完成后这里会自动带出签到时间；也可以直接在下方手工填写签到时间。</div>
  <div class="card">
    <div class="card-header">
      <span>{{ ep?.code }} 终点结算</span>
      <button class="btn" @click="autoRank">按时间自动排名</button>
    </div>
    <div class="scroll-table">
      <table class="table">
        <thead><tr><th>名次</th><th>队伍</th><th>状态</th><th>签到时间</th><th>罚时</th><th>最终成绩</th><th>本段淘汰</th><th>备注</th><th></th></tr></thead>
        <tbody>
          <tr v-for="r in sorted" :key="r.team_id">
            <td :class="r.rank ? 'rank-' + r.rank : ''">{{ r.rank ? '#' + r.rank : '-' }}</td>
            <td><strong>{{ r.team_name }}</strong></td>
            <td><TeamStatus :status="r.team_status" /></td>
            <td><span class="record-time">{{ fmtTime(r.checkin_at) }}</span> <span v-if="r.checkin_source === 'manual'" class="text-xs text-gray">手工</span></td>
            <td>{{ r.penalty_minutes ? `+${r.penalty_minutes} 分` : '-' }}</td>
            <td><span class="record-time">{{ fmtTime(r.final_time) }}</span></td>
            <td>{{ r.eliminated ? '淘汰' : '' }}</td>
            <td class="wrap">{{ r.note }}</td>
            <td><button class="btn btn-outline btn-sm" @click="open(r)">编辑</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="card">
    <div class="card-header">罚时记录</div>
    <div class="flex mb-2">
      <select v-model="penForm.teamId" class="input-inline" style="width: 140px"><option value="">选择队伍</option><option v-for="t in race.teams" :key="t.id" :value="t.id">{{ t.name }}</option></select>
      <input v-model="penForm.minutes" type="number" inputmode="numeric" class="input-inline" placeholder="分钟" style="width: 90px" />
      <input v-model="penForm.reason" class="input-inline" placeholder="原因（如：打车超预算）" style="flex: 1; min-width: 160px" />
      <button class="btn" @click="addPenalty">添加罚时</button>
    </div>
    <div v-if="!race.penalties.length" class="text-gray text-sm">本赛段暂无罚时</div>
    <table v-else class="table">
      <thead><tr><th>队伍</th><th>分钟</th><th>原因</th><th>时间</th><th></th></tr></thead>
      <tbody>
        <tr v-for="p in race.penalties" :key="p.id">
          <td>{{ p.team_name }}</td><td>+{{ p.minutes }}</td><td class="wrap">{{ p.reason || '-' }}</td><td>{{ fmtDateTime(p.applied_at) }}</td>
          <td><button class="btn btn-outline btn-sm" @click="removePenalty(p.id)">删</button></td>
        </tr>
      </tbody>
    </table>
  </div>

  <Modal v-if="editing" :title="`结算 · ${editing.team_name}`" small @close="editing = null">
    <div class="form-group"><label>签到时间（留空则采用终点环节的完成时间）</label><input v-model="form.checkinAt" type="datetime-local" step="1" /></div>
    <div class="form-group"><label>名次（留空 = 未排）</label><input v-model="form.rank" type="number" inputmode="numeric" /></div>
    <div class="form-group"><label><input v-model="form.eliminated" type="checkbox" /> 本赛段淘汰（会同步修改队伍状态）</label></div>
    <div class="form-group"><label>备注</label><input v-model="form.note" /></div>
    <div class="modal-actions"><button class="btn btn-secondary" @click="editing = null">取消</button><button class="btn" @click="save">保存</button></div>
  </Modal>
</template>
