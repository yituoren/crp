<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtTime, fmtTimeSec, toLocalInput, fromLocalInput, fmtDurMs } from '@/utils/time';
import { typeCode, type PitstopRow, legName, endLabel, hasStart, type LegType } from '@/types';
import EpSelector from '@/components/EpSelector.vue';
import LegTag from '@/components/LegTag.vue';
import Modal from '@/components/Modal.vue';
import PenaltyPanel from '@/components/PenaltyPanel.vue';
import TeamStatus from '@/components/TeamStatus.vue';

const auth = useAuth();
const race = useRace();
const ui = useUi();
const ep = computed(() => race.currentEpisode);
const legs = computed(() => ep.value?.legs ?? []);

// 进行中的用时按当前时间计算，每 15 秒刷新一次
const now = ref(Date.now() + auth.serverOffsetMs);
let timer: number | undefined;
onMounted(() => { timer = window.setInterval(() => { now.value = Date.now() + auth.serverOffsetMs; }, 15000); });
onUnmounted(() => clearInterval(timer));

function cell(teamId: number, legId: number, single: boolean, isPs = false) {
  const p = race.progressOf(teamId, legId);
  if (!p || !p.arrived_at) return { start: '-', end: '-', dur: '-', cls: '' };
  if (single) return { start: (isPs ? fmtTimeSec : fmtTime)(p.completed_at), end: '-', dur: '-', cls: 'mx-done' };
  const startMs = new Date(p.arrived_at).getTime();
  if (p.completed_at) return { start: fmtTime(p.arrived_at), end: fmtTime(p.completed_at), dur: fmtDurMs(new Date(p.completed_at).getTime() - startMs), cls: 'mx-done' };
  return { start: fmtTime(p.arrived_at), end: '进行中', dur: fmtDurMs(now.value - startMs), cls: 'mx-arrived' };
}
/** 需要附加信息的环节在组末尾多几列；中继站多“罚时”“结算”两列 */
function extraCols(l: { type: string }): string[] {
  if (l.type === 'DT') return ['绕道选择'];
  if (l.type === 'RB') return ['完成人'];
  if (l.type === 'FF') return ['快进结果'];
  if (l.type === 'UT' || l.type === 'YD') return ['施加对象'];
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
  if (l.type === 'UT' || l.type === 'YD') return p.target_team_id ? race.teamById.get(p.target_team_id)?.label ?? '-' : '-';
  return '-';
}
/** 起跑线只有“出发”一列；其余环节：开始 / 结束 / 用时 */
const isSingleCol = (l: { type: string }) => !hasStart(l.type as LegType);
const colspanOf = (l: { type: string }) => (isSingleCol(l) ? 1 : 3) + extraCols(l).length;
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
const form = reactive({ checkinAt: '', eliminated: false, note: '' });
function open(r: PitstopRow) {
  editing.value = r;
  Object.assign(form, { checkinAt: toLocalInput(r.checkin_at), eliminated: r.eliminated, note: r.note });
}
async function save() {
  if (!editing.value || !ep.value) return;
  try {
    await api(`/episodes/${ep.value.id}/pitstop/${editing.value.team_id}`, {
      method: 'PUT',
      body: { checkinAt: fromLocalInput(form.checkinAt), eliminated: form.eliminated, note: form.note },
    });
    await Promise.all([race.loadProgress(), race.loadTeams()]);
    editing.value = null;
    ui.toast('已保存');
  } catch (e) { ui.error(e); }
}
async function toggleEliminate(r: PitstopRow) {
  if (!ep.value) return;
  const next = !r.eliminated;
  if (!(await ui.confirm(next ? '标记淘汰' : '取消淘汰', next ? `将「${r.team_name}」标记为本赛段淘汰？队伍状态会同步改为已淘汰。` : `取消「${r.team_name}」的淘汰标记，恢复为存活？`, { danger: next }))) return;
  try {
    await api(`/episodes/${ep.value.id}/pitstop/${r.team_id}`, { method: 'PUT', body: { eliminated: next } });
    await Promise.all([race.loadProgress(), race.loadTeams()]);
    ui.toast(next ? '已标记淘汰' : '已恢复');
  } catch (e) { ui.error(e); }
}
const sorted = computed(() => [...race.pitstop].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || (a.final_time ?? 'z').localeCompare(b.final_time ?? 'z')));
watch(() => race.currentEpisodeId, () => { editing.value = null; });
</script>

<template>
  <EpSelector />

  <!-- 进度矩阵 -->
  <div class="card">
    <div class="card-header"><span>进度矩阵</span><span class="text-xs text-gray">绿 = 已完成，黄 = 进行中；进行中的用时按当前时间计算</span></div>
    <div v-if="!legs.length" class="empty-state">本赛段没有需要记录的环节</div>
    <div v-else class="matrix-scroll">
      <table class="table mx2">
        <thead>
          <tr>
            <th class="mx2-team" rowspan="2">队伍</th>
            <th v-for="l in legs" :key="l.id" :colspan="colspanOf(l)" class="mx2-leg mx2-first mx2-last"><LegTag :type="l.type" /> {{ legName(l) }}</th>
          </tr>
          <tr>
            <template v-for="l in legs" :key="l.id">
              <th v-if="isSingleCol(l)" class="mx2-sub mx2-first" :class="{ 'mx2-last': !extraCol(l) }">{{ endLabel(l.type) }}</th>
              <template v-else><th class="mx2-sub mx2-first">开始</th><th class="mx2-sub">{{ endLabel(l.type) }}</th><th class="mx2-sub" :class="{ 'mx2-last': !extraCol(l) }">用时</th></template>
              <th v-for="(c, i) in extraCols(l)" :key="c" class="mx2-sub" :class="{ 'mx2-last': i === extraCols(l).length - 1 }">{{ c }}</th>
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
              <template v-if="isSingleCol(l)">
                <td class="mx2-cell mx2-first" :class="[cell(t.id, l.id, true, l.type === 'PS').cls, { 'mx2-last': !extraCol(l) }]">{{ cell(t.id, l.id, true, l.type === 'PS').start }}</td>
              </template>
              <template v-else>
                <td class="mx2-cell mx2-first" :class="cell(t.id, l.id, false).cls">{{ cell(t.id, l.id, false).start }}</td>
                <td class="mx2-cell" :class="cell(t.id, l.id, false).cls">{{ cell(t.id, l.id, false).end }}</td>
                <td class="mx2-cell" :class="[cell(t.id, l.id, false).cls, { 'mx2-last': !extraCol(l) }]">{{ cell(t.id, l.id, false).dur }}</td>
              </template>
              <td v-for="(c, i) in extraCols(l)" :key="c" class="mx2-cell mx2-extra" :class="{ 'mx2-last': i === extraCols(l).length - 1 }">{{ extraVal(t.id, l, i) }}</td>
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
      <span>排名结算</span>
      <span class="text-xs text-gray">名次 = 签到时间 + 净罚时，签到或罚时一变即自动更新</span>
    </div>
    <div v-if="!hasPsLeg" class="alert alert-warning">本赛段没有中继站环节，只能手工填写签到时间。</div>
    <div class="scroll-table">
      <table class="table">
        <thead><tr><th>名次</th><th>队伍</th><th>状态</th><th>签到时间</th><th>净罚时</th><th>最终成绩</th><th>本段淘汰</th><th>备注</th><th v-if="race.canEliminate"></th></tr></thead>
        <tbody>
          <tr v-for="r in sorted" :key="r.team_id">
            <td :class="r.rank ? 'rank-' + r.rank : ''">{{ r.rank ? '#' + r.rank : '-' }}</td>
            <td><strong>{{ r.team_name }}</strong></td>
            <td><TeamStatus :status="r.team_status" /></td>
            <td><span class="record-time">{{ fmtTimeSec(r.checkin_at) }}</span></td>
            <td>{{ r.penalty_minutes > 0 ? `+${r.penalty_minutes} 分` : r.penalty_minutes < 0 ? `${r.penalty_minutes} 分（补时）` : '-' }}</td>
            <td><span class="record-time">{{ fmtTimeSec(r.final_time) }}</span></td>
            <td>{{ r.eliminated ? '淘汰' : '' }}</td>
            <td class="wrap">{{ r.note }}</td>
            <td v-if="race.canEliminate">
              <div class="flex" style="gap: 6px; flex-wrap: nowrap">
                <button class="btn btn-sm btn-slot" :class="r.eliminated ? 'btn-success' : 'btn-danger'" @click="toggleEliminate(r)">{{ r.eliminated ? '取消淘汰' : '淘汰' }}</button>
                <button v-if="auth.isHost" class="btn btn-outline btn-sm" @click="open(r)">编辑</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <Modal v-if="editing" :title="`结算 · ${editing.team_name}`" small @close="editing = null">
    <div class="form-group"><label>签到时间（留空则采用中继站的签到时间）</label><input v-model="form.checkinAt" type="datetime-local" step="1" /></div>
    <div class="form-group"><label><input v-model="form.eliminated" type="checkbox" /> 本赛段淘汰（会同步修改队伍状态）</label></div>
    <div class="form-group"><label>备注</label><input v-model="form.note" /></div>
    <div class="modal-actions"><button class="btn btn-secondary" @click="editing = null">取消</button><button class="btn" @click="save">保存</button></div>
  </Modal>
</template>
