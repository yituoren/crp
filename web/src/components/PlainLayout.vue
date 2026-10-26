<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth } from '@/stores/auth';
import { setUnauthorizedHandler } from '@/api';
import AccountMenu from './AccountMenu.vue';

const auth = useAuth();
const router = useRouter();
onMounted(() => {
  auth.leaveEvent();
  setUnauthorizedHandler(() => { auth.user = null; router.replace('/login'); });
});
/** Back: return to where the user came from (home or inside an event); home when there is no history */
function goBack() {
  if (window.history.state?.back) router.back(); else router.push('/');
}
</script>

<template>
  <router-view v-if="$route.name === 'home'" />
  <div v-else class="plain-wrap">
    <div class="container">
      <header class="page-header">
        <div class="appbar-left">
          <button class="icon-btn" title="返回" aria-label="返回" @click="goBack"><Icon name="arrow_back" size="22" /></button>
          <h1><router-link to="/" class="plain-title">城市飞奔 幕后指挥系统</router-link></h1>
        </div>
        <AccountMenu />
      </header>
      <div class="page-body"><router-view /></div>
    </div>
  </div>
</template>
