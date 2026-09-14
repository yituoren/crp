<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { connectRealtime, disconnectRealtime } from '@/realtime';
import { setUnauthorizedHandler } from '@/api';

const auth = useAuth();
const race = useRace();
const ui = useUi();
const router = useRouter();

onMounted(async () => {
  setUnauthorizedHandler(() => { auth.user = null; router.replace('/login'); });
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
  <div class="container">
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
      <router-link to="/episodes" :class="{ 'router-link-active': $route.name === 'leg' }">赛段信息</router-link>
      <router-link to="/schedule">排班</router-link>
      <router-link to="/teams">队伍</router-link>
      <router-link to="/currency">货币与罚时</router-link>
      <router-link v-if="auth.isHost" to="/dashboard">实时大屏</router-link>
      <router-link v-if="auth.isHost" to="/pitstop">终点结算</router-link>
      <router-link v-if="auth.isHost" to="/admin">主办后台</router-link>
    </nav>
    <router-view v-if="race.loaded" />
    <div v-else class="empty-state">加载中…</div>
  </div>
</template>
