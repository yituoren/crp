<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { connectRealtime, disconnectRealtime } from '@/realtime';
import { setUnauthorizedHandler } from '@/api';
import TeamPositions from './TeamPositions.vue';
import { ref, nextTick } from 'vue';

const auth = useAuth();
const race = useRace();
const ui = useUi();
const router = useRouter();

// 手机端：左右两屏（左：实时大屏，右：常规页面），像 iPhone 桌面一样整页切换
const pager = ref<HTMLElement | null>(null);
const page = ref(1); // 0 = 实时大屏，1 = 常规页面
function onPagerScroll() {
  const el = pager.value; if (!el) return;
  page.value = el.scrollLeft > el.clientWidth / 2 ? 1 : 0;
}
function goPage(i: number) {
  const el = pager.value; if (!el) return;
  el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
}

onMounted(async () => {
  setUnauthorizedHandler(() => { auth.user = null; router.replace('/login'); });
  // 默认停在右屏（常规页面）
  await nextTick();
  if (pager.value) pager.value.scrollLeft = pager.value.clientWidth;
  try { await race.loadAll(); } catch (e) { ui.error(e); }
  connectRealtime();
});
onUnmounted(() => disconnectRealtime());

async function logout() {
  disconnectRealtime();
  await auth.logout();
  router.replace('/login');
}
</script>

<template>
  <div ref="pager" class="pager" @scroll.passive="onPagerScroll">
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
  <!-- 手机端页码指示 -->
  <div class="pager-dots">
    <button :class="{ active: page === 0 }" aria-label="实时大屏" @click="goPage(0)"></button>
    <button :class="{ active: page === 1 }" aria-label="页面" @click="goPage(1)"></button>
  </div>
</template>
