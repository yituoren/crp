<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { connectRealtime, disconnectRealtime } from '@/realtime';
import { setUnauthorizedHandler } from '@/api';
import { moneyLabel } from '@/utils/money';
import ProgressMatrix from './ProgressMatrix.vue';
import { ref } from 'vue';

// 手机端：进度矩阵做成从右侧拉出的抽屉
const matrixOpen = ref(false);
let touchStartX = 0, touchStartY = 0, tracking = false;
function onTouchStart(e: TouchEvent) {
  const t = e.touches[0]; if (!t) return;
  touchStartX = t.clientX; touchStartY = t.clientY;
  tracking = matrixOpen.value || t.clientX > window.innerWidth - 28; // 从右边缘起手才算拉出
}
function onTouchEnd(e: TouchEvent) {
  if (!tracking) return;
  tracking = false;
  const t = e.changedTouches[0]; if (!t) return;
  const dx = t.clientX - touchStartX, dy = Math.abs(t.clientY - touchStartY);
  if (dy > 80) return;
  if (!matrixOpen.value && dx < -50) matrixOpen.value = true;
  else if (matrixOpen.value && dx > 60) matrixOpen.value = false;
}

const auth = useAuth();
const race = useRace();
const ui = useUi();
const router = useRouter();

onMounted(async () => {
  setUnauthorizedHandler(() => { auth.user = null; router.replace('/login'); });
  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchend', onTouchEnd, { passive: true });
  try { await race.loadAll(); } catch (e) { ui.error(e); }
  connectRealtime();
});
onUnmounted(() => {
  disconnectRealtime();
  document.removeEventListener('touchstart', onTouchStart);
  document.removeEventListener('touchend', onTouchEnd);
});

async function logout() {
  disconnectRealtime();
  await auth.logout();
  router.replace('/login');
}
</script>

<template>
  <div class="app-shell">
    <!-- 进度矩阵：电脑端固定在左侧，手机端为右侧抽屉 -->
    <div class="matrix-backdrop" :class="{ open: matrixOpen }" @click="matrixOpen = false"></div>
    <aside class="matrix-panel" :class="{ open: matrixOpen }">
      <div class="matrix-panel-top">
        <span class="text-sm text-gray">实时进度（所有人可见）</span>
        <button class="btn btn-outline btn-sm matrix-close" @click="matrixOpen = false">收起</button>
      </div>
      <ProgressMatrix v-if="race.loaded" />
    </aside>
    <button class="matrix-handle" :class="{ open: matrixOpen }" @click="matrixOpen = !matrixOpen">进度</button>

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
      <router-link to="/" active-class="" exact-active-class="router-link-active">我的今日</router-link>
      <router-link to="/announcements" class="nav-dot-wrap">公告<span v-if="race.unreadAnnouncements" class="nav-dot" :title="`${race.unreadAnnouncements} 条未读`"></span></router-link>
      <router-link to="/episodes" :class="{ 'router-link-active': $route.name === 'leg' }">赛段信息</router-link>
      <router-link to="/schedule">排班</router-link>
      <router-link to="/teams">队伍</router-link>
      <router-link to="/currency">{{ moneyLabel() }}与罚时</router-link>
      <router-link v-if="auth.isHost" to="/dashboard">实时大屏</router-link>
      <router-link v-if="auth.isHost" to="/pitstop">终点结算</router-link>
      <router-link v-if="auth.isHost" to="/admin">主办后台</router-link>
    </nav>
    <div class="page-body">
      <router-view v-if="race.loaded" />
      <div v-else class="empty-state">加载中…</div>
    </div>
  </div>
  </div>
</template>
