<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtDateTime } from '@/utils/time';

const auth = useAuth();
const race = useRace();
const ui = useUi();
const tab = ref<'settings' | 'members' | 'audit'>('settings');

// 赛事设置（比赛信息）
const settings = reactive({ name: '', inviteCode: '', teamSize: 2, currencyMode: 'yuan', rbGap: 2 });
// 商店商品（货币模式）：整表编辑后一次保存
const shop = reactive<{ items: { id: number; name: string; price: string }[] }>({ items: [] });
function fillShop() { shop.items = race.shopItems.map((i) => ({ id: i.id, name: i.name, price: String(i.price) })); }
function addItem() { shop.items.push({ id: 0, name: '', price: '' }); }
function removeItem(i: number) { shop.items.splice(i, 1); }
function fill() {
  const e = auth.event;
  Object.assign(settings, { name: e.name, inviteCode: e.inviteCode ?? '', teamSize: e.teamSize, currencyMode: e.currencyMode, rbGap: e.rbGap });
  fillShop();
}
/** 保存全部：先保存赛事设置，再保存商品（货币模式） */
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

// 成员与主办：创建者固定为主办，其他成员由主办设置；管理员是全局角色，不在这里设置
async function setRole(u: any, role: 'host' | 'crew') {
  const what = role === 'host' ? `把「${u.username}」设为本比赛主办？主办可以编辑赛段、排班、经费、罚时和设置。` : `取消「${u.username}」的主办身份？`;
  if (!(await ui.confirm(role === 'host' ? '设为主办' : '取消主办', what, { danger: role === 'crew' }))) return;
  try { await api(`/members/${u.id}`, { method: 'PUT', body: { role } }); await race.loadUsers(); ui.toast('已更新'); } catch (e) { ui.error(e); }
}
const roleText = (r: string) => (r === 'admin' ? '管理员' : r === 'host' ? '主办' : '幕后');

// 本比赛的操作日志（管理员）
const audit = ref<any[]>([]);
const auditTotal = ref(0);
async function loadAudit() { const d = await api('/audit?limit=200'); audit.value = d.logs; auditTotal.value = d.total; }
const short = (s: string | null) => (s ? (s.length > 120 ? s.slice(0, 120) + '…' : s) : '');

onMounted(() => { fill(); if (auth.isAdmin) loadAudit(); });
</script>

<template>
  <div class="nav">
    <a href="#" :class="{ 'router-link-active': tab === 'settings' }" @click.prevent="tab = 'settings'">赛事设置</a>
    <a href="#" :class="{ 'router-link-active': tab === 'members' }" @click.prevent="tab = 'members'; race.loadUsers()">成员与主办</a>
    <a v-if="auth.isAdmin" href="#" :class="{ 'router-link-active': tab === 'audit' }" @click.prevent="tab = 'audit'; loadAudit()">操作日志</a>
  </div>

  <div v-if="tab === 'settings'" class="settings">
    <div class="settings-grid">
      <section class="card settings-section">
        <div class="settings-title">基本信息</div>
        <div class="settings-desc">赛事名称显示在页面顶部；邀请码发给所有幕后，在主页输入即可加入。</div>
        <div class="form-group"><label>赛事名称</label><input v-model="settings.name" /></div>
        <div class="form-group"><label>邀请码</label><input v-model="settings.inviteCode" placeholder="如 bj20" /><div class="info-text">管理员和创建者无需邀请码；留空则无法加入</div></div>
      </section>

      <section class="card settings-section">
        <div class="settings-title">队伍与规则</div>
        <div class="settings-desc">影响队伍编辑页的成员栏数量，以及路障人选的限制。</div>
        <div class="field-2">
          <div class="form-group"><label>每队人数</label><input v-model.number="settings.teamSize" type="number" min="1" max="20" step="1" inputmode="numeric" /><div class="info-text">1 到 20 的整数</div></div>
          <div class="form-group"><label>路障次数差上限</label><input v-model.number="settings.rbGap" type="number" min="0" max="99" step="1" inputmode="numeric" /><div class="info-text">同队成员完成路障次数之差，默认 2</div></div>
        </div>
      </section>

      <section class="card settings-section settings-wide">
        <div class="settings-title">经费与商店</div>
        <div class="settings-desc">经费以元计、精确到分；货币以币计、只取整数。货币模式可以配置商店，队伍在开放商店的环节用货币购买物品。</div>
        <div class="settings-split">
          <div class="form-group"><label>经费类型</label><MSelect v-model="settings.currencyMode" outlined :options="[{ value: 'yuan', label: '经费（元）' }, { value: 'coin', label: '货币（币）' }]" /><div class="info-text">切换类型只改变显示与校验方式，不换算已有金额</div></div>
          <div v-if="settings.currencyMode === 'coin'" class="shop-editor">
            <div class="flex-between mb-2"><span class="settings-subtitle">商店商品</span><button class="btn btn-text btn-sm" @click="addItem"><Icon name="add" size="16" />添加商品</button></div>
            <div v-for="(it, i) in shop.items" :key="i" class="shop-row">
              <input v-model="it.name" placeholder="商品名称" />
              <input v-model="it.price" type="number" min="1" step="1" inputmode="numeric" placeholder="价格（币）" />
              <button class="icon-btn icon-btn-sm" title="删除" @click="removeItem(i)"><Icon name="delete" size="18" /></button>
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
    <div class="card-header"><span>成员与主办</span><span class="text-xs text-gray">凭邀请码加入的人默认是幕后；创建者固定为主办；管理员是全局角色，不在此设置</span></div>
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

  <div v-if="tab === 'audit'" class="card">
    <div class="card-header"><span>本比赛操作日志（最近 200 条 / 共 {{ auditTotal }}）</span><button class="btn btn-text btn-sm" @click="loadAudit"><Icon name="refresh" size="16" />刷新</button></div>
    <div class="scroll-table">
      <table class="table table-dense">
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
</template>
