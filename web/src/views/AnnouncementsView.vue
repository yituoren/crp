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
      <!-- 发公告：左边输入框，右边一列（上：发送对象，下：发送），输入框高度与右列对齐 -->
      <div v-if="auth.isHost" class="ann-compose mb-2">
        <textarea v-model="form.content" placeholder="写点什么，发给所有幕后…" @keydown.ctrl.enter="post" @keydown.meta.enter="post" />
        <div class="ann-side">
          <MSelect v-model="form.audience" disabled title="通知对象（暂只支持全部幕后）" :options="[{ value: 'all', label: '全部幕后' }]" />
          <button class="btn ann-send" @click="post"><Icon name="send" size="18" />发送</button>
        </div>
      </div>
      <div class="scroll-y">
        <div v-if="!race.announcements.length" class="empty-state">暂无公告</div>
        <div v-for="a in race.announcements" :key="a.id" class="alert" :class="a.pinned_at ? 'alert-warning' : 'alert-info'">
          <div class="pre"><span v-if="a.pinned_at" class="badge badge-warning">置顶</span> {{ a.content }}</div>
          <div class="flex-between mt-1">
            <span class="text-xs text-gray">{{ a.created_by }} · {{ fmtDateMinute(a.created_at) }}</span>
            <span v-if="auth.isHost" class="flex" style="gap: 6px">
              <button class="btn btn-text btn-sm" @click="pin(a.id, !a.pinned_at)"><Icon name="push_pin" size="16" />{{ a.pinned_at ? '取消置顶' : '置顶' }}</button>
              <button class="btn btn-text btn-text-danger btn-sm" @click="remove(a.id)"><Icon name="delete" size="16" />删除</button>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
