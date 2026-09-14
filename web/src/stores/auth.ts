import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '@/api';
import type { EventInfo, User } from '@/types';

export const useAuth = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const event = ref<EventInfo>({ name: '城市飞奔', initialCurrency: 1000, hosts: [] });
  const ready = ref(false);
  const isHost = computed(() => user.value?.role === 'host' || user.value?.role === 'admin');
  const isAdmin = computed(() => user.value?.role === 'admin');

  async function fetchMe() {
    try {
      const d = await api('/auth/me');
      user.value = d.user;
      event.value = d.event;
    } catch {
      user.value = null;
    } finally {
      ready.value = true;
    }
  }
  async function login(username: string, password: string) {
    const d = await api('/auth/login', { method: 'POST', body: { username, password } });
    user.value = d.user;
    await fetchMe();
  }
  async function register(username: string, password: string) {
    const d = await api('/auth/register', { method: 'POST', body: { username, password } });
    user.value = d.user;
    await fetchMe();
  }
  async function logout() {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    user.value = null;
  }
  return { user, event, ready, isHost, isAdmin, fetchMe, login, register, logout };
});
