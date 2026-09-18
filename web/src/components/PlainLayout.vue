<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth } from '@/stores/auth';
import { setUnauthorizedHandler } from '@/api';

const auth = useAuth();
const router = useRouter();
onMounted(() => {
  auth.leaveEvent();
  setUnauthorizedHandler(() => { auth.user = null; router.replace('/login'); });
});
async function logout() {
  await auth.logout();
  router.replace('/login');
}
</script>

<template>
  <div class="plain-wrap">
    <div class="container">
      <div class="page-header">
        <h1><router-link to="/" class="plain-title">城市飞奔 幕后指挥系统</router-link></h1>
        <div class="user-bar">
          <span class="badge" :class="auth.isAdmin ? 'badge-host' : 'badge-crew'">{{ auth.isAdmin ? '管理员' : '幕后' }}</span>
          <strong>{{ auth.user?.displayName }}</strong>
          <router-link v-if="$route.name !== 'home'" to="/" class="btn btn-outline btn-sm">主页</router-link>
          <router-link v-if="auth.isAdmin || auth.hostAnywhere" to="/account" class="btn btn-outline btn-sm">账号管理</router-link>
          <router-link to="/password" class="btn btn-outline btn-sm">改密</router-link>
          <button class="btn btn-danger btn-sm" @click="logout">退出</button>
        </div>
      </div>
      <div class="page-body"><router-view /></div>
    </div>
  </div>
</template>
