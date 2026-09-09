<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtDateTime } from '@/utils/time';
import { LEG_TYPE_LABEL } from '@/types';
import LegTag from '@/components/LegTag.vue';
import RecordTable from '@/components/RecordTable.vue';

const route = useRoute();
const race = useRace();
const ui = useUi();
const episodeId = computed(() => Number(route.params.episodeId));
const legId = computed(() => Number(route.params.legId));
const ep = computed(() => race.episodes.find((e) => e.id === episodeId.value) ?? null);
const leg = computed(() => ep.value?.legs.find((l) => l.id === legId.value) ?? null);
const canUpload = computed(() => race.canUploadTo(legId.value));
const staff = computed(() => race.assignments.filter((a) => a.role === 'station' && a.leg_id === legId.value).map((a) => a.display_name));
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
  try { await api(`/legs/${legId.value}/attachments`, { method: 'POST', form, retries: 0 }); await race.loadEpisodes(); ui.toast('📎 上传成功'); }
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
  <div v-if="!leg || !ep" class="empty-state">环节不存在 <router-link to="/episodes">返回赛段列表</router-link></div>
  <template v-else>
    <div class="flex-between mb-2">
      <div><router-link to="/episodes" class="text-sm">← {{ ep.code }} 环节列表</router-link></div>
    </div>
    <div class="card">
      <div class="card-header">
        <span><LegTag :type="leg.type" /> {{ leg.name }} <span class="text-gray text-sm">{{ LEG_TYPE_LABEL[leg.type] }}</span></span>
        <span class="text-sm text-gray">站点：{{ staff.join('、') || '未分配' }}</span>
      </div>
      <div class="grid grid-2">
        <div>
          <div v-if="leg.address" class="mb-2">📍 {{ leg.address }} <a v-if="leg.map_url" :href="leg.map_url" target="_blank">打开地图</a></div>
          <div v-if="leg.open_time || leg.close_time" class="mb-2">🕐 开放时间：{{ leg.open_time || '-' }} ~ {{ leg.close_time || '-' }}</div>
          <div v-if="leg.type === 'DT'" class="mb-2">🔀 绕道：A「{{ leg.detour_a || '未填写' }}」 / B「{{ leg.detour_b || '未填写' }}」</div>
          <div class="section-title text-sm">📝 环节说明</div>
          <div class="pre" :class="{ 'text-gray': !leg.description }">{{ leg.description || '暂无说明' }}</div>
        </div>
        <div>
          <div v-if="leg.clue_text" class="mb-2"><div class="section-title text-sm">✉️ 线索原文</div><div class="pre alert alert-info">{{ leg.clue_text }}</div></div>
          <div v-if="leg.judge_criteria"><div class="section-title text-sm">⚖️ 判定标准</div><div class="pre alert alert-warning">{{ leg.judge_criteria }}</div></div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">📎 附件 / 线索图片（{{ leg.attachments.length }}）</div>
      <div v-if="!leg.attachments.length" class="text-gray text-sm">暂无附件</div>
      <div v-else class="grid grid-4">
        <div v-for="att in leg.attachments" :key="att.id" class="att-item">
          <div class="text-xs text-gray mb-1" style="word-break: break-all">{{ att.filename }} · {{ fmtSize(att.size) }}</div>
          <img v-if="att.mime.startsWith('image/')" :src="att.url" loading="lazy" style="cursor: zoom-in" @click="preview = att.url" />
          <a v-else :href="att.url" target="_blank" class="btn btn-outline btn-sm">📄 打开文件</a>
          <div class="text-xs text-gray mt-1">{{ fmtDateTime(att.created_at) }}</div>
          <button v-if="canUpload" class="btn btn-danger btn-sm mt-1" @click="removeAttachment(att.id)">删除</button>
        </div>
      </div>
      <div v-if="canUpload" class="upload-area" @click="fileInput?.click()">
        {{ uploading ? '上传中…' : '📤 点击上传图片 / PDF（10MB 以内）' }}
        <input ref="fileInput" type="file" class="hidden" accept="image/*,application/pdf" @change="upload" />
      </div>
    </div>

    <div class="card">
      <div class="card-header">🏁 队伍完成情况</div>
      <RecordTable :leg="leg" />
    </div>

    <div v-if="preview" class="modal-overlay" @click="preview = null">
      <img :src="preview" style="max-width: 100%; max-height: 92vh; border-radius: 8px" />
    </div>
  </template>
</template>
