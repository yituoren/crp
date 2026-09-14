<script setup lang="ts">
import { onMounted, reactive, watch } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtDateTime } from '@/utils/time';

const auth = useAuth();
const race = useRace();
const ui = useUi();
const form = reactive({ content: '', level: 'info' });
const levelLabel: Record<string, string> = { info: '通知', warning: '注意', urgent: '紧急' };

async function post() {
  if (!form.content.trim()) { ui.toast('内容不能为空', 'error'); return; }
  try {
    await api('/announcements', { method: 'POST', body: form });
    form.content = '';
    await race.loadAnnouncements();
    ui.toast('公告已发布');
  } catch (e) { ui.error(e); }
}
async function remove(id: number) {
  if (!(await ui.confirm('删除公告', '确定删除这条公告？', { danger: true }))) return;
  try { await api(`/announcements/${id}`, { method: 'DELETE' }); await race.loadAnnouncements(); } catch (e) { ui.error(e); }
}
// 进入页面即视为已读；页面停留期间有新公告也算已读
onMounted(() => race.markAnnouncementsRead());
watch(() => race.announcements, () => race.markAnnouncementsRead());
</script>

<template>
  <div v-if="auth.isHost" class="card">
    <div class="card-header">发布公告</div>
    <div class="form-group"><textarea v-model="form.content" placeholder="发给所有幕后的内容…" style="min-height: 70px" /></div>
    <div class="flex">
      <select v-model="form.level" class="input-inline" style="width: 110px"><option value="info">通知</option><option value="urgent">紧急</option></select>
      <button class="btn" @click="post">发布</button>
    </div>
  </div>
  <div class="card">
    <div class="card-header">公告（{{ race.announcements.length }}）</div>
    <div v-if="!race.announcements.length" class="empty-state">暂无公告</div>
    <div v-for="a in race.announcements" :key="a.id" class="alert" :class="'alert-' + a.level">
      <div class="flex-between">
        <span class="pre"><span class="badge" :class="'badge-' + a.level">{{ levelLabel[a.level] ?? a.level }}</span> {{ a.content }}</span>
        <span class="text-xs text-gray">{{ a.created_by }} · {{ fmtDateTime(a.created_at) }} <button v-if="auth.isHost" class="btn btn-outline btn-sm" @click="remove(a.id)">删</button></span>
      </div>
    </div>
  </div>
</template>
