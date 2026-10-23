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
      <header class="page-header">
        <div class="appbar-left">
          <router-link v-if="$route.name !== 'home'" to="/" class="icon-btn" title="回到主页" aria-label="回到主页"><Icon name="arrow_back" size="22" /></router-link>
          <h1><router-link to="/" class="plain-title">城市飞奔 幕后指挥系统</router-link></h1>
        </div>
        <div class="user-bar">
          <span class="badge" :class="auth.isAdmin ? 'badge-host' : 'badge-crew'">{{ auth.isAdmin ? '管理员' : '幕后' }}</span>
          <span class="user-name">{{ auth.user?.displayName }}</span>
          <router-link v-if="auth.isAdmin || auth.hostAnywhere" to="/account" class="btn btn-text btn-sm"><Icon name="group" size="18" />账号管理</router-link>
          <router-link to="/password" class="icon-btn" title="修改密码" aria-label="修改密码"><Icon name="key" /></router-link>
          <button class="icon-btn" title="退出登录" aria-label="退出登录" @click="logout"><Icon name="logout" /></button>
        </div>
      </header>
      <div class="page-body"><router-view /></div>
    </div>
  </div>
</template>
