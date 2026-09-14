import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '@/api';
import type { EventInfo, User } from '@/types';

export const useAuth = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const event = ref<EventInfo>({ name: '城市飞奔', hosts: [], teamSize: 2 });
  const ready = ref(false);
  /** 服务器时间 - 本机时间（毫秒），用于给记录表单填默认时间 */
  const serverOffsetMs = ref(0);
  const serverNow = () => new Date(Date.now() + serverOffsetMs.value);
  const isHost = computed(() => user.value?.role === 'host' || user.value?.role === 'admin');
  const isAdmin = computed(() => user.value?.role === 'admin');

  async function fetchMe() {
    try {
      const d = await api('/auth/me');
      user.value = d.user;
      event.value = d.event;
      if (d.serverTime) serverOffsetMs.value = new Date(d.serverTime).getTime() - Date.now();
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
  return { user, event, ready, isHost, isAdmin, serverOffsetMs, serverNow, fetchMe, login, register, logout };
});
