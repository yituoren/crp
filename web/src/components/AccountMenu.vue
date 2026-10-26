<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth } from '@/stores/auth';

// Account button in the top-right corner: click the name for a menu (account management / sign out); shared by the home page and events
const props = defineProps<{ beforeLogout?: () => void }>();
const auth = useAuth();
const router = useRouter();
const open = ref(false);
const root = ref<HTMLElement | null>(null);
function onDocClick(e: MouseEvent) { if (root.value && !root.value.contains(e.target as Node)) open.value = false; }
async function logout() {
  open.value = false;
  props.beforeLogout?.();
  await auth.logout();
  router.replace('/login');
}
onMounted(() => document.addEventListener('click', onDocClick));
onUnmounted(() => document.removeEventListener('click', onDocClick));
</script>

<template>
  <div ref="root" class="acct">
    <button class="acct-btn" :class="{ open }" @click="open = !open"><Icon name="account_circle" size="26" /><span class="acct-name">{{ auth.user?.displayName }}</span></button>
    <div v-if="open" class="sel-menu acct-menu">
      <router-link to="/account" class="sel-item" @click="open = false"><Icon name="person" size="20" />账号管理</router-link>
      <button class="sel-item sel-item-danger" @click="logout"><Icon name="logout" size="20" />退出登录</button>
    </div>
  </div>
</template>
