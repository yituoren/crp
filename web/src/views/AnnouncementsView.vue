<script setup lang="ts">
import { onMounted, reactive, watch } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtDateMinute } from '@/utils/time';

const auth = useAuth();
const race = useRace();
const ui = useUi();
const form = reactive({ content: '', audience: 'all' });

async function post() {
  if (!form.content.trim()) { ui.toast('内容不能为空', 'error'); return; }
  try {
    await api('/announcements', { method: 'POST', body: { content: form.content, audience: form.audience } });
    form.content = '';
    await race.loadAnnouncements();
    ui.toast('公告已发布');
  } catch (e) { ui.error(e); }
}
async function pin(id: number, pinned: boolean) {
  try { await api(`/announcements/${id}/pin`, { method: 'POST', body: { pinned } }); await race.loadAnnouncements(); } catch (e) { ui.error(e); }
}
async function remove(id: number) {
  if (!(await ui.confirm('删除公告', '确定删除这条公告？', { danger: true }))) return;
  try { await api(`/announcements/${id}`, { method: 'DELETE' }); await race.loadAnnouncements(); } catch (e) { ui.error(e); }
}
onMounted(() => race.markAnnouncementsRead());
watch(() => race.announcements, () => race.markAnnouncementsRead());
</script>

<template>
  <div class="fill-page">
    <div class="card fill-card">
      <div class="card-header"><span>公告（{{ race.announcements.length }}）</span></div>
      <div v-if="auth.isHost" class="ann-compose mb-2">
        <select v-model="form.audience" class="input-inline" style="width: 120px; flex: none" disabled title="通知对象（暂只支持全部幕后）">
          <option value="all">全部幕后</option>
        </select>
        <textarea v-model="form.content" placeholder="发给所有幕后的内容…" rows="2" @keydown.ctrl.enter="post" @keydown.meta.enter="post" />
        <button class="btn" style="flex: none; align-self: stretch" @click="post">发送</button>
      </div>
      <div class="scroll-y">
        <div v-if="!race.announcements.length" class="empty-state">暂无公告</div>
        <div v-for="a in race.announcements" :key="a.id" class="alert" :class="a.pinned_at ? 'alert-warning' : 'alert-info'">
          <div class="pre"><span v-if="a.pinned_at" class="badge badge-warning">置顶</span> {{ a.content }}</div>
          <div class="flex-between mt-1">
            <span class="text-xs text-gray">{{ a.created_by }} · {{ fmtDateMinute(a.created_at) }}</span>
            <span v-if="auth.isHost" class="flex" style="gap: 6px">
              <button class="btn btn-outline btn-sm" @click="pin(a.id, !a.pinned_at)">{{ a.pinned_at ? '取消置顶' : '置顶' }}</button>
              <button class="btn btn-outline btn-sm" @click="remove(a.id)">删除</button>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
