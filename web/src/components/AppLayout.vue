<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { connectRealtime, disconnectRealtime } from '@/realtime';
import { setUnauthorizedHandler } from '@/api';
import TeamPositions from './TeamPositions.vue';
import AccountMenu from './AccountMenu.vue';
import { ref, computed } from 'vue';

const auth = useAuth();
const race = useRace();
const ui = useUi();
const router = useRouter();
const route = useRoute();
const hash = computed(() => String(route.params.hash ?? ''));
/** Enter / switch event: load the event info, then its data */
async function enterEvent() {
  race.reset();
  try {
    await auth.loadEvent(hash.value);
    await race.loadAll();
  } catch (e) {
    ui.error(e);
    router.replace('/');
  }
}

// Narrow screens: two pages (left: live board, right: regular pages), switched with the buttons at the bottom
const narrowQuery = window.matchMedia('(max-width: 1000px)');
const narrow = ref(narrowQuery.matches);
// Phones (≤760px): separate shell (top bar + bottom navigation + drawer + full-screen live board), no two-page paging
const mobileQuery = window.matchMedia('(max-width: 760px)');
const mobile = ref(mobileQuery.matches);
const drawer = ref(false);
const liveOpen = ref(false);
mobileQuery.addEventListener('change', (e) => { mobile.value = e.matches; drawer.value = false; liveOpen.value = false; });
watch(() => route.fullPath, () => { drawer.value = false; });
const NAV = [
  { name: 'today', label: '我的', icon: 'person' },
  { name: 'announcements', label: '公告', icon: 'campaign' },
  { name: 'episodes', label: '赛段', icon: 'flag' },
  { name: 'schedule', label: '排班', icon: 'schedule' },
  { name: 'teams', label: '队伍', icon: 'group' },
  { name: 'currency', label: '经费', icon: 'payments' },
  { name: 'progress', label: '进度', icon: 'leaderboard' },
] as const;
const BOTTOM = ['today', 'announcements', 'episodes', 'currency', 'progress'];
const bottomNav = computed(() => NAV.filter((n) => BOTTOM.includes(n.name)));
const navActive = (name: string) => route.name === name || (name === 'episodes' && route.name === 'leg');
const page = ref(1); // 0 = live board, 1 = regular pages
// Position via a CSS variable: narrow screens translate by --page, wide screens are pinned by a media query
const trackStyle = computed(() => ({ '--page': String(page.value) }));
function goPage(i: number) { page.value = Math.max(0, Math.min(1, i)); }
function onLayoutChange() {
  if (narrowQuery.matches !== narrow.value) { narrow.value = narrowQuery.matches; page.value = 1; }
}

onMounted(async () => {
  setUnauthorizedHandler(() => { auth.user = null; router.replace('/login'); });
  narrowQuery.addEventListener('change', onLayoutChange);
  window.addEventListener('resize', onLayoutChange);
  await enterEvent();
  connectRealtime();
});
watch(hash, (h, prev) => { if (h && prev && h !== prev) enterEvent(); });
onUnmounted(() => {
  disconnectRealtime();
  narrowQuery.removeEventListener('change', onLayoutChange);
  window.removeEventListener('resize', onLayoutChange);
});

</script>

<template>
  <!-- ========== Phone: top bar + content + bottom navigation + drawer ========== -->
  <div v-if="mobile" class="m-app">
    <header class="m-bar">
      <button class="icon-btn" title="菜单" aria-label="菜单" @click="drawer = true"><Icon name="menu" size="24" /></button>
      <div class="m-title">{{ auth.event.name }}</div>
      <button class="m-toggle" @click="liveOpen = true"><Icon name="tv" size="18" />大屏</button>
      <span v-if="!ui.online" class="m-offline" title="与服务器的实时连接已断开，正在重连"><span class="sync-dot"></span></span>
      <AccountMenu :before-logout="disconnectRealtime" />
    </header>
    <main class="m-body">
      <div class="page-body">
        <router-view v-if="race.loaded" />
        <div v-else class="loading"><span class="spinner"></span></div>
      </div>
    </main>
    <nav class="m-nav">
      <router-link v-for="n in bottomNav" :key="n.name" :to="{ name: n.name }" :class="{ 'router-link-active': navActive(n.name) }" active-class="" exact-active-class="">
        <span class="m-nav-ic"><Icon :name="n.icon" size="22" /></span>{{ n.label }}
        <span v-if="n.name === 'announcements' && race.unreadAnnouncements" class="nav-dot"></span>
      </router-link>
    </nav>
    <div v-if="drawer" class="m-scrim" @click="drawer = false"></div>
    <aside class="m-drawer" :class="{ open: drawer }">
      <div class="m-drawer-head">{{ auth.event.name }}</div>
      <router-link v-for="n in NAV" :key="n.name" :to="{ name: n.name }" :class="{ 'router-link-active': navActive(n.name) }" active-class="" exact-active-class=""><Icon :name="n.icon" size="22" />{{ n.label }}</router-link>
      <router-link v-if="auth.isHost" :to="{ name: 'admin' }"><Icon name="dashboard" size="22" />后台</router-link>
      <div class="m-sep"></div>
      <router-link to="/"><Icon name="home" size="22" />回到主页</router-link>
    </aside>
    <Transition name="m-live">
    <div v-if="liveOpen" class="m-live">
      <!-- Same bar as the workspace: menu, title, toggle pill, (offline dot), account; the toggle keeps its position -->
      <header class="m-bar">
        <button class="icon-btn" title="菜单" aria-label="菜单" @click="drawer = true"><Icon name="menu" size="24" /></button>
        <div class="m-title">{{ auth.event.name }}：实时大屏</div>
        <button class="m-toggle on" @click="liveOpen = false"><Icon name="dashboard" size="18" />工作区</button>
        <span v-if="!ui.online" class="m-offline" title="与服务器的实时连接已断开，正在重连"><span class="sync-dot"></span></span>
        <AccountMenu :before-logout="disconnectRealtime" />
      </header>
      <div class="m-live-body">
        <TeamPositions v-if="race.loaded" />
        <div v-else class="loading"><span class="spinner"></span></div>
      </div>
    </div>
    </Transition>
  </div>

  <!-- ========== Desktop / tablet: the original two columns ========== -->
  <template v-else>

  <div class="pager">
   <div class="pager-track" :style="trackStyle">
    <!-- Left page / desktop left column: live board (team positions) -->
    <section class="pane pane-live">
      <TeamPositions v-if="race.loaded" />
      <div v-else class="loading"><span class="spinner"></span></div>
    </section>
    <!-- Right page / desktop main area -->
    <section class="pane pane-main">
  <div class="container" :class="{ 'container-fixed': $route.meta.fillPage }">
    <header class="page-header">
      <div class="appbar-left">
        <router-link to="/" class="icon-btn" title="返回主页" aria-label="返回主页"><Icon name="arrow_back" size="22" /></router-link>
        <h1>{{ auth.event.name }}</h1>
      </div>
      <div class="user-bar">
        <span v-if="!ui.online" class="sync-status offline" title="与服务器的实时连接已断开，正在重连"><span class="sync-dot"></span>连接中断</span>
        <AccountMenu :before-logout="disconnectRealtime" />
      </div>
    </header>
    <nav class="nav">
      <router-link :to="{ name: 'today' }" active-class="" exact-active-class="router-link-active">我的</router-link>
      <router-link :to="{ name: 'announcements' }" class="nav-dot-wrap">公告<span v-if="race.unreadAnnouncements" class="nav-dot" :title="`${race.unreadAnnouncements} 条未读`"></span></router-link>
      <router-link :to="{ name: 'episodes' }" :class="{ 'router-link-active': $route.name === 'leg' }">赛段</router-link>
      <router-link :to="{ name: 'schedule' }">排班</router-link>
      <router-link :to="{ name: 'teams' }">队伍</router-link>
      <router-link :to="{ name: 'currency' }">经费</router-link>
      <router-link :to="{ name: 'progress' }">进度</router-link>
      <router-link v-if="auth.isHost" :to="{ name: 'admin' }">后台</router-link>
    </nav>
    <div class="page-body">
      <router-view v-if="race.loaded" />
      <div v-else class="loading"><span class="spinner"></span></div>
    </div>
  </div>
    </section>
   </div>
  </div>
  <!-- Page switch (tablet) -->
  <div class="pager-dots">
    <button :class="{ active: page === 0 }" @click="goPage(0)"><Icon name="tv" size="18" />大屏</button>
    <button :class="{ active: page === 1 }" @click="goPage(1)"><Icon name="dashboard" size="18" />页面</button>
  </div>
  </template>
</template>
