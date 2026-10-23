<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtDateTime } from '@/utils/time';
import { LEG_TYPES, LEG_TYPE_LABEL, legTypeLabel, typeCode, type LegType, legName, isDestinationLeg } from '@/types';
import { fmtDurMs } from '@/utils/time';
import { moneyMode } from '@/utils/money';
import { reactive } from 'vue';
import { useAuth } from '@/stores/auth';
import LegTag from '@/components/LegTag.vue';
import RecordTable from '@/components/RecordTable.vue';
import CutoffUsage from '@/components/CutoffUsage.vue';

const route = useRoute();
const race = useRace();
const ui = useUi();
const episodeId = computed(() => Number(route.params.episodeId));
const legId = computed(() => Number(route.params.legId));
const ep = computed(() => race.episodes.find((e) => e.id === episodeId.value) ?? null);
const leg = computed(() => ep.value?.legs.find((l) => l.id === legId.value) ?? null);
const canUpload = computed(() => race.canUploadTo(legId.value));
const staff = computed(() => race.assignments.filter((a) => a.role === 'station' && (a.leg_ids ?? []).includes(legId.value)).map((a) => a.display_name));
const auth = useAuth();
// ---- 主办/管理员：页内编辑 ----
const isFixed = computed(() => leg.value?.type === 'SL' || leg.value?.type === 'PS');
const selectableTypes = LEG_TYPES.filter((t) => t !== 'SL' && t !== 'PS');
const form = reactive({ type: 'TI' as LegType, name: '', description: '', address: '', map_url: '', clue_text: '', judge_criteria: '', open_time: '', close_time: '', detour_a: '', detour_b: '', shop_open: false, can_eliminate: false, eliminate_count: 1 });
// 熔断种类列表：名称、起始时间、间隔（小时+分钟）、货币模式的消耗；随「保存修改」一起整表保存
const cutoffs = ref<{ id: number; name: string; sh: number; sm: number; ih: number; im: number; cost: string }[]>([]);
function addCutoff() { cutoffs.value.push({ id: 0, name: '', sh: 0, sm: 0, ih: 0, im: 0, cost: '' }); }
function removeCutoff(i: number) { cutoffs.value.splice(i, 1); }
const dirty = ref(false);
let filling = false;
function fillForm() {
  const l = leg.value; if (!l) return;
  filling = true;
  Object.assign(form, { type: l.type, name: l.name, description: l.description, address: l.address, map_url: l.map_url, clue_text: l.clue_text, judge_criteria: l.judge_criteria, open_time: l.open_time, close_time: l.close_time, detour_a: l.detour_a, detour_b: l.detour_b, shop_open: !!l.shop_open, can_eliminate: !!l.can_eliminate, eliminate_count: l.eliminate_count || (l.type === 'PS' ? 2 : 1) });
  cutoffs.value = (l.cutoffs ?? []).map((c) => ({ id: c.id, name: c.name, sh: Math.floor(c.start_min / 60), sm: c.start_min % 60, ih: Math.floor(c.interval_min / 60), im: c.interval_min % 60, cost: c.cost ? String(c.cost) : '' }));
  dirty.value = false;
  setTimeout(() => { filling = false; }, 0);
}
watch(leg, () => { if (!dirty.value) fillForm(); }, { immediate: true });
watch(form, () => { if (!filling) dirty.value = true; }, { deep: true });
watch(cutoffs, () => { if (!filling) dirty.value = true; }, { deep: true });
async function saveLeg() {
  if (!leg.value) return;
  const mins = (h: number, m: number) => Math.max(0, Number(h) || 0) * 60 + Math.max(0, Number(m) || 0);
  const body = { ...form };
  const items = cutoffs.value.map((c) => ({ id: c.id || undefined, name: c.name.trim(), start_min: mins(c.sh, c.sm), interval_min: mins(c.ih, c.im), cost: c.cost || 0 }));
  try {
    await api(`/legs/${leg.value.id}`, { method: 'PUT', body });
    await api(`/legs/${leg.value.id}/cutoffs`, { method: 'PUT', body: { items } });
    await race.loadEpisodes(); fillForm(); ui.toast('环节已保存');
  } catch (e) { ui.error(e); }
}
const fileInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const preview = ref<string | null>(null);

// 进入详情页时把当前赛段切到该环节所属赛段，保证记录/排班数据一致
watch(episodeId, (id) => { if (id && id !== race.currentEpisodeId) race.selectEpisode(id); }, { immediate: true });

async function upload(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { ui.toast('文件过大，请压缩至 10MB 以内', 'error'); return; }
  const form = new FormData();
  form.append('file', file);
  uploading.value = true;
  try { await api(`/legs/${legId.value}/attachments`, { method: 'POST', form, retries: 0 }); await race.loadEpisodes(); ui.toast('上传成功'); }
  catch (e) { ui.error(e); }
  finally { uploading.value = false; if (fileInput.value) fileInput.value.value = ''; }
}
async function removeAttachment(id: number) {
  if (!(await ui.confirm('删除附件', '确定删除该附件？', { danger: true }))) return;
  try { await api(`/attachments/${id}`, { method: 'DELETE' }); await race.loadEpisodes(); } catch (e) { ui.error(e); }
}
const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
</script>

<template>
  <div v-if="!leg || !ep" class="empty-state">环节不存在 <router-link :to="{ name: 'episodes' }">返回赛段列表</router-link></div>
  <template v-else>
    <div class="flex-between mb-2">
      <div><router-link :to="{ name: 'episodes' }" class="text-sm"><Icon name="arrow_back" size="16" />{{ ep.code }} 环节列表</router-link></div>
    </div>
    <!-- 主办/管理员：页内编辑 -->
    <div v-if="auth.isHost" class="card leg-edit">
      <div class="card-header">
        <span><LegTag :type="leg.type" /> {{ legName(leg) }} <span class="text-gray text-sm">站点：{{ staff.join('、') || '未分配' }}</span></span>
        <span class="flex">
          <span v-if="dirty" class="text-xs text-warning">有未保存的修改</span>
          <button class="btn" :disabled="!dirty" @click="saveLeg">保存修改</button>
        </span>
      </div>
      <div class="edit-grid">
        <div class="edit-col">
          <div class="edit-section">
            <div class="edit-section-title">基本信息</div>
            <div class="field-row">
              <div class="form-group"><label>类型</label>
                <input v-if="isFixed" :value="`${typeCode(form.type)} · ${legTypeLabel(form.type, race.isLastEpisode(episodeId))}（固定）`" disabled />
                <MSelect v-else v-model="form.type" outlined :options="selectableTypes.map((t) => ({ value: t, label: `${typeCode(t)} · ${LEG_TYPE_LABEL[t]}` }))" />
              </div>
              <div class="form-group"><label>{{ isDestinationLeg(form.type) ? '目的地' : '名称' }}</label><input v-model="form.name" :placeholder="form.type === 'RI' ? '目的地名称，显示时自动加箭头' : form.type === 'PS' ? '中继站所在地' : ''" /></div>
            </div>
            <label v-if="moneyMode() === 'coin'" class="check-row"><input v-model="form.shop_open" type="checkbox" /> 本环节开放商店<span class="text-gray text-sm">（队伍可在此用货币购买商品）</span></label>
          </div>
          <div v-if="form.type !== 'BR'" class="edit-section">
            <div class="edit-section-title">淘汰</div>
            <label class="check-row"><input v-model="form.can_eliminate" type="checkbox" :disabled="form.type === 'PS'" /> 本环节可淘汰<span class="text-gray text-sm">（{{ form.type === 'PS' ? '中继站一定可淘汰' : '所有队伍到达后，最后到的几队自动淘汰' }}）</span></label>
            <div class="form-group" style="max-width: 200px"><label>淘汰队数</label><input v-model.number="form.eliminate_count" type="number" min="1" step="1" inputmode="numeric" :disabled="!form.can_eliminate && form.type !== 'PS'" /></div>
          </div>
          <div class="edit-section">
            <div class="flex-between" style="margin-bottom: 8px"><span class="edit-section-title" style="margin: 0">熔断</span><button class="btn btn-text btn-sm" @click="addCutoff"><Icon name="add" size="16" />添加熔断</button></div>
            <div v-for="(c, i) in cutoffs" :key="i" class="cutoff-edit">
              <input v-model="c.name" placeholder="种类名称" class="cutoff-name" />
              <div class="hm-row" title="起始时间"><input v-model.number="c.sh" type="number" min="0" step="1" inputmode="numeric" /><span>h</span><input v-model.number="c.sm" type="number" min="0" max="59" step="1" inputmode="numeric" /><span>m 起</span></div>
              <div class="hm-row" title="间隔时间"><input v-model.number="c.ih" type="number" min="0" step="1" inputmode="numeric" /><span>h</span><input v-model.number="c.im" type="number" min="0" max="59" step="1" inputmode="numeric" /><span>m 隔</span></div>
              <input v-if="moneyMode() === 'coin'" v-model="c.cost" type="number" min="0" step="1" inputmode="numeric" placeholder="消耗（币）" class="cutoff-cost" />
              <button class="icon-btn icon-btn-sm icon-btn-danger" title="删除" @click="removeCutoff(i)"><Icon name="delete" size="18" /></button>
            </div>
            <div v-if="!cutoffs.length" class="text-sm text-gray">没有熔断</div>
          </div>
          <div class="edit-section">
            <div class="edit-section-title">地点与时间</div>
            <div class="form-group"><label>地址</label><input v-model="form.address" placeholder="到站点后能直接找到的描述" /></div>
            <div class="form-group"><label>地图链接</label><input v-model="form.map_url" placeholder="高德 / 百度地图分享链接" /></div>
            <div class="field-row">
              <div class="form-group"><label>开放时间</label><input v-model="form.open_time" placeholder="如 09:00" /></div>
              <div class="form-group"><label>关闭时间</label><input v-model="form.close_time" placeholder="如 17:30" /></div>
            </div>
          </div>
          <div v-if="form.type === 'DT'" class="edit-section">
            <div class="edit-section-title">绕道选项</div>
            <div class="field-row">
              <div class="form-group"><label>选项 A</label><input v-model="form.detour_a" /></div>
              <div class="form-group"><label>选项 B</label><input v-model="form.detour_b" /></div>
            </div>
          </div>
        </div>
        <div class="edit-col">
          <div class="edit-section edit-section-fill">
            <div class="edit-section-title">文字内容</div>
            <div class="form-group ta-group"><label>环节说明<span class="text-gray">（任务内容、流程，所有幕后可见）</span></label><textarea v-model="form.description" class="ta-md" /></div>
            <div class="form-group ta-group"><label>线索原文<span class="text-gray">（发给选手的内容）</span></label><textarea v-model="form.clue_text" class="ta-md" /></div>
            <div class="form-group ta-group" style="margin-bottom: 0"><label>判定标准<span class="text-gray">（站点人员看）</span></label><textarea v-model="form.judge_criteria" class="ta-md" /></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 其他人：只读信息 -->
    <div v-else class="card">
      <div class="card-header">
        <span><LegTag :type="leg.type" /> {{ legName(leg) }} <span class="text-gray text-sm">{{ legTypeLabel(leg.type, race.isLastEpisode(episodeId)) }}</span></span>
        <span class="text-sm text-gray">站点：{{ staff.join('、') || '未分配' }}</span>
      </div>
      <div class="grid grid-2">
        <div>
          <div v-if="leg.address" class="mb-2">地址：{{ leg.address }} <a v-if="leg.map_url" :href="leg.map_url" target="_blank">打开地图</a></div>
          <div v-if="leg.open_time || leg.close_time" class="mb-2">开放时间：{{ leg.open_time || '-' }} ~ {{ leg.close_time || '-' }}</div>
          <div v-if="leg.shop_open" class="mb-2"><span class="badge badge-info">开放商店</span></div>
          <div v-if="leg.can_eliminate" class="mb-2"><span class="badge badge-urgent">淘汰 {{ leg.eliminate_count }} 队</span><span class="text-gray text-sm"> 所有队伍到达后，最后到的 {{ leg.eliminate_count }} 队自动淘汰</span></div>
          <div v-if="leg.cutoffs.length" class="mb-2">熔断：<span v-for="c in leg.cutoffs" :key="c.id" class="badge badge-info" style="margin-right: 6px">{{ c.name }} · {{ fmtDurMs(c.start_min * 60000) }} 起 · 每 {{ fmtDurMs(c.interval_min * 60000) }}{{ moneyMode() === 'coin' && c.cost ? ` · ${c.cost} 币` : '' }}</span></div>
          <div v-if="leg.type === 'DT'" class="mb-2">绕道：A「{{ leg.detour_a || '未填写' }}」 / B「{{ leg.detour_b || '未填写' }}」</div>
          <div class="section-title text-sm">环节说明</div>
          <div class="pre" :class="{ 'text-gray': !leg.description }">{{ leg.description || '暂无说明' }}</div>
        </div>
        <div>
          <div v-if="leg.clue_text" class="mb-2"><div class="section-title text-sm">线索原文</div><div class="pre alert alert-info">{{ leg.clue_text }}</div></div>
          <div v-if="leg.judge_criteria"><div class="section-title text-sm">判定标准</div><div class="pre alert alert-warning">{{ leg.judge_criteria }}</div></div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">附件 / 线索图片（{{ leg.attachments.length }}）</div>
      <div v-if="!leg.attachments.length" class="text-gray text-sm">暂无附件</div>
      <div v-else class="grid grid-4">
        <div v-for="att in leg.attachments" :key="att.id" class="att-item">
          <div class="text-xs text-gray mb-1" style="word-break: break-all">{{ att.filename }} · {{ fmtSize(att.size) }}</div>
          <img v-if="att.mime.startsWith('image/')" :src="att.url" loading="lazy" style="cursor: zoom-in" @click="preview = att.url" />
          <a v-else :href="att.url" target="_blank" class="btn btn-text btn-sm"><Icon name="open_in_new" size="16" />打开文件</a>
          <div class="text-xs text-gray mt-1">{{ fmtDateTime(att.created_at) }}</div>
          <button v-if="canUpload" class="btn btn-text btn-text-danger btn-sm mt-1" @click="removeAttachment(att.id)"><Icon name="delete" size="16" />删除</button>
        </div>
      </div>
      <div v-if="canUpload" class="upload-area" @click="fileInput?.click()">
        {{ uploading ? '上传中…' : '点击上传图片 / PDF（10MB 以内）' }}
        <input ref="fileInput" type="file" class="hidden" accept="image/*,application/pdf" @change="upload" />
      </div>
    </div>

    <div class="card">
      <div class="card-header">队伍完成情况</div>
      <RecordTable :leg="leg" />
    </div>

    <div v-if="preview" class="modal-overlay" @click="preview = null">
      <img :src="preview" style="max-width: 100%; max-height: 92vh; border-radius: 8px" />
    </div>
  </template>
  <CutoffUsage v-if="leg" :leg="leg" />
</template>
