<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { legName, type Leg } from '@/types';
import { fmtMoney, moneyUnit, moneyLabel, moneyMode } from '@/utils/money';
import { fmtDateTime } from '@/utils/time';
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
const epForm = reactive({ name: '', budget: 0, status: 'pending', notes: '' });
function openEpEdit() {
  if (!ep.value) return;
  Object.assign(epForm, { name: ep.value.name, budget: ep.value.budget, status: ep.value.status, notes: ep.value.notes });
  epEditing.value = true;
}
async function saveEp() {
  try { await api(`/episodes/${ep.value!.id}`, { method: 'PUT', body: epForm }); await race.loadEpisodes(); epEditing.value = false; ui.toast('赛段已保存'); } catch (e) { ui.error(e); }
}
async function startEpisode() {
  if (!ep.value) return;
  const alive = race.aliveTeams.length;
  const msg = ep.value.started_at
    ? `${ep.value.code} 之前已经开始过，经费不会重复发放，只把状态改回「进行中」。确定？`
    : ep.value.budget > 0
      ? `将 ${ep.value.code} 标记为进行中，并给 ${alive} 支存活队伍各补充 ${fmtMoney(ep.value.budget)} ${moneyUnit()}（加到现有余额上，写入流水）。确定？`
      : `${ep.value.code} 未设置补充${moneyLabel()}，只把状态标记为进行中。确定？`;
  if (!(await ui.confirm('开始赛段', msg))) return;
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
// 可移动范围：Starting Line 永远第一、中继站永远最后
function canMove(i: number, dir: -1 | 1) {
  const legs = ep.value?.legs ?? [];
  const j = i + dir;
  if (j < 0 || j >= legs.length) return false;
  if (isFixed(legs[i]!) || isFixed(legs[j]!)) return false;
  return true;
}
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
async function move(leg: Leg, dir: -1 | 1) {
  const legs = [...ep.value!.legs];
  const i = legs.findIndex((l) => l.id === leg.id);
  const j = i + dir;
  if (j < 0 || j >= legs.length) return;
  [legs[i], legs[j]] = [legs[j]!, legs[i]!];
  try { await api(`/episodes/${ep.value!.id}/legs/order`, { method: 'PUT', body: { ids: legs.map((l) => l.id) } }); await race.loadEpisodes(); } catch (e) { ui.error(e); }
}
const statusLabel: Record<string, string> = { pending: '未开始', running: '进行中', finished: '已结束' };
</script>

<template>
  <EpSelector />
  <div v-if="!ep" class="empty-state">暂无赛段<button v-if="auth.isHost" class="btn" style="margin-left: 8px" @click="addEpisode">+ 新增赛段</button></div>
  <template v-else>
    <div class="card">
      <div class="card-header">
        <span>{{ ep.name }} <span class="badge" :class="ep.status === 'running' ? 'badge-station' : ep.status === 'finished' ? 'badge-crew' : 'badge-info'">{{ statusLabel[ep.status] }}</span></span>
        <div v-if="auth.isHost" class="flex">
          <button v-if="ep.status !== 'running'" class="btn btn-success btn-sm" @click="startEpisode">开始赛段</button>
          <button v-else class="btn btn-secondary btn-sm" @click="finishEpisode">结束赛段</button>
          <button class="btn btn-outline btn-sm" @click="openEpEdit">编辑赛段</button>
          <button class="btn btn-outline btn-sm" @click="addEpisode">+ 新增赛段</button>
          <button class="btn btn-danger btn-sm" @click="deleteEpisode">删除赛段</button>
        </div>
      </div>
      <div class="text-sm text-gray">
        补充{{ moneyLabel() }}：{{ ep.budget ? `${fmtMoney(ep.budget)} ${moneyUnit()}/队` : '本赛段不发' }}
        <template v-if="ep.started_at"> · 开始于 {{ fmtDateTime(ep.started_at) }}{{ ep.budget ? '（已补充到各队余额）' : '' }}</template>
        <template v-else-if="ep.budget"> · 点「开始赛段」时加到每支存活队伍的现有余额上</template>
        <template v-if="ep.finished_at"> · 结束于 {{ fmtDateTime(ep.finished_at) }}</template>
      </div>
      <div v-if="ep.notes" class="pre mt-1">{{ ep.notes }}</div>
    </div>

    <div class="flex-between mb-2">
      <div class="section-title">环节列表（{{ ep.legs.length }}）</div>
      <button v-if="auth.isHost" class="btn" @click="addLeg">+ 添加环节</button>
    </div>
    <div v-if="!ep.legs.length" class="empty-state">暂无环节，{{ auth.isHost ? '请点击右上角添加' : '请等待主办添加' }}</div>
    <div class="grid grid-3">
      <div v-for="(leg, i) in ep.legs" :key="leg.id" class="leg-item" @click="$router.push({ name: 'leg', params: { episodeId: ep.id, legId: leg.id } })">
        <div class="flex-between" style="margin-bottom: 6px">
          <LegTag :type="leg.type" :episode-id="ep.id" full />
          <span class="text-xs text-gray">#{{ i + 1 }}</span>
        </div>
        <div style="font-weight: 700; font-size: 15px">{{ legName(leg) }}</div>
        <div class="text-sm text-gray">站点：<template v-if="leg.needs_staff">{{ staffOf(leg.id).join('、') || '未分配' }}</template><span v-else>无需站点</span></div>
        <div v-if="leg.address" class="text-sm text-gray">地址：{{ leg.address }}</div>
        <div class="text-xs text-gray mt-1">
          <template v-if="leg.record_mode === 'none'">不记录时间</template>
          <template v-else-if="leg.record_mode === 'single'">{{ doneCount(leg.id) }} 已打卡</template>
          <template v-else>{{ doneCount(leg.id) }} 完成 · {{ arrivedCount(leg.id) }} 进行中</template>
          · {{ leg.attachments.length }} 附件
        </div>
        <div v-if="auth.isHost" class="flex mt-2" @click.stop>
          <template v-if="!isFixed(leg)">
            <button class="btn btn-outline btn-sm" :disabled="!canMove(i, -1)" @click="move(leg, -1)">↑</button>
            <button class="btn btn-outline btn-sm" :disabled="!canMove(i, 1)" @click="move(leg, 1)">↓</button>
            <button class="btn btn-danger btn-sm" @click="deleteLeg(leg)">删除</button>
          </template>
          <span v-else class="text-xs text-gray">固定环节</span>
        </div>
      </div>
    </div>
  </template>

  <Modal v-if="epEditing" title="编辑赛段" small @close="epEditing = false">
    <div class="form-group"><label>名称</label><input v-model="epForm.name" /></div>
    <div class="form-group"><label>本赛段补充{{ moneyLabel() }}（{{ moneyUnit() }}/队）</label><input v-model.number="epForm.budget" type="number" min="0" step="1" :inputmode="moneyMode() === 'coin' ? 'numeric' : 'decimal'" /><div class="info-text">点「开始赛段」时，在每支存活队伍现有余额上增加这笔数，不清零、不重置；上赛段剩余会累积。{{ moneyMode() === 'coin' ? '必须是整数' : '最多两位小数' }}，填 0 表示本赛段不发。</div></div>
    <div class="form-group"><label>状态（一般用「开始赛段 / 结束赛段」按钮切换，这里可手工修正）</label><select v-model="epForm.status"><option value="pending">未开始</option><option value="running">进行中</option><option value="finished">已结束</option></select></div>
    <div class="form-group"><label>赛段说明（所有幕后可见）</label><textarea v-model="epForm.notes" /></div>
    <div class="modal-actions"><button class="btn btn-secondary" @click="epEditing = false">取消</button><button class="btn" @click="saveEp">保存</button></div>
  </Modal>

</template>
