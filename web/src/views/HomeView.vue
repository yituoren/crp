<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api } from '@/api';
import { useUi } from '@/stores/ui';
import type { EventSummary } from '@/types';

const ui = useUi();
const mine = ref<EventSummary[]>([]);
const all = ref<EventSummary[]>([]);
const codes = reactive<Record<number, string>>({});
const loading = ref(true);

async function load() {
  try { const d = await api('/events'); mine.value = d.mine; all.value = d.all; } catch (e) { ui.error(e); } finally { loading.value = false; }
}
async function join(ev: EventSummary) {
  const code = (codes[ev.id] ?? '').trim();
  if (!code) { ui.toast('请输入邀请码', 'error'); return; }
  try {
    await api('/events/join', { method: 'POST', body: { code, hash: ev.hash } });
    codes[ev.id] = '';
    ui.toast(`已加入「${ev.name}」`);
    await load();
  } catch (e) { ui.error(e); }
}
const roleText = (r: string) => (r === 'admin' ? '管理员' : r === 'host' ? '主办' : '幕后');
onMounted(load);
</script>

<template>
  <div class="card">
    <div class="card-header"><span>我的比赛</span><span class="text-xs text-gray">点击进入</span></div>
    <div v-if="loading" class="text-gray text-sm">加载中…</div>
    <div v-else-if="!mine.length" class="empty-state">还没有加入任何比赛，在下方输入邀请码加入。</div>
    <div v-else class="grid grid-3">
      <router-link v-for="ev in mine" :key="ev.id" :to="{ name: 'today', params: { hash: ev.hash } }" class="event-card">
        <div class="event-name">{{ ev.name }}</div>
        <div class="text-sm text-gray">我的身份：<span class="badge" :class="ev.role === 'crew' ? 'badge-crew' : 'badge-host'">{{ roleText(ev.role) }}</span></div>
      </router-link>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><span>公共赛事</span><span class="text-xs text-gray">输入主办给的邀请码加入</span></div>
    <div v-if="loading" class="text-gray text-sm">加载中…</div>
    <div v-else class="grid grid-3">
      <div v-for="ev in all" :key="ev.id" class="event-card event-card-static">
        <div class="event-name">{{ ev.name }}</div>
        <div v-if="ev.joined" class="text-sm text-success">已加入</div>
        <div v-else class="flex" style="gap: 6px; flex-wrap: nowrap">
          <input v-model="codes[ev.id]" class="input-sm" placeholder="邀请码" style="flex: 1; min-width: 0" @keyup.enter="join(ev)" />
          <button class="btn btn-sm" @click="join(ev)">加入</button>
        </div>
      </div>
    </div>
  </div>
</template>
