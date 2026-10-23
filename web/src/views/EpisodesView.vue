<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { legName, endLabel, type Leg } from '@/types';
import { useDragSort } from '@/composables/dragSort';
import { fmtMoney, moneyUnit, moneyLabel, moneyMode } from '@/utils/money';
import { fmtDateTime, toLocalInput, fromLocalInput } from '@/utils/time';
import EpSelector from '@/components/EpSelector.vue';
import LegTag from '@/components/LegTag.vue';
import Modal from '@/components/Modal.vue';

const auth = useAuth();
const race = useRace();
const ui = useUi();
const ep = computed(() => race.currentEpisode);

const staffOf = (legId: number) => race.assignments.filter((a) => a.role === 'station' && (a.leg_ids ?? []).includes(legId)).map((a) => a.display_name);
const doneCount = (legId: number) => race.aliveTeams.filter((t) => race.progressOf(t.id, legId)?.completed_at).length;
const arrivedCount = (legId: number) => race.aliveTeams.filter((t) => { const p = race.progressOf(t.id, legId); return p?.arrived_at && !p.completed_at; }).length;

// ---- 赛段编辑 ----
const epEditing = ref(false);
const epForm = reactive({ name: '', budget: 0, status: 'pending', notes: '', startAt: '', inheritRank: false, startGapMin: 0 });
/** 是否第一个赛段（没有上一赛段可以继承名次） */
const isFirstEp = computed(() => !!ep.value && race.episodes[0]?.id === ep.value.id);
function openEpEdit() {
  if (!ep.value) return;
  Object.assign(epForm, { name: ep.value.name, budget: ep.value.budget, status: ep.value.status, notes: ep.value.notes, startAt: toLocalInput(ep.value.start_at).slice(0, 16), inheritRank: !!ep.value.inherit_rank, startGapMin: ep.value.start_gap_min || 0 });
  epEditing.value = true;
}
async function saveEp() {
  const body = { ...epForm, startAt: epForm.startAt ? fromLocalInput(epForm.startAt) : null, inheritRank: !isFirstEp.value && epForm.inheritRank };
  if (epForm.startAt && !body.startAt) { ui.toast('自动开始时间格式不正确', 'error'); return; }
  try { await api(`/episodes/${ep.value!.id}`, { method: 'PUT', body }); await race.loadEpisodes(); epEditing.value = false; ui.toast('赛段已保存'); } catch (e) { ui.error(e); }
}
/** 自动开始的说明文字 */
const autoStartText = computed(() => {
  const e = ep.value; if (!e?.start_at) return '';
  const stagger = e.inherit_rank && !isFirstEp.value && e.start_gap_min > 0;
  return `${fmtDateTime(e.start_at)} 自动开始${stagger ? `，按上一赛段名次每隔 ${e.start_gap_min} m 发车` : '，各队同时出发'}`;
});
async function startEpisode() {
  if (!ep.value) return;
  const alive = race.aliveTeams.length;
  const msg = ep.value.started_at
    ? `${ep.value.code} 之前已经开始过，经费不会重复发放，只把状态改回「进行中」。确定？`
    : ep.value.budget > 0
      ? `将 ${ep.value.code} 标记为进行中，并给 ${alive} 支存活队伍各补充 ${fmtMoney(ep.value.budget)} ${moneyUnit()}（加到现有余额上，写入流水）。确定？`
      : `${ep.value.code} 未设置补充${moneyLabel()}，只把状态标记为进行中。确定？`;
  if (!(await ui.confirm('开始赛段（仅供测试）', `手动开始只供测试使用，正式比赛请在「编辑赛段」里设置自动开始时间。手动开始后同样按发车规则自动记录各队出发（以点击时刻为基准）。\n\n${msg}`))) return;
  try {
    const d = await api(`/episodes/${ep.value.id}/start`, { method: 'POST' });
    await Promise.all([race.loadEpisodes(), race.loadTeams(), race.loadLedger()]);
    ui.toast(d.issuedBudgetTo.length ? `赛段已开始，已给 ${d.issuedBudgetTo.length} 支队伍补充经费` : '赛段已开始');
  } catch (e) { ui.error(e); }
}
async function finishEpisode() {
  if (!ep.value) return;
  if (!(await ui.confirm('结束赛段', `将 ${ep.value.code} 标记为已结束？不影响任何记录，之后仍可修改。`))) return;
  try { await api(`/episodes/${ep.value.id}/finish`, { method: 'POST' }); await race.loadEpisodes(); ui.toast('赛段已结束'); } catch (e) { ui.error(e); }
}
async function resetEpisode() {
  if (!ep.value) return;
  const later = race.episodes.filter((e) => race.episodes.indexOf(e) >= race.episodes.indexOf(ep.value!)).map((e) => e.code).join('、');
  if (!(await ui.confirm('重置赛段（仅供测试）', `只供测试使用。将清空 ${later} 的全部记录数据（时间记录、罚时补时、签到、熔断使用、经费流水），这些赛段回到未开始；环节设置、排班、附件保持不变。确定？`, { danger: true, okText: '重置' }))) return;
  try {
    const d = await api(`/episodes/${ep.value.id}/reset`, { method: 'POST' });
    await Promise.all([race.loadEpisodes(), race.loadTeams(), race.loadLedger(), race.loadProgress()]);
    ui.toast(`已重置 ${d.episodes.join('、')}`);
  } catch (e) { ui.error(e); }
}
async function addEpisode() {
  try { await api('/episodes', { method: 'POST', body: {} }); await race.loadEpisodes(); ui.toast('已新增赛段'); } catch (e) { ui.error(e); }
}
async function deleteEpisode() {
  if (!ep.value) return;
  if (!(await ui.confirm('删除赛段', `删除 ${ep.value.code}？该赛段的环节、记录、排班、货币日志都会被删除。`, { danger: true, okText: '删除' }))) return;
  try { await api(`/episodes/${ep.value.id}`, { method: 'DELETE' }); await race.loadEpisodes(); ui.toast('已删除'); } catch (e) { ui.error(e); }
}

// ---- 环节编辑 ----
const isFixed = (l: Leg) => l.type === 'SL' || l.type === 'PS';
async function addLeg() {
  try {
    const n = (ep.value?.legs.length ?? 0) + 1;
    await api(`/episodes/${ep.value!.id}/legs`, { method: 'POST', body: { type: 'TI', name: `新环节 ${n}` } });
    await race.loadEpisodes();
    ui.toast('已在中继站前添加环节，点进卡片完善信息');
  } catch (e) { ui.error(e); }
}
async function deleteLeg(leg: Leg) {
  if (!(await ui.confirm('删除环节', `删除「${legName(leg)}」？相关记录和附件也将丢失。`, { danger: true, okText: '删除' }))) return;
  try { await api(`/legs/${leg.id}`, { method: 'DELETE' }); await race.loadEpisodes(); ui.toast('已删除'); } catch (e) { ui.error(e); }
}
// 拖动换序：起跑线和中继站固定，不参与
const drag = useDragSort({
  count: () => ep.value?.legs.length ?? 0,
  canDrag: (i) => !!ep.value && !isFixed(ep.value.legs[i]!),
  onReorder: async (order) => {
    if (!ep.value) return;
    const ids = order.map((i) => ep.value!.legs[i]!.id);
    try { await api(`/episodes/${ep.value.id}/legs/order`, { method: 'PUT', body: { ids } }); await race.loadEpisodes(); } catch (e) { ui.error(e); }
  },
});
const statusLabel: Record<string, string> = { pending: '未开始', running: '进行中', finished: '已结束' };
</script>

<template>
  <EpSelector>
    <template v-if="auth.isHost" #right><button class="btn btn-text btn-sm" @click="addEpisode"><Icon name="add" size="16" />新增赛段</button></template>
  </EpSelector>
  <div v-if="!ep" class="empty-state">暂无赛段<button v-if="auth.isHost" class="btn" style="margin-left: 8px" @click="addEpisode"><Icon name="add" size="18" />新增赛段</button></div>
  <template v-else>
    <div class="card">
      <div class="card-header">
        <span>{{ ep.name }} <span class="badge" :class="ep.status === 'running' ? 'badge-station' : ep.status === 'finished' ? 'badge-crew' : 'badge-info'">{{ statusLabel[ep.status] }}</span></span>
        <div v-if="auth.isHost" class="flex">
          <button v-if="ep.status !== 'running'" class="btn btn-sm" @click="startEpisode"><Icon name="play_arrow" size="18" />开始赛段</button>
          <button v-else class="btn btn-tonal btn-sm" @click="finishEpisode"><Icon name="flag" size="16" />结束赛段</button>
          <button class="btn btn-text btn-sm" @click="openEpEdit"><Icon name="edit" size="16" />编辑赛段</button>
          <button class="btn btn-text btn-text-danger btn-sm" @click="resetEpisode"><Icon name="restart_alt" size="16" />重置赛段</button>
          <button class="btn btn-text btn-text-danger btn-sm" @click="deleteEpisode"><Icon name="delete" size="16" />删除赛段</button>
        </div>
      </div>
      <div class="text-sm text-gray">
        补充{{ moneyLabel() }}：{{ ep.budget ? `${fmtMoney(ep.budget)} ${moneyUnit()}/队` : '本赛段不发' }}
        <template v-if="ep.started_at"> · 开始于 {{ fmtDateTime(ep.started_at) }}{{ ep.budget ? '（已补充到各队余额）' : '' }}</template>
        <template v-else-if="autoStartText"> · {{ autoStartText }}</template>
        <template v-if="ep.finished_at"> · 结束于 {{ fmtDateTime(ep.finished_at) }}</template>
      </div>
      <div v-if="ep.notes" class="pre mt-1">{{ ep.notes }}</div>
    </div>

    <div class="flex-between mb-2 leg-list-head">
      <div class="section-title">环节列表（{{ ep.legs.length }}）</div>
      <button v-if="auth.isHost && race.structureEditable" class="btn btn-sm" @click="addLeg"><Icon name="add" size="16" />添加环节</button>
    </div>
    <div v-if="!ep.legs.length" class="empty-state">暂无环节，{{ auth.isHost ? '请点击右上角添加' : '请等待主办添加' }}</div>
    <div class="grid grid-3">
      <div v-for="(leg, i) in ep.legs" :key="leg.id" class="leg-item" v-bind="auth.isHost && race.structureEditable ? drag.bind(i) : {}" @click="$router.push({ name: 'leg', params: { episodeId: ep.id, legId: leg.id } })">
        <div class="leg-item-body">
        <div class="flex-between leg-item-head">
          <LegTag :type="leg.type" :episode-id="ep.id" full />
          <button v-if="auth.isHost && race.structureEditable && !isFixed(leg)" class="icon-btn icon-btn-sm icon-btn-danger" title="删除环节" @click.stop="deleteLeg(leg)"><Icon name="delete" size="18" /></button>
        </div>
        <div style="font-weight: 500; font-size: 15px">{{ legName(leg) }}</div>
        <div class="text-sm text-gray">站点：<template v-if="leg.needs_staff">{{ staffOf(leg.id).join('、') || '未分配' }}</template><span v-else>无需站点</span></div>
        <div v-if="leg.address" class="text-sm text-gray">地址：{{ leg.address }}</div>
        <div class="text-xs text-gray mt-1">
          {{ doneCount(leg.id) }} 已{{ endLabel(leg.type) }} · {{ arrivedCount(leg.id) }} 进行中
          · {{ leg.attachments.length }} 附件
          <template v-if="leg.shop_open"> · 开放商店</template>
          <template v-if="leg.can_eliminate"> · 淘汰 {{ leg.eliminate_count }} 队</template>
          <template v-if="leg.cutoffs.length"> · 熔断 {{ leg.cutoffs.length }} 种</template>
        </div>
        </div>
      </div>
    </div>
  </template>

  <Modal v-if="epEditing" title="编辑赛段" small @close="epEditing = false">
    <div class="form-group"><label>名称</label><input v-model="epForm.name" /></div>
    <div class="form-group"><label>本赛段补充{{ moneyLabel() }}（{{ moneyUnit() }}/队）</label><input v-model.number="epForm.budget" type="number" min="0" step="1" :inputmode="moneyMode() === 'coin' ? 'numeric' : 'decimal'" /></div>
    <div class="form-group"><label>自动开始时间<span class="text-gray text-sm">（留空则不自动开始）</span></label><input v-model="epForm.startAt" type="datetime-local" /></div>
    <template v-if="!isFirstEp">
      <label class="check-row"><input v-model="epForm.inheritRank" type="checkbox" /> 按上一赛段名次先后发车</label>
      <div v-if="epForm.inheritRank" class="form-group" style="max-width: 200px"><label>发车间隔（m）</label><input v-model.number="epForm.startGapMin" type="number" min="0" step="1" inputmode="numeric" /></div>
    </template>
    <div class="form-group"><label>状态（一般用「开始赛段 / 结束赛段」按钮切换，这里可手工修正）</label><MSelect v-model="epForm.status" outlined :options="[{ value: 'pending', label: '未开始' }, { value: 'running', label: '进行中' }, { value: 'finished', label: '已结束' }]" /></div>
    <div class="form-group"><label>赛段说明（所有幕后可见）</label><textarea v-model="epForm.notes" /></div>
    <div class="modal-actions"><button class="btn btn-text" @click="epEditing = false">取消</button><button class="btn" @click="saveEp">保存</button></div>
  </Modal>

</template>
