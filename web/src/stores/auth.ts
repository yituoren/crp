import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api, setEventHash } from '@/api';
import type { EventInfo, User } from '@/types';
import { setMoneyMode } from '@/utils/money';

const EMPTY_EVENT: EventInfo = { id: 0, hash: '', name: '城市飞奔', teamSize: 2, currencyMode: 'yuan', rbGap: 2, ownerId: null, myRole: 'crew' };

export const useAuth = defineStore('auth', () => {
  const user = ref<User | null>(null);
  /** 是否是任一比赛的主办（进比赛前能否看到账号管理） */
  const hostAnywhere = ref(false);
  /** 当前所在比赛的信息；不在比赛里时为空 */
  const event = ref<EventInfo>({ ...EMPTY_EVENT });
  const ready = ref(false);
  /** 服务器时间 - 本机时间（毫秒），用于给记录表单填默认时间 */
  const serverOffsetMs = ref(0);
  const serverNow = () => new Date(Date.now() + serverOffsetMs.value);
  const isAdmin = computed(() => user.value?.role === 'admin');
  /** 是否拥有主办权限：按当前比赛判断；管理员是全局角色，权限覆盖主办 */
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
  /** 进入某个比赛：设置接口前缀并加载比赛信息 */
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
  return { user, hostAnywhere, event, ready, isHost, isAdmin, serverOffsetMs, serverNow, fetchMe, loadEvent, leaveEvent, login, register, logout };
});
