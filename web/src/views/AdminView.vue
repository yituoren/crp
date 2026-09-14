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
const tab = ref<'access' | 'users' | 'settings' | 'audit' | 'backup'>('access');

// 准入名单
const accessList = ref<any[]>([]);
const hosts = ref<string[]>([]);
const newIds = ref('');
async function loadAccess() { const d = await api('/admin/access-list'); accessList.value = d.accessList; hosts.value = d.hosts; }
async function addAccess() {
  if (!newIds.value.trim()) return;
  try { const d = await api('/admin/access-list', { method: 'POST', body: { usernames: newIds.value } }); newIds.value = ''; await loadAccess(); ui.toast(`已添加：${d.added.join('、')}`); } catch (e) { ui.error(e); }
}
async function removeAccess(username: string) {
  if (!(await ui.confirm('移除准入', `移除「${username}」的准入资格？已注册的账号不受影响，可在账号管理里停用。`, { danger: true }))) return;
  try { await api(`/admin/access-list/${encodeURIComponent(username)}`, { method: 'DELETE' }); await loadAccess(); } catch (e) { ui.error(e); }
}

// 账号
const users = ref<any[]>([]);
async function loadUsers() { users.value = (await api('/admin/users')).users; }
async function setRole(u: any, role: string) {
  try { await api(`/admin/users/${u.id}`, { method: 'PUT', body: { role } }); await Promise.all([loadUsers(), race.loadUsers()]); ui.toast('已更新'); } catch (e) { ui.error(e); await loadUsers(); }
}
async function toggleDisabled(u: any) {
  try { await api(`/admin/users/${u.id}`, { method: 'PUT', body: { disabled: !u.disabled } }); await Promise.all([loadUsers(), race.loadUsers()]); } catch (e) { ui.error(e); }
}
async function resetPassword(u: any) {
  const pw = window.prompt(`为「${u.username}」设置新密码（至少 4 位）：`);
  if (!pw) return;
  try { await api(`/admin/users/${u.id}/reset-password`, { method: 'POST', body: { password: pw } }); ui.toast('密码已重置，请告知本人'); } catch (e) { ui.error(e); }
}
async function deleteUser(u: any) {
  if (!(await ui.confirm('删除账号', `删除「${u.username}」？其排班会一并删除，历史记录保留。`, { danger: true, okText: '删除' }))) return;
  try { await api(`/admin/users/${u.id}`, { method: 'DELETE' }); await Promise.all([loadUsers(), race.loadUsers()]); } catch (e) { ui.error(e); }
}

// 设置
const settings = reactive({ eventName: '', initialCurrency: 1000, hosts: '' });
async function loadSettings() { Object.assign(settings, await api('/admin/settings')); }
async function saveSettings() {
  try { await api('/admin/settings', { method: 'PUT', body: settings }); await auth.fetchMe(); await loadAccess(); ui.toast('设置已保存'); } catch (e) { ui.error(e); }
}

// 审计
const audit = ref<any[]>([]);
const auditTotal = ref(0);
async function loadAudit() { const d = await api('/admin/audit?limit=200'); audit.value = d.logs; auditTotal.value = d.total; }
const short = (s: string | null) => (s ? (s.length > 120 ? s.slice(0, 120) + '…' : s) : '');

// 备份
const importFile = ref<HTMLInputElement | null>(null);
const protoFile = ref<HTMLInputElement | null>(null);
const protoDate = ref(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10));
const protoWipe = ref(false);
async function exportData() {
  try {
    const res = await fetch('/api/admin/export', { credentials: 'same-origin' });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `crp_backup_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    ui.toast('备份已下载');
  } catch (e) { ui.error(e); }
}
async function readJson(input: HTMLInputElement | null) {
  const f = input?.files?.[0];
  if (!f) return null;
  try { return JSON.parse(await f.text()); } catch { ui.toast('文件不是合法 JSON', 'error'); return null; }
}
async function importData() {
  const data = await readJson(importFile.value);
  if (!data) return;
  if (!(await ui.confirm('恢复备份', '将用备份文件完全覆盖当前所有数据（包括账号）。此操作不可逆，确定？', { danger: true, okText: '覆盖恢复' }))) return;
  try { await api('/admin/import', { method: 'POST', body: data, retries: 0 }); ui.toast('已恢复'); window.location.reload(); } catch (e) { ui.error(e); }
}
async function importProto() {
  const data = await readJson(protoFile.value);
  if (!data) return;
  if (!(await ui.confirm('导入原型数据', `导入旧版单页系统的备份。到达/完成时间按 ${protoDate.value} 这一天解释。${protoWipe.value ? '\n⚠️ 会先清空当前比赛数据。' : ''}`, { danger: protoWipe.value }))) return;
  try {
    const d = await api('/admin/import-prototype', { method: 'POST', body: { data, baseDate: protoDate.value, wipe: protoWipe.value }, retries: 0 });
    const r = d.report;
    ui.toast(`导入完成：账号 ${r.users}，队伍 ${r.teams}，赛段 ${r.episodes}，环节 ${r.legs}，记录 ${r.progress}，货币 ${r.ledger}`);
    if (r.warnings.length) alert('提示：\n' + r.warnings.join('\n'));
    await race.loadAll();
  } catch (e) { ui.error(e); }
}
async function resetAll(includeAccounts: boolean) {
  const msg = includeAccounts ? '清空所有比赛数据、公告，并删除除管理员以外的全部账号与准入名单。' : '清空赛段、环节、附件、队伍、记录、货币日志、公告，恢复默认赛段与队伍。账号保留。';
  if (!(await ui.confirm('⚠️ 重置数据', msg + '\n请先导出备份！确定要继续吗？', { danger: true, okText: '确认重置' }))) return;
  try { await api('/admin/reset', { method: 'POST', body: { includeAccounts } }); ui.toast('已重置'); window.location.reload(); } catch (e) { ui.error(e); }
}

onMounted(() => { loadAccess(); loadUsers(); loadSettings(); if (auth.isAdmin) loadAudit(); });
</script>

<template>
  <div class="nav">
    <a href="#" :class="{ 'router-link-active': tab === 'access' }" @click.prevent="tab = 'access'">🔐 准入名单</a>
    <a href="#" :class="{ 'router-link-active': tab === 'users' }" @click.prevent="tab = 'users'">👤 账号管理</a>
    <a href="#" :class="{ 'router-link-active': tab === 'settings' }" @click.prevent="tab = 'settings'">🎛️ 赛事设置</a>
    <a v-if="auth.isAdmin" href="#" :class="{ 'router-link-active': tab === 'audit' }" @click.prevent="tab = 'audit'; loadAudit()">🧾 操作日志</a>
    <a v-if="auth.isAdmin" href="#" :class="{ 'router-link-active': tab === 'backup' }" @click.prevent="tab = 'backup'">💾 备份与重置</a>
  </div>

  <div v-if="tab === 'access'" class="card">
    <div class="card-header">🔐 准入名单（在名单内的ID才能注册）</div>
    <div class="flex mb-2">
      <input v-model="newIds" placeholder="添加准入ID，多个用逗号分隔：小明, 小红" style="flex: 1; min-width: 200px" @keyup.enter="addAccess" />
      <button class="btn" @click="addAccess">添加</button>
    </div>
    <div class="grid grid-4">
      <div v-for="a in accessList" :key="a.username" class="flex-between" style="padding: 8px 12px; background: var(--gray-50); border: 1px solid var(--gray-200); border-radius: 8px">
        <span><strong>{{ a.username }}</strong> <span v-if="a.user_id" class="badge" :class="a.role === 'host' || a.role === 'admin' ? 'badge-host' : 'badge-crew'">{{ a.role === 'admin' ? '管理员' : a.role === 'host' ? '主办' : '已注册' }}</span><span v-else class="text-xs text-gray">未注册</span></span>
        <span v-if="hosts.includes(a.username) || a.role === 'admin'" class="text-xs text-gray">{{ a.role === 'admin' ? '管理员' : '主办' }}</span>
        <button v-else class="btn btn-outline btn-sm" @click="removeAccess(a.username)">移除</button>
      </div>
    </div>
  </div>

  <div v-if="tab === 'users'" class="card">
    <div class="card-header">👤 账号管理</div>
    <div class="scroll-table">
      <table class="table">
        <thead><tr><th>幕后ID</th><th>角色</th><th>状态</th><th>注册时间</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td><strong>{{ u.username }}</strong><span v-if="u.id === auth.user?.id" class="text-xs text-gray">（我）</span></td>
            <td>
              <span v-if="u.role === 'admin'" class="badge badge-host">管理员</span>
              <select v-else class="input-sm input-inline" :value="u.role" :disabled="u.id === auth.user?.id" @change="setRole(u, ($event.target as HTMLSelectElement).value)">
                <option value="crew">幕后</option><option value="host">主办</option>
              </select>
            </td>
            <td><span :class="u.disabled ? 'status-eliminated' : 'status-alive'">{{ u.disabled ? '已停用' : '正常' }}</span></td>
            <td>{{ fmtDateTime(u.created_at) }}</td>
            <td class="flex" style="gap: 6px">
              <template v-if="u.role !== 'admin' || auth.isAdmin">
                <button class="btn btn-outline btn-sm" @click="resetPassword(u)">重置密码</button>
                <button v-if="u.id !== auth.user?.id" class="btn btn-outline btn-sm" @click="toggleDisabled(u)">{{ u.disabled ? '启用' : '停用' }}</button>
                <button v-if="u.id !== auth.user?.id" class="btn btn-danger btn-sm" @click="deleteUser(u)">删除</button>
              </template>
              <span v-else class="text-xs text-gray">仅管理员可操作</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="info-text">密码经过加密存储，无法查看；忘记密码只能重置。管理员账号只能在服务器上用 create-admin 命令创建或撤销，页面上不能把账号设为管理员；操作日志与备份/重置仅管理员可见。</p>
  </div>

  <div v-if="tab === 'settings'" class="card" style="max-width: 520px">
    <div class="card-header">🎛️ 赛事设置</div>
    <div class="form-group"><label>赛事名称</label><input v-model="settings.eventName" /></div>
    <div class="form-group"><label>队伍初始货币（新增/重置队伍时使用）</label><input v-model.number="settings.initialCurrency" type="number" /></div>
    <div class="form-group"><label>主办名单（逗号分隔；名单内的ID注册即为主办，且自动加入准入名单）</label><input v-model="settings.hosts" /></div>
    <button class="btn" @click="saveSettings">保存设置</button>
  </div>

  <div v-if="tab === 'audit'" class="card">
    <div class="card-header"><span>🧾 操作日志（最近 200 条 / 共 {{ auditTotal }}）</span><button class="btn btn-outline btn-sm" @click="loadAudit">刷新</button></div>
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

  <template v-if="tab === 'backup'">
    <div class="card">
      <div class="card-header">💾 数据备份与恢复</div>
      <p class="text-gray text-sm">建议每个赛段结束后导出一次备份。备份包含全部数据（账号、赛程、记录、货币日志、操作日志），不含附件文件本身。</p>
      <div class="flex">
        <button class="btn" @click="exportData">📥 导出全部数据备份</button>
        <span class="text-sm text-gray">恢复备份：</span><input ref="importFile" type="file" accept=".json" class="input-inline" style="width: 220px" />
        <button class="btn btn-warning" @click="importData">覆盖恢复</button>
      </div>
    </div>
    <div class="card">
      <div class="card-header">📦 导入旧版单页系统（BJ20_CommandCenter.html）的备份</div>
      <div class="flex">
        <input ref="protoFile" type="file" accept=".json" class="input-inline" style="width: 220px" />
        <span class="text-sm text-gray">记录日期：</span><input v-model="protoDate" type="date" class="input-inline" style="width: 160px" />
        <label class="text-sm"><input v-model="protoWipe" type="checkbox" />先清空当前比赛数据</label>
        <button class="btn" @click="importProto">导入</button>
      </div>
      <p class="info-text">旧版的到达/完成时间只有时分秒，需要指定这些记录属于哪一天。账号的旧密码会被加密后沿用。</p>
    </div>
    <div class="card" style="border-color: #fecaca">
      <div class="card-header text-danger">🔥 危险操作区</div>
      <div class="flex">
        <button class="btn btn-danger" @click="resetAll(false)">🗑️ 重置比赛数据（保留账号）</button>
        <button class="btn btn-danger" @click="resetAll(true)">💣 重置全部（含账号）</button>
      </div>
      <p class="text-gray text-sm mt-2">重置不可逆，请先导出备份。</p>
    </div>
  </template>
</template>
