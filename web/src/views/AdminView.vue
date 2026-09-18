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
const tab = ref<'settings' | 'audit'>('settings');

// 赛事设置（比赛信息）
const settings = reactive({ name: '', inviteCode: '', hosts: '', teamSize: 2, currencyMode: 'yuan', rbGap: 2 });
function fill() {
  const e = auth.event;
  Object.assign(settings, { name: e.name, inviteCode: e.inviteCode ?? '', hosts: e.hosts.join(','), teamSize: e.teamSize, currencyMode: e.currencyMode, rbGap: e.rbGap });
}
async function saveSettings() {
  try {
    await api('/info', { method: 'PUT', body: settings });
    await auth.loadEvent(auth.event.hash);
    fill();
    await Promise.all([race.loadTeams(), race.loadEpisodes(), race.loadLedger(), race.loadUsers()]);
    ui.toast('设置已保存');
  } catch (e) { ui.error(e); }
}

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
    <a v-if="auth.isAdmin" href="#" :class="{ 'router-link-active': tab === 'audit' }" @click.prevent="tab = 'audit'; loadAudit()">操作日志</a>
  </div>

  <div v-if="tab === 'settings'" class="card" style="max-width: 520px">
    <div class="card-header">赛事设置</div>
    <div class="form-group"><label>赛事名称</label><input v-model="settings.name" /></div>
    <div class="form-group"><label>邀请码（所有人在主页输入后加入本比赛，管理员和创建者除外；留空则无法加入）</label><input v-model="settings.inviteCode" placeholder="如 bj20" /></div>
    <div class="form-group"><label>经费类型</label><select v-model="settings.currencyMode"><option value="yuan">经费（以元计，精确到小数点后两位）</option><option value="coin">货币（以币计，精确到个位）</option></select></div>
    <div class="form-group"><label>每队人数（大于等于 1 的整数；决定队伍编辑页有几个成员栏）</label><input v-model.number="settings.teamSize" type="number" min="1" max="20" step="1" inputmode="numeric" /></div>
    <div class="form-group"><label>路障限制（同队成员完成路障次数之差不能超过的整数，默认 2）</label><input v-model.number="settings.rbGap" type="number" min="0" max="99" step="1" inputmode="numeric" /></div>
    <div class="form-group"><label>主办名单（逗号分隔的幕后ID；名单内的账号加入本比赛后即为主办，加入仍需邀请码）</label><input v-model="settings.hosts" /></div>
    <button class="btn" @click="saveSettings">保存设置</button>
  </div>

  <div v-if="tab === 'audit'" class="card">
    <div class="card-header"><span>本比赛操作日志（最近 200 条 / 共 {{ auditTotal }}）</span><button class="btn btn-outline btn-sm" @click="loadAudit">刷新</button></div>
    <div class="scroll-table">
      <table class="table">
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
