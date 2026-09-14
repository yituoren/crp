<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { LEG_TYPES, LEG_TYPE_LABEL, LEG_TYPE_HINT, TYPE_DEFAULTS, RECORD_MODE_LABEL, type Leg, type LegType, type RecordMode } from '@/types';
import { watch } from 'vue';
import { fmtMoney } from '@/utils/money';
import EpSelector from '@/components/EpSelector.vue';
import LegTag from '@/components/LegTag.vue';
import Modal from '@/components/Modal.vue';

const auth = useAuth();
const race = useRace();
const ui = useUi();
const ep = computed(() => race.currentEpisode);

const staffOf = (legId: number) => race.assignments.filter((a) => a.role === 'station' && a.leg_id === legId).map((a) => a.display_name);
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
async function addEpisode() {
  try { await api('/episodes', { method: 'POST', body: {} }); await race.loadEpisodes(); ui.toast('已新增赛段'); } catch (e) { ui.error(e); }
}
async function deleteEpisode() {
  if (!ep.value) return;
  if (!(await ui.confirm('删除赛段', `删除 ${ep.value.code}？该赛段的环节、记录、排班、货币日志都会被删除。`, { danger: true, okText: '删除' }))) return;
  try { await api(`/episodes/${ep.value.id}`, { method: 'DELETE' }); await race.loadEpisodes(); ui.toast('已删除'); } catch (e) { ui.error(e); }
}

// ---- 环节编辑 ----
const legEditing = ref<Leg | null>(null);
const legForm = reactive({ type: 'TI' as LegType, name: '', description: '', address: '', map_url: '', clue_text: '', judge_criteria: '', open_time: '', close_time: '', detour_a: '', detour_b: '', needs_staff: true, record_mode: 'full' as RecordMode });
// 切换类型时套用该类型的默认行为（主办仍可手动改）
watch(() => legForm.type, (t, prev) => { if (prev !== undefined && t !== prev) { legForm.needs_staff = TYPE_DEFAULTS[t].staff; legForm.record_mode = TYPE_DEFAULTS[t].mode; } });
function openLegEdit(leg: Leg) {
  legEditing.value = leg;
  Object.assign(legForm, { type: leg.type, name: leg.name, description: leg.description, address: leg.address, map_url: leg.map_url, clue_text: leg.clue_text, judge_criteria: leg.judge_criteria, open_time: leg.open_time, close_time: leg.close_time, detour_a: leg.detour_a, detour_b: leg.detour_b, needs_staff: !!leg.needs_staff, record_mode: leg.record_mode });
}
async function saveLeg() {
  try { await api(`/legs/${legEditing.value!.id}`, { method: 'PUT', body: legForm }); await race.loadEpisodes(); legEditing.value = null; ui.toast('环节已保存'); } catch (e) { ui.error(e); }
}
async function addLeg() {
  try {
    const n = (ep.value?.legs.length ?? 0) + 1;
    await api(`/episodes/${ep.value!.id}/legs`, { method: 'POST', body: { type: 'TI', name: `新环节 ${n}` } });
    await race.loadEpisodes();
    ui.toast('已添加环节，点击卡片上的「编辑」完善信息');
  } catch (e) { ui.error(e); }
}
async function deleteLeg(leg: Leg) {
  if (!(await ui.confirm('删除环节', `删除「${leg.name}」？相关记录和附件也将丢失。`, { danger: true, okText: '删除' }))) return;
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
/** 软性检查：不阻止保存，只提醒主办 */
const checks = computed(() => {
  const legs = ep.value?.legs ?? [];
  const out: string[] = [];
  if (!legs.length) return out;
  const psIdx = legs.map((l, i) => (l.type === 'PS' ? i : -1)).filter((i) => i >= 0);
  if (!psIdx.length) out.push('没有「PS 中继站/终点」环节：终点结算无法自动取签到时间，只能手工填写。');
  else if (psIdx[psIdx.length - 1] !== legs.length - 1) out.push('中继站/终点不是最后一个环节：签到后还有环节，结算会以中继站的签到时间为准，请确认这是有意安排。');
  if (psIdx.length > 1) out.push('有多个中继站/终点环节：结算只取排序最靠后的那个。');
  if (legs[0]!.type !== 'SL' && legs[0]!.type !== 'RI') out.push('第一个环节不是起跑线或路线信息：如果本赛段从上一段中继站直接出发，可以忽略。');
  const staffed = new Set(race.assignments.filter((a) => a.role === 'station').map((a) => a.leg_id));
  const unstaffed = legs.filter((l) => l.needs_staff && !staffed.has(l.id)).map((l) => l.name);
  if (unstaffed.length) out.push(`需要站点人员但尚未排班：${unstaffed.join('、')}。`);
  return out;
});
</script>

<template>
  <EpSelector />
  <div v-if="!ep" class="empty-state">暂无赛段<button v-if="auth.isHost" class="btn" style="margin-left: 8px" @click="addEpisode">+ 新增赛段</button></div>
  <template v-else>
    <div class="card">
      <div class="card-header">
        <span>{{ ep.code }} · {{ ep.name }} <span class="badge" :class="ep.status === 'running' ? 'badge-station' : ep.status === 'finished' ? 'badge-crew' : 'badge-info'">{{ statusLabel[ep.status] }}</span></span>
        <div v-if="auth.isHost" class="flex">
          <button class="btn btn-outline btn-sm" @click="openEpEdit">编辑赛段</button>
          <button class="btn btn-outline btn-sm" @click="addEpisode">+ 新增赛段</button>
          <button class="btn btn-danger btn-sm" @click="deleteEpisode">删除赛段</button>
        </div>
      </div>
      <div class="text-sm text-gray">经费：{{ ep.budget ? `${fmtMoney(ep.budget)} 元/队` : '未设置' }}</div>
      <div v-if="ep.notes" class="pre mt-1">{{ ep.notes }}</div>
    </div>

    <div v-if="auth.isHost && checks.length" class="alert alert-warning">
      <div v-for="(c, i) in checks" :key="i">· {{ c }}</div>
    </div>
    <div class="flex-between mb-2">
      <div class="section-title">环节列表（{{ ep.legs.length }}）</div>
      <button v-if="auth.isHost" class="btn" @click="addLeg">+ 添加环节</button>
    </div>
    <div v-if="!ep.legs.length" class="empty-state">暂无环节，{{ auth.isHost ? '请点击右上角添加' : '请等待主办添加' }}</div>
    <div class="grid grid-3">
      <div v-for="(leg, i) in ep.legs" :key="leg.id" class="leg-item" @click="$router.push({ name: 'leg', params: { episodeId: ep.id, legId: leg.id } })">
        <div class="flex-between" style="margin-bottom: 6px">
          <LegTag :type="leg.type" full />
          <span class="text-xs text-gray">#{{ i + 1 }}</span>
        </div>
        <div style="font-weight: 700; font-size: 15px">{{ leg.name }}</div>
        <div class="text-sm text-gray">站点：<template v-if="leg.needs_staff">{{ staffOf(leg.id).join('、') || '未分配' }}</template><span v-else>无需站点</span></div>
        <div v-if="leg.address" class="text-sm text-gray">地址：{{ leg.address }}</div>
        <div class="text-xs text-gray mt-1">
          <template v-if="leg.record_mode === 'none'">不记录时间</template>
          <template v-else-if="leg.record_mode === 'single'">{{ doneCount(leg.id) }} 已打卡</template>
          <template v-else>{{ doneCount(leg.id) }} 完成 · {{ arrivedCount(leg.id) }} 进行中</template>
          · {{ leg.attachments.length }} 附件
        </div>
        <div v-if="auth.isHost" class="flex mt-2" @click.stop>
          <button class="btn btn-outline btn-sm" @click="openLegEdit(leg)">编辑</button>
          <button class="btn btn-outline btn-sm" :disabled="i === 0" @click="move(leg, -1)">↑</button>
          <button class="btn btn-outline btn-sm" :disabled="i === ep.legs.length - 1" @click="move(leg, 1)">↓</button>
          <button class="btn btn-danger btn-sm" @click="deleteLeg(leg)">删除</button>
        </div>
      </div>
    </div>
  </template>

  <Modal v-if="epEditing" title="编辑赛段" small @close="epEditing = false">
    <div class="form-group"><label>名称</label><input v-model="epForm.name" /></div>
    <div class="form-group"><label>每队经费（元，最多两位小数）</label><input v-model.number="epForm.budget" type="number" min="0" step="0.01" inputmode="decimal" /></div>
    <div class="form-group"><label>状态</label><select v-model="epForm.status"><option value="pending">未开始</option><option value="running">进行中</option><option value="finished">已结束</option></select></div>
    <div class="form-group"><label>赛段说明（所有幕后可见）</label><textarea v-model="epForm.notes" /></div>
    <div class="modal-actions"><button class="btn btn-secondary" @click="epEditing = false">取消</button><button class="btn" @click="saveEp">保存</button></div>
  </Modal>

  <Modal v-if="legEditing" :title="`编辑环节 · ${legEditing.name}`" @close="legEditing = null">
    <div class="grid grid-2">
      <div class="form-group"><label>类型</label>
        <select v-model="legForm.type"><option v-for="t in LEG_TYPES" :key="t" :value="t">{{ t }} · {{ LEG_TYPE_LABEL[t] }}</option></select>
      </div>
      <div class="form-group"><label>名称</label><input v-model="legForm.name" /></div>
    </div>
    <div class="info-text" style="margin: -6px 0 10px">{{ LEG_TYPE_HINT[legForm.type] }}</div>
    <div class="grid grid-2">
      <div class="form-group"><label>记录方式</label>
        <select v-model="legForm.record_mode"><option v-for="(l, m) in RECORD_MODE_LABEL" :key="m" :value="m">{{ l }}</option></select>
      </div>
      <div class="form-group"><label>站点人员</label>
        <select v-model="legForm.needs_staff"><option :value="true">需要安排站点人员</option><option :value="false">无需站点（无人值守）</option></select>
      </div>
    </div>
    <div class="form-group"><label>环节说明（任务内容、流程）</label><textarea v-model="legForm.description" /></div>
    <div class="grid grid-2">
      <div class="form-group"><label>地址</label><input v-model="legForm.address" /></div>
      <div class="form-group"><label>地图链接</label><input v-model="legForm.map_url" placeholder="高德/百度地图分享链接" /></div>
      <div class="form-group"><label>开放时间</label><input v-model="legForm.open_time" placeholder="如 09:00" /></div>
      <div class="form-group"><label>关闭时间</label><input v-model="legForm.close_time" placeholder="如 17:30" /></div>
    </div>
    <div v-if="legForm.type === 'DT'" class="grid grid-2">
      <div class="form-group"><label>绕道选项 A</label><input v-model="legForm.detour_a" /></div>
      <div class="form-group"><label>绕道选项 B</label><input v-model="legForm.detour_b" /></div>
    </div>
    <div class="form-group"><label>线索原文（发给选手的内容）</label><textarea v-model="legForm.clue_text" /></div>
    <div class="form-group"><label>判定标准（站点人员看）</label><textarea v-model="legForm.judge_criteria" /></div>
    <div class="modal-actions"><button class="btn btn-secondary" @click="legEditing = null">取消</button><button class="btn" @click="saveLeg">保存</button></div>
  </Modal>
</template>
