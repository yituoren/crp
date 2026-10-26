<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api, setUnauthorizedHandler } from '@/api';
import { useAuth } from '@/stores/auth';
import { useUi } from '@/stores/ui';
import { fmtDate } from '@/utils/time';
import Modal from '@/components/Modal.vue';
import AccountMenu from '@/components/AccountMenu.vue';
import type { EventSummary } from '@/types';

const auth = useAuth();
const ui = useUi();
const router = useRouter();

// List data
const events = ref<EventSummary[]>([]);
const loading = ref(true);
async function load() {
  loading.value = true;
  try { const d = await api('/events'); events.value = d.all; } catch (e) { ui.error(e); } finally { loading.value = false; }
}

// Sidebar: acts as a preset filter (my events = joined only); a drawer on phones
const tab = ref<'mine' | 'all'>('mine');
const drawer = ref(false);
function pickTab(t: 'mine' | 'all') { tab.value = t; drawer.value = false; }
const mineCount = computed(() => events.value.filter((e) => e.joined).length);

// View mode: cards / rows, remembered
const VIEW_KEY = 'crp.home.view';
const view = ref<'cards' | 'list'>('cards');
try { if (localStorage.getItem(VIEW_KEY) === 'list') view.value = 'list'; } catch { /* ignore */ }
watch(view, (v) => { try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } });

// Top search: name / host keyword plus three filters
const q = ref('');
const filter = reactive({ time: '' as '' | '7' | '30' | '365', role: '' as '' | 'host' | 'crew' | 'none', status: '' as '' | 'pending' | 'running' | 'finished' });
const TIME_OPTIONS = [{ value: '', label: '不限时间' }, { value: '7', label: '最近一周' }, { value: '30', label: '最近一个月' }, { value: '365', label: '最近一年' }];
const ROLE_OPTIONS = [{ value: '', label: '不限身份' }, { value: 'host', label: '我是主办' }, { value: 'crew', label: '我是幕后' }, { value: 'none', label: '未加入' }];
const STATUS_OPTIONS = [{ value: '', label: '不限状态' }, { value: 'pending', label: '未开始' }, { value: 'running', label: '进行中' }, { value: 'finished', label: '已结束' }];
const rows = computed(() => {
  const kw = q.value.trim().toLowerCase();
  const since = filter.time ? Date.now() - Number(filter.time) * 86400000 : 0;
  return events.value.filter((e) => {
    if (tab.value === 'mine' && !e.joined) return false;
    if (kw && !e.name.toLowerCase().includes(kw) && !e.ownerName.toLowerCase().includes(kw)) return false;
    if (since && new Date(e.createdAt).getTime() < since) return false;
    if (filter.role === 'none' ? e.joined : filter.role === 'host' ? !(e.joined && e.role !== 'crew') : filter.role === 'crew' ? !(e.joined && e.role === 'crew') : false) return false;
    if (filter.status && e.status !== filter.status) return false;
    return true;
  });
});
const roleText = (e: EventSummary) => (!e.joined ? (e.pending ? '待审核' : '未加入') : e.role === 'admin' ? '管理员' : e.role === 'host' ? '主办' : '幕后');
const STATUS_TEXT = { pending: '未开始', running: '进行中', finished: '已结束' } as const;
const snippet = (e: EventSummary) => [e.ownerName ? `主办 ${e.ownerName}` : '', `${e.memberCount} 名幕后`, `${e.episodeCount} 个赛段`].filter(Boolean).join(' · ');

// Row click: joined events open directly; otherwise a join request dialog (invite code + note), membership after host approval
const joining = ref<EventSummary | null>(null);
const code = ref('');
const note = ref('');
function openRow(e: EventSummary) {
  if (e.joined) { router.push({ name: 'today', params: { hash: e.hash } }); return; }
  if (e.pending) { ui.toast('已提交申请，等待主办审核'); return; }
  joining.value = e; code.value = ''; note.value = '';
}
async function join() {
  const ev = joining.value; if (!ev) return;
  const c = code.value.trim();
  if (!c) { ui.toast('请输入邀请码', 'error'); return; }
  try {
    await api('/events/join', { method: 'POST', body: { code: c, note: note.value.trim(), hash: ev.hash } });
    joining.value = null;
    ui.toast('已提交申请，等待主办审核');
    await load();
  } catch (e) { ui.error(e); }
}

// Create event: only name and invite code here, the rest in the event settings
const creating = ref(false);
const form = reactive({ name: '', inviteCode: '' });
function openCreate() { Object.assign(form, { name: '', inviteCode: '' }); creating.value = true; drawer.value = false; }
async function create() {
  if (!form.name.trim()) { ui.toast('请填写赛事名称', 'error'); return; }
  try {
    const d = await api('/events', { method: 'POST', body: { name: form.name.trim(), inviteCode: form.inviteCode.trim() } });
    creating.value = false;
    ui.toast(`已创建「${d.event.name}」`);
    await auth.fetchMe();
    router.push({ name: 'today', params: { hash: d.event.hash } });
  } catch (e) { ui.error(e); }
}

onMounted(() => {
  auth.leaveEvent();
  setUnauthorizedHandler(() => { auth.user = null; router.replace('/login'); });
  load();
});
</script>

<template>
  <div class="home" :class="{ 'drawer-open': drawer }">
    <div class="home-scrim" @click="drawer = false"></div>
    <aside class="home-side">
      <div class="home-brand">CRP</div>
      <button class="home-compose" @click="openCreate"><Icon name="edit" size="22" />创建比赛</button>
      <nav class="home-nav">
        <a href="#" :class="{ active: tab === 'mine' }" @click.prevent="pickTab('mine')"><Icon name="inbox" size="20" /><span>我的比赛</span><em>{{ mineCount }}</em></a>
        <a href="#" :class="{ active: tab === 'all' }" @click.prevent="pickTab('all')"><Icon name="public" size="20" /><span>全部比赛</span><em>{{ events.length }}</em></a>
      </nav>
    </aside>

    <main class="home-main">
      <div class="home-top">
        <button class="icon-btn home-menu-btn" title="菜单" aria-label="菜单" @click="drawer = true"><Icon name="menu" size="24" /></button>
        <label class="home-search">
          <Icon name="search" size="22" />
          <input v-model="q" placeholder="搜索比赛名称或主办" />
          <button v-if="q" class="icon-btn" title="清除" aria-label="清除" @click="q = ''"><Icon name="close" size="20" /></button>
        </label>
        <AccountMenu />
      </div>

      <section class="home-panel">
        <div class="home-chips">
          <div class="home-chips-row">
            <MSelect v-model="filter.time" chip :options="TIME_OPTIONS" />
            <MSelect v-model="filter.role" chip :options="ROLE_OPTIONS" />
            <MSelect v-model="filter.status" chip :options="STATUS_OPTIONS" />
          </div>
          <div class="home-view">
            <button class="icon-btn" :class="{ active: view === 'cards' }" title="卡片" aria-label="卡片" @click="view = 'cards'"><Icon name="grid_view" size="20" /></button>
            <button class="icon-btn" :class="{ active: view === 'list' }" title="条目" aria-label="条目" @click="view = 'list'"><Icon name="view_list" size="20" /></button>
          </div>
        </div>
        <div class="home-toolbar">
          <button class="icon-btn" title="刷新" aria-label="刷新" @click="load"><Icon name="refresh" size="20" /></button>
          <span class="text-sm text-gray">共 {{ rows.length }} 场</span>
        </div>
        <div v-if="loading" class="loading"><span class="spinner"></span></div>
        <div v-else-if="!rows.length" class="empty-state">{{ tab === 'mine' && !events.some((e) => e.joined) ? '还没有加入任何比赛，到「全部比赛」里凭邀请码加入，或创建一场新比赛' : '没有符合条件的比赛' }}</div>
        <div v-else-if="view === 'list'" class="home-list">
          <div v-for="e in rows" :key="e.id" class="home-row" :class="{ 'home-row-out': !e.joined }" @click="openRow(e)">
            <span class="home-role" :class="'role-' + (e.joined ? e.role : 'none')">{{ roleText(e) }}</span>
            <span class="home-row-text"><span class="home-row-name">{{ e.name }}</span><span class="home-row-snippet"> - {{ snippet(e) }}</span></span>
            <span class="home-row-meta"><span class="home-status" :class="'status-' + e.status">{{ STATUS_TEXT[e.status] }}</span><span class="home-date">{{ fmtDate(e.createdAt) }}</span></span>
          </div>
        </div>
        <div v-else class="home-cards">
          <div v-for="e in rows" :key="e.id" class="home-card" :class="{ 'home-row-out': !e.joined }" @click="openRow(e)">
            <div class="home-card-head"><span class="home-row-name">{{ e.name }}</span><span class="home-role" :class="'role-' + (e.joined ? e.role : 'none')">{{ roleText(e) }}</span></div>
            <div class="home-card-snippet">{{ snippet(e) }}</div>
            <div class="home-row-meta"><span class="home-status" :class="'status-' + e.status">{{ STATUS_TEXT[e.status] }}</span><span class="home-date">{{ fmtDate(e.createdAt) }}</span></div>
          </div>
        </div>
      </section>
    </main>
  </div>

  <Modal v-if="joining" :title="`申请加入「${joining.name}」`" small @close="joining = null">
    <div class="form-group"><label>邀请码</label><input v-model="code" placeholder="向主办索取" autofocus @keyup.enter="join" /></div>
    <div class="form-group"><label>说明<span class="text-gray text-sm">（选填，给主办看）</span></label><textarea v-model="note" rows="3" placeholder="如：我是站点志愿者，负责第 2 赛段" /></div>
    <div class="modal-actions"><button class="btn btn-text" @click="joining = null">取消</button><button class="btn" @click="join">提交申请</button></div>
  </Modal>

  <Modal v-if="creating" title="创建比赛" small @close="creating = false">
    <div class="form-group"><label>赛事名称</label><input v-model="form.name" placeholder="如 BJ20 全明星赛" autofocus @keyup.enter="create" /></div>
    <div class="form-group"><label>邀请码<span class="text-gray text-sm">（留空自动生成）</span></label><input v-model="form.inviteCode" placeholder="如 bj20" @keyup.enter="create" /></div>
    <div class="modal-actions"><button class="btn btn-text" @click="creating = false">取消</button><button class="btn" @click="create">创建</button></div>
  </Modal>
</template>
