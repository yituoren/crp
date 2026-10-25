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
/** 进入/切换比赛：加载比赛信息，再加载数据 */
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

// 手机端：左右两屏（左：实时大屏，右：常规页面），像 iPhone 桌面一样整页切换。
// 不依赖浏览器的横向滚动，用 JS 识别手势/触控板横滑后整屏平移，手机和电脑缩窄窗口都可用。
const narrowQuery = window.matchMedia('(max-width: 1000px)');
const narrow = ref(narrowQuery.matches);
// 手机端左右滑动 / 触控板横向滚动切屏暂时关闭，只用底部按钮切换；需要时改回 true
const SWIPE_ENABLED = false;
// 手机（≤760px）：独立骨架（顶栏 + 底部导航 + 抽屉 + 全屏大屏），不用两屏翻页
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
const page = ref(1); // 0 = 实时大屏，1 = 常规页面
const dragX = ref(0); // 手指跟随时的临时偏移
const dragging = ref(false);
// 位置交给 CSS 变量：窄屏时按 --page / --drag 平移，宽屏时媒体查询强制不平移
const trackStyle = computed(() => ({ '--page': String(page.value), '--drag': `${dragX.value}px`, transition: dragging.value ? 'none' : 'transform .25s ease' }));
const isNarrow = () => window.innerWidth <= 1000;
function goPage(i: number) { page.value = Math.max(0, Math.min(1, i)); dragX.value = 0; }
function onLayoutChange() {
  const n = isNarrow();
  if (n !== narrow.value) { narrow.value = n; page.value = 1; dragX.value = 0; }
}

let sx = 0, sy = 0, horizontal: boolean | null = null;
/** 手势起点落在可横向滚动的元素（进度矩阵、宽表格、赛段选择条等）里时，交给它自己滚动，不翻屏 */
function insideHScroll(target: EventTarget | null): boolean {
  const el = (target as HTMLElement | null)?.closest?.('.matrix-scroll, .scroll-table, .live-grid, .ep-selector, .nav, textarea');
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  return el.scrollWidth > el.clientWidth + 2;
}
function onTouchStart(e: TouchEvent) {
  if (!isNarrow()) return;
  if (insideHScroll(e.target)) { dragging.value = false; return; }
  const t = e.touches[0]; if (!t) return;
  sx = t.clientX; sy = t.clientY; horizontal = null; dragging.value = true; dragX.value = 0;
}
function onTouchMove(e: TouchEvent) {
  if (!isNarrow() || !dragging.value) return;
  const t = e.touches[0]; if (!t) return;
  const dx = t.clientX - sx, dy = t.clientY - sy;
  if (horizontal === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) horizontal = Math.abs(dx) > Math.abs(dy);
  if (horizontal) {
    // 已在边界时只跟随一小段，做出阻尼感
    const atEdge = (page.value === 0 && dx > 0) || (page.value === 1 && dx < 0);
    dragX.value = atEdge ? dx / 4 : dx;
  }
}
function onTouchEnd() {
  if (!isNarrow() || !dragging.value) return;
  dragging.value = false;
  const dx = dragX.value;
  if (horizontal && Math.abs(dx) > 60) goPage(page.value + (dx < 0 ? 1 : -1));
  else dragX.value = 0;
  horizontal = null;
}
let wheelAcc = 0, wheelLock = 0;
function onWheel(e: WheelEvent) {
  if (!isNarrow()) return;
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // 纵向滚动交给页面
  if (insideHScroll(e.target)) return;
  const now = Date.now();
  if (now < wheelLock) return;
  wheelAcc += e.deltaX;
  if (Math.abs(wheelAcc) > 80) { goPage(page.value + (wheelAcc > 0 ? 1 : -1)); wheelAcc = 0; wheelLock = now + 600; }
}

onMounted(async () => {
  setUnauthorizedHandler(() => { auth.user = null; router.replace('/login'); });
  narrowQuery.addEventListener('change', onLayoutChange);
  window.addEventListener('resize', onLayoutChange);
  if (SWIPE_ENABLED) {
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('wheel', onWheel, { passive: true });
  }
  await enterEvent();
  connectRealtime();
});
watch(hash, (h, prev) => { if (h && prev && h !== prev) enterEvent(); });
onUnmounted(() => {
  disconnectRealtime();
  narrowQuery.removeEventListener('change', onLayoutChange);
  window.removeEventListener('resize', onLayoutChange);
  if (SWIPE_ENABLED) {
    window.removeEventListener('touchstart', onTouchStart);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
    window.removeEventListener('wheel', onWheel);
  }
});

</script>

<template>
  <!-- ========== 手机：顶栏 + 内容 + 底部导航 + 抽屉 ========== -->
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
      <!-- 顶栏与工作区同构：菜单、标题、切换胶囊、（断线标记）、账号，切换按钮位置不变 -->
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

  <!-- ========== 电脑 / 平板：原有两栏 ========== -->
  <template v-else>

  <div class="pager">
   <div class="pager-track" :style="trackStyle">
    <!-- 左屏 / 电脑端左栏：实时大屏（队伍当前位置） -->
    <section class="pane pane-live">
      <TeamPositions v-if="race.loaded" />
      <div v-else class="loading"><span class="spinner"></span></div>
    </section>
    <!-- 右屏 / 电脑端主区域 -->
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
  <!-- 手机端页码指示 -->
  <div class="pager-dots">
    <button :class="{ active: page === 0 }" @click="goPage(0)"><Icon name="tv" size="18" />大屏</button>
    <button :class="{ active: page === 1 }" @click="goPage(1)"><Icon name="dashboard" size="18" />页面</button>
  </div>
  </template>
</template>
