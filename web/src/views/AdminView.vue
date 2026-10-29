<script setup lang="ts">
import { nextTick, onMounted, reactive, ref, watch } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { useRouter } from 'vue-router';
import Modal from '@/components/Modal.vue';
import { expectEventDeletion } from '@/realtime';
import { fmtDateTime } from '@/utils/time';

const auth = useAuth();
const race = useRace();
const ui = useUi();
const tab = ref<'settings' | 'members' | 'audit'>('settings');

// Event settings
const settings = reactive({ name: '', inviteCode: '', teamSize: 2, currencyMode: 'yuan', rbGap: 2 });
// Shop items (coin mode): edited as a whole and saved at once
const shop = reactive<{ items: { id: number; name: string; price: string }[] }>({ items: [] });
function fillShop() { shop.items = race.shopItems.map((i) => ({ id: i.id, name: i.name, price: String(i.price) })); }
function addItem() { shop.items.push({ id: 0, name: '', price: '' }); }
function removeItem(i: number) { shop.items.splice(i, 1); }
function fill() {
  const e = auth.event;
  Object.assign(settings, { name: e.name, inviteCode: e.inviteCode ?? '', teamSize: e.teamSize, currencyMode: e.currencyMode, rbGap: e.rbGap });
  fillShop();
}
/** Save everything: event settings first, then shop items (coin mode) */
async function saveAll() {
  try {
    await api('/info', { method: 'PUT', body: settings });
    await auth.loadEvent(auth.event.hash);
    if (settings.currencyMode === 'coin') {
      await api('/shop/items', { method: 'PUT', body: { items: shop.items.map((i) => ({ id: i.id || undefined, name: i.name.trim(), price: i.price })) } });
      await race.loadShopItems();
    }
    fill();
    await Promise.all([race.loadTeams(), race.loadEpisodes(), race.loadLedger(), race.loadUsers()]);
    ui.toast('设置已保存');
  } catch (e) { ui.error(e); }
}

// Members and hosts: the creator is a fixed host, others are set by hosts; admin is global and not managed here
async function setRole(u: any, role: 'host' | 'crew') {
  const what = role === 'host' ? `把「${u.username}」设为本比赛主办？主办可以编辑赛段、排班、经费、罚时和设置。` : `取消「${u.username}」的主办身份？`;
  if (!(await ui.confirm(role === 'host' ? '设为主办' : '取消主办', what, { danger: role === 'crew' }))) return;
  try { await api(`/members/${u.id}`, { method: 'PUT', body: { role } }); await race.loadUsers(); ui.toast('已更新'); } catch (e) { ui.error(e); }
}
const roleText = (r: string) => (r === 'admin' ? '管理员' : r === 'host' ? '主办' : '幕后');
// Join requests submitted with the invite code; approved users become crew
const requests = ref<{ id: number; user_id: number; username: string; note: string; created_at: string }[]>([]);
async function loadRequests() { try { requests.value = (await api('/join-requests')).requests; } catch { requests.value = []; } }
async function decide(r: { id: number; username: string }, action: 'approve' | 'reject') {
  if (action === 'reject' && !(await ui.confirm('拒绝申请', `拒绝「${r.username}」的加入申请？对方可以再次申请。`, { danger: true, okText: '拒绝' }))) return;
  try { await api(`/join-requests/${r.id}/${action}`, { method: 'POST' }); await Promise.all([loadRequests(), race.loadUsers()]); ui.toast(action === 'approve' ? '已通过' : '已拒绝'); } catch (e) { ui.error(e); }
}
watch(() => race.users, () => { if (tab.value === 'members') loadRequests(); });

// This event's audit log (hosts and admin)
const audit = ref<any[]>([]);
const auditTotal = ref(0);
async function loadAudit() { const d = await api('/audit?limit=200'); audit.value = d.logs; auditTotal.value = d.total; }
const short = (s: string | null) => (s ? (s.length > 120 ? s.slice(0, 120) + '…' : s) : '');

// Delete the whole event: the name must be typed again to enable the button
const router = useRouter();
const deleting = ref(false);
const deleteName = ref('');
const deleteBusy = ref(false);
const deleteInput = ref<HTMLInputElement | null>(null);
async function openDelete() { deleteName.value = ''; deleting.value = true; await nextTick(); deleteInput.value?.focus(); }
async function deleteEvent() {
  if (deleteName.value.trim() !== auth.event.name || deleteBusy.value) return;
  deleteBusy.value = true;
  expectEventDeletion(auth.event.hash);
  try {
    await api('', { method: 'DELETE', body: { name: deleteName.value.trim() } });
    deleting.value = false;
    ui.toast(`已删除比赛「${auth.event.name}」`);
    router.replace('/');
  } catch (e) { ui.error(e); } finally { deleteBusy.value = false; }
}

onMounted(() => { fill(); if (auth.isHost) loadAudit(); });
</script>

<template>
  <div class="nav">
    <a href="#" :class="{ 'router-link-active': tab === 'settings' }" @click.prevent="tab = 'settings'">赛事设置</a>
    <a href="#" :class="{ 'router-link-active': tab === 'members' }" @click.prevent="tab = 'members'; race.loadUsers(); loadRequests()">成员与主办</a>
    <a v-if="auth.isHost" href="#" :class="{ 'router-link-active': tab === 'audit' }" @click.prevent="tab = 'audit'; loadAudit()">操作日志</a>
  </div>

  <div v-if="tab === 'settings'" class="settings">
    <div class="settings-grid">
      <section class="card settings-section">
        <div class="settings-title">基本信息</div>
        <div class="form-group"><label>赛事名称</label><input v-model="settings.name" /></div>
        <div class="form-group"><label>邀请码</label><input v-model="settings.inviteCode" placeholder="如 bj20" /></div>
      </section>

      <section class="card settings-section">
        <div class="settings-title">队伍与规则</div>
        <div class="field-2">
          <div class="form-group"><label>每队人数</label><input v-model.number="settings.teamSize" type="number" min="1" max="20" step="1" inputmode="numeric" /></div>
          <div class="form-group"><label>路障次数差上限</label><input v-model.number="settings.rbGap" type="number" min="0" max="99" step="1" inputmode="numeric" /></div>
        </div>
      </section>

      <section class="card settings-section settings-wide">
        <div class="settings-title">经费与商店</div>
        <div class="settings-split">
          <div class="form-group"><label>经费类型</label><MSelect v-model="settings.currencyMode" outlined :options="[{ value: 'yuan', label: '经费（元）' }, { value: 'coin', label: '货币（币）' }]" /></div>
          <div v-if="settings.currencyMode === 'coin'" class="shop-editor">
            <div class="flex-between mb-2"><span class="settings-subtitle">商店商品</span><button class="btn btn-text btn-sm" @click="addItem"><Icon name="add" size="16" />添加商品</button></div>
            <div v-for="(it, i) in shop.items" :key="i" class="shop-row">
              <input v-model="it.name" placeholder="商品名称" />
              <input v-model="it.price" type="number" min="1" step="1" inputmode="numeric" placeholder="价格（币）" />
              <button class="icon-btn icon-btn-sm icon-btn-danger" title="删除" @click="removeItem(i)"><Icon name="delete" size="18" /></button>
            </div>
            <div v-if="!shop.items.length" class="text-sm text-gray">还没有商品，点「添加商品」开始。</div>
          </div>
          <div v-else class="text-sm text-gray shop-editor">选择「货币」后可以在这里配置商店商品。</div>
        </div>
      </section>
    </div>
    <div class="settings-actions">
      <button class="btn" @click="saveAll">保存设置</button>
    </div>
  </div>

  <div v-if="tab === 'members'" class="card">
    <div class="card-header"><span>成员与主办</span></div>
    <div class="scroll-table">
      <table class="table">
        <thead><tr><th>幕后ID</th><th class="c">本比赛身份</th><th class="c">操作</th></tr></thead>
        <tbody>
          <tr v-for="u in race.users" :key="u.id">
            <td><strong>{{ u.username }}</strong><span v-if="u.id === auth.user?.id" class="text-xs text-gray">（我）</span></td>
            <td class="c"><span class="badge" :class="u.role === 'crew' ? 'badge-crew' : 'badge-host'">{{ roleText(u.role) }}</span></td>
            <td class="c">
              <template v-if="u.role !== 'admin' && u.id !== auth.user?.id && u.id !== auth.event.ownerId">
                <button v-if="u.role === 'crew'" class="btn btn-text btn-sm" @click="setRole(u, 'host')">设为主办</button>
                <button v-else class="btn btn-text btn-sm" @click="setRole(u, 'crew')">取消主办</button>
              </template>
              <span v-else class="text-xs text-gray">{{ u.role === 'admin' ? '管理员' : u.id === auth.event.ownerId ? '创建者' : '' }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div v-if="tab === 'members'" class="card">
    <div class="card-header"><span>申请名单</span><span class="text-sm text-gray">{{ requests.length ? `${requests.length} 条待审核` : '' }}</span></div>
    <div v-if="!requests.length" class="empty-state">暂无申请</div>
    <div v-else class="scroll-table">
      <table v-mobile-table class="table">
        <thead><tr><th>幕后ID</th><th>说明</th><th>申请时间</th><th class="c">操作</th></tr></thead>
        <tbody>
          <tr v-for="r in requests" :key="r.id">
            <td><strong>{{ r.username }}</strong></td>
            <td class="wrap">{{ r.note || '-' }}</td>
            <td>{{ fmtDateTime(r.created_at) }}</td>
            <td class="c"><button class="btn btn-text btn-sm" @click="decide(r, 'approve')"><Icon name="check" size="16" />通过</button><button class="btn btn-text btn-text-danger btn-sm" @click="decide(r, 'reject')"><Icon name="close" size="16" />拒绝</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div v-if="tab === 'audit'" class="card danger-zone">
    <div class="danger-zone-text">
      <div class="settings-title">删除比赛</div>
      <div class="text-sm text-gray">永久删除本比赛的赛段、环节、附件、队伍、进度、经费、背包、公告和成员关系，无法恢复。账号不受影响。</div>
    </div>
    <button class="btn btn-danger" @click="openDelete"><Icon name="delete" size="18" />删除比赛</button>
  </div>

  <div v-if="tab === 'audit'" class="card">
    <div class="card-header"><span>本比赛操作日志（最近 200 条 / 共 {{ auditTotal }}）</span><button class="btn btn-text btn-sm" @click="loadAudit"><Icon name="refresh" size="16" />刷新</button></div>
    <div class="scroll-table">
      <table v-mobile-table class="table table-dense">
        <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>变更前</th><th>变更后</th></tr></thead>
        <tbody>
          <tr v-for="l in audit" :key="l.id">
            <td>{{ fmtDateTime(l.created_at) }}</td><td>{{ l.username }}</td><td>{{ l.action }}</td><td>{{ l.target_type }} {{ l.target_id }}</td>
            <td class="wrap text-xs mono">{{ short(l.before) }}</td><td class="wrap text-xs mono">{{ short(l.after) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <Modal v-if="deleting" title="删除比赛" small @close="deleting = false">
    <p class="text-sm mb-2">删除后，「{{ auth.event.name }}」的全部数据都无法恢复。请输入比赛名称确认。</p>
    <div class="form-group"><label>比赛名称</label><input ref="deleteInput" v-model="deleteName" :placeholder="auth.event.name" @keyup.enter="deleteEvent" /></div>
    <div class="modal-actions"><button class="btn btn-text" @click="deleting = false">取消</button><button class="btn btn-danger" :disabled="deleteName.trim() !== auth.event.name || deleteBusy" @click="deleteEvent">永久删除</button></div>
  </Modal>
</template>
