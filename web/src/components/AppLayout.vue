<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { connectRealtime, disconnectRealtime } from '@/realtime';
import { setUnauthorizedHandler } from '@/api';
import TeamPositions from './TeamPositions.vue';
import { ref, computed } from 'vue';

const auth = useAuth();
const race = useRace();
const ui = useUi();
const router = useRouter();

// 手机端：左右两屏（左：实时大屏，右：常规页面），像 iPhone 桌面一样整页切换。
// 不依赖浏览器的横向滚动，用 JS 识别手势/触控板横滑后整屏平移，手机和电脑缩窄窗口都可用。
const narrowQuery = window.matchMedia('(max-width: 1000px)');
const narrow = ref(narrowQuery.matches);
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
  window.addEventListener('touchstart', onTouchStart, { passive: true });
  window.addEventListener('touchmove', onTouchMove, { passive: true });
  window.addEventListener('touchend', onTouchEnd, { passive: true });
  window.addEventListener('wheel', onWheel, { passive: true });
  try { await race.loadAll(); } catch (e) { ui.error(e); }
  connectRealtime();
});
onUnmounted(() => {
  disconnectRealtime();
  narrowQuery.removeEventListener('change', onLayoutChange);
  window.removeEventListener('resize', onLayoutChange);
  window.removeEventListener('touchstart', onTouchStart);
  window.removeEventListener('touchmove', onTouchMove);
  window.removeEventListener('touchend', onTouchEnd);
  window.removeEventListener('wheel', onWheel);
});

async function logout() {
  disconnectRealtime();
  await auth.logout();
  router.replace('/login');
}
</script>

<template>
  <div class="pager">
   <div class="pager-track" :style="trackStyle">
    <!-- 左屏 / 电脑端左栏：实时大屏（队伍当前位置） -->
    <section class="pane pane-live">
      <TeamPositions v-if="race.loaded" />
      <div v-else class="empty-state">加载中…</div>
    </section>
    <!-- 右屏 / 电脑端主区域 -->
    <section class="pane pane-main">
  <div class="container" :class="{ 'container-fixed': $route.meta.fillPage }">
    <div class="page-header">
      <h1>{{ auth.event.name }}</h1>
      <div class="user-bar">
        <span class="sync-status" :class="ui.online ? 'online' : 'offline'">● {{ ui.online ? '实时同步中' : '连接中断' }}</span>
        <span class="badge" :class="auth.isHost ? 'badge-host' : 'badge-crew'">{{ auth.isAdmin ? '管理员' : auth.isHost ? '主办' : '幕后' }}</span>
        <strong>{{ auth.user?.displayName }}</strong>
        <router-link to="/password" class="btn btn-outline btn-sm">改密</router-link>
        <button class="btn btn-danger btn-sm" @click="logout">退出</button>
      </div>
    </div>
    <nav class="nav">
      <router-link to="/" active-class="" exact-active-class="router-link-active">我的</router-link>
      <router-link to="/announcements" class="nav-dot-wrap">公告<span v-if="race.unreadAnnouncements" class="nav-dot" :title="`${race.unreadAnnouncements} 条未读`"></span></router-link>
      <router-link to="/episodes" :class="{ 'router-link-active': $route.name === 'leg' }">赛段</router-link>
      <router-link to="/schedule">排班</router-link>
      <router-link to="/teams">队伍</router-link>
      <router-link to="/currency">经费</router-link>
      <router-link to="/progress">进度</router-link>
      <router-link v-if="auth.isHost" to="/admin">后台</router-link>
    </nav>
    <div class="page-body">
      <router-view v-if="race.loaded" />
      <div v-else class="empty-state">加载中…</div>
    </div>
  </div>
    </section>
   </div>
  </div>
  <!-- 手机端页码指示 -->
  <div class="pager-dots">
    <button :class="{ active: page === 0 }" @click="goPage(0)"><span class="dot"></span>大屏</button>
    <button :class="{ active: page === 1 }" @click="goPage(1)"><span class="dot"></span>页面</button>
  </div>
</template>
