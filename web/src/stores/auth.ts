import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api, setEventHash, setServerDateHandler } from '@/api';
import type { EventInfo, User } from '@/types';
import { setMoneyMode } from '@/utils/money';

const EMPTY_EVENT: EventInfo = { id: 0, hash: '', name: '城市飞奔', teamSize: 2, currencyMode: 'yuan', rbGap: 2, ownerId: null, myRole: 'crew' };

export const useAuth = defineStore('auth', () => {
  const user = ref<User | null>(null);
  /** Whether the user hosts any event (account-management visibility before entering an event) */
  const hostAnywhere = ref(false);
  /** Info of the current event; empty outside an event */
  const event = ref<EventInfo>({ ...EMPTY_EVENT });
  const ready = ref(false);
  /** Server time minus local time (ms): record forms, running durations and waits use it, so it is measured at login and then kept corrected */
  const serverOffsetMs = ref(0);
  // the Date header only has whole seconds (on average half a second behind): correct only a real drift, e.g. after the device clock changed
  setServerDateHandler((serverMs) => {
    const offset = serverMs + 500 - Date.now();
    if (Math.abs(offset - serverOffsetMs.value) > 2000) serverOffsetMs.value = offset;
  });
  const serverNow = () => new Date(Date.now() + serverOffsetMs.value);
  /** The one clock of the app: server time (corrected local time), ticking every second. Everything time-based on screen reads it */
  const tick = ref(Date.now());
  setInterval(() => { tick.value = Date.now(); }, 1000);
  const nowMs = computed(() => tick.value + serverOffsetMs.value);
  const isAdmin = computed(() => user.value?.role === 'admin');
  /** Host rights in the current event; admin is global and includes host */
  const isHost = computed(() => isAdmin.value || event.value.myRole === 'host');

  async function fetchMe() {
    try {
      const d = await api('/auth/me');
      user.value = d.user;
      hostAnywhere.value = !!d.hostAnywhere;
      if (d.serverTime) serverOffsetMs.value = new Date(d.serverTime).getTime() - Date.now();
    } catch {
      user.value = null;
    } finally {
      ready.value = true;
    }
  }
  /** Enter an event: set the API prefix and load the event info */
  async function loadEvent(hash: string) {
    setEventHash(hash);
    const d = await api('/info');
    event.value = d.event;
    setMoneyMode(d.event?.currencyMode === 'coin' ? 'coin' : 'yuan');
  }
  function leaveEvent() {
    setEventHash('');
    event.value = { ...EMPTY_EVENT };
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
    leaveEvent();
  }
  return { user, hostAnywhere, event, ready, isHost, isAdmin, serverOffsetMs, serverNow, nowMs, fetchMe, loadEvent, leaveEvent, login, register, logout };
});
