<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtTime, fmtDateTime, toLocalInput, fromLocalInput } from '@/utils/time';
import EpSelector from '@/components/EpSelector.vue';
import Modal from '@/components/Modal.vue';
import TeamStatus from '@/components/TeamStatus.vue';
import PenaltyPanel from '@/components/PenaltyPanel.vue';
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

  <PenaltyPanel />

  <Modal v-if="editing" :title="`结算 · ${editing.team_name}`" small @close="editing = null">
    <div class="form-group"><label>签到时间（留空则采用终点环节的完成时间）</label><input v-model="form.checkinAt" type="datetime-local" step="1" /></div>
    <div class="form-group"><label>名次（留空 = 未排）</label><input v-model="form.rank" type="number" inputmode="numeric" /></div>
    <div class="form-group"><label><input v-model="form.eliminated" type="checkbox" /> 本赛段淘汰（会同步修改队伍状态）</label></div>
    <div class="form-group"><label>备注</label><input v-model="form.note" /></div>
    <div class="modal-actions"><button class="btn btn-secondary" @click="editing = null">取消</button><button class="btn" @click="save">保存</button></div>
  </Modal>
</template>
