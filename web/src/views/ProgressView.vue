<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtTime, toLocalInput, fromLocalInput } from '@/utils/time';
import { typeCode, type PitstopRow } from '@/types';
import EpSelector from '@/components/EpSelector.vue';
import LegTag from '@/components/LegTag.vue';
import Modal from '@/components/Modal.vue';
import PenaltyPanel from '@/components/PenaltyPanel.vue';
import TeamStatus from '@/components/TeamStatus.vue';

const auth = useAuth();
const race = useRace();
const ui = useUi();
const ep = computed(() => race.currentEpisode);
const legs = computed(() => (ep.value?.legs ?? []).filter((l) => l.record_mode !== 'none'));

// 进行中的用时按当前时间计算，每 15 秒刷新一次
const now = ref(Date.now() + auth.serverOffsetMs);
let timer: number | undefined;
onMounted(() => { timer = window.setInterval(() => { now.value = Date.now() + auth.serverOffsetMs; }, 15000); });
onUnmounted(() => clearInterval(timer));

function fmtDur(ms: number): string {
  if (ms < 0) ms = 0;
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h ? `${h}:${String(m % 60).padStart(2, '0')}` : `${m} 分`;
}
function cell(teamId: number, legId: number, single: boolean) {
  const p = race.progressOf(teamId, legId);
  if (!p || !p.arrived_at) return { start: '-', end: '-', dur: '-', cls: '' };
  if (single) return { start: fmtTime(p.completed_at), end: '-', dur: '-', cls: 'mx-done' };
  const startMs = new Date(p.arrived_at).getTime();
  if (p.completed_at) return { start: fmtTime(p.arrived_at), end: fmtTime(p.completed_at), dur: fmtDur(new Date(p.completed_at).getTime() - startMs), cls: 'mx-done' };
  return { start: fmtTime(p.arrived_at), end: '进行中', dur: fmtDur(now.value - startMs), cls: 'mx-arrived' };
}
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

// ---- 排名结算 ----
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
  if (!(await ui.confirm('自动排名', '按「签到时间 + 净罚时」对已签到队伍重新排名（会覆盖手工排名）。确定？'))) return;
  try { await api(`/episodes/${ep.value.id}/pitstop/auto`, { method: 'POST' }); await race.loadProgress(); ui.toast('已排名'); } catch (e) { ui.error(e); }
}
const sorted = computed(() => [...race.pitstop].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || (a.final_time ?? 'z').localeCompare(b.final_time ?? 'z')));
watch(() => race.currentEpisodeId, () => { editing.value = null; });
</script>

<template>
  <EpSelector />

  <!-- 进度矩阵 -->
  <div class="card">
    <div class="card-header"><span>{{ ep?.code }} 进度矩阵</span><span class="text-xs text-gray">绿 = 已完成，黄 = 进行中；进行中的用时按当前时间计算</span></div>
    <div v-if="!legs.length" class="empty-state">本赛段没有需要记录的环节</div>
    <div v-else class="matrix-scroll">
      <table class="table mx2">
        <thead>
          <tr>
            <th class="mx2-team" rowspan="2">队伍</th>
            <th v-for="l in legs" :key="l.id" :colspan="l.record_mode === 'single' ? 1 : 3" class="mx2-leg"><LegTag :type="l.type" /> {{ l.name }}</th>
          </tr>
          <tr>
            <template v-for="l in legs" :key="l.id">
              <th v-if="l.record_mode === 'single'" class="mx2-sub">{{ typeCode(l.type) === 'Starting Line' ? '出发' : l.type === 'PS' ? '签到' : '打卡' }}</th>
              <template v-else><th class="mx2-sub">开始</th><th class="mx2-sub">结束</th><th class="mx2-sub mx2-last">用时</th></template>
            </template>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in race.teams" :key="t.id" :class="{ 'mx-dead': t.status !== 'alive' }">
            <td class="mx2-team">
              <div class="flex" style="gap: 6px; flex-wrap: nowrap"><strong>{{ t.label }}</strong><TeamStatus :status="t.status" /></div>
              <div class="text-xs text-gray">{{ lastAgo(t.id) || '尚无记录' }}</div>
            </td>
            <template v-for="l in legs" :key="l.id">
              <template v-if="l.record_mode === 'single'">
                <td class="mx2-cell mx2-last" :class="cell(t.id, l.id, true).cls">{{ cell(t.id, l.id, true).start }}</td>
              </template>
              <template v-else>
                <td class="mx2-cell" :class="cell(t.id, l.id, false).cls">{{ cell(t.id, l.id, false).start }}</td>
                <td class="mx2-cell" :class="cell(t.id, l.id, false).cls">{{ cell(t.id, l.id, false).end }}</td>
                <td class="mx2-cell mx2-last" :class="cell(t.id, l.id, false).cls">{{ cell(t.id, l.id, false).dur }}</td>
              </template>
            </template>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- 罚时与补时 -->
  <PenaltyPanel />

  <!-- 排名结算 -->
  <div class="card">
    <div class="card-header">
      <span>{{ ep?.code }} 排名结算</span>
      <button v-if="auth.isHost" class="btn" @click="autoRank">按时间自动排名</button>
    </div>
    <div v-if="!hasPsLeg" class="alert alert-warning">本赛段没有中继站环节，只能手工填写签到时间。</div>
    <div class="scroll-table">
      <table class="table">
        <thead><tr><th>名次</th><th>队伍</th><th>状态</th><th>签到时间</th><th>净罚时</th><th>最终成绩</th><th>本段淘汰</th><th>备注</th><th v-if="auth.isHost"></th></tr></thead>
        <tbody>
          <tr v-for="r in sorted" :key="r.team_id">
            <td :class="r.rank ? 'rank-' + r.rank : ''">{{ r.rank ? '#' + r.rank : '-' }}</td>
            <td><strong>{{ r.team_name }}</strong></td>
            <td><TeamStatus :status="r.team_status" /></td>
            <td><span class="record-time">{{ fmtTime(r.checkin_at) }}</span> <span v-if="r.checkin_source === 'manual'" class="text-xs text-gray">手工</span></td>
            <td>{{ r.penalty_minutes > 0 ? `+${r.penalty_minutes} 分` : r.penalty_minutes < 0 ? `${r.penalty_minutes} 分（补时）` : '-' }}</td>
            <td><span class="record-time">{{ fmtTime(r.final_time) }}</span></td>
            <td>{{ r.eliminated ? '淘汰' : '' }}</td>
            <td class="wrap">{{ r.note }}</td>
            <td v-if="auth.isHost"><button class="btn btn-outline btn-sm" @click="open(r)">编辑</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <Modal v-if="editing" :title="`结算 · ${editing.team_name}`" small @close="editing = null">
    <div class="form-group"><label>签到时间（留空则采用中继站的签到时间）</label><input v-model="form.checkinAt" type="datetime-local" step="1" /></div>
    <div class="form-group"><label>名次（留空 = 未排）</label><input v-model="form.rank" type="number" inputmode="numeric" /></div>
    <div class="form-group"><label><input v-model="form.eliminated" type="checkbox" /> 本赛段淘汰（会同步修改队伍状态）</label></div>
    <div class="form-group"><label>备注</label><input v-model="form.note" /></div>
    <div class="modal-actions"><button class="btn btn-secondary" @click="editing = null">取消</button><button class="btn" @click="save">保存</button></div>
  </Modal>
</template>
