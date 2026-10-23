<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useUi } from '@/stores/ui';
import { fmtDateTime } from '@/utils/time';

const auth = useAuth();
const ui = useUi();
// 管理员：账号管理 / 我的账号 / 全部日志 / 备份与重置；其他人只有修改密码
const tab = ref<'users' | 'me' | 'audit' | 'backup'>(auth.isAdmin ? 'users' : 'me');

// 我的账号：改 ID（管理员账号不能改）
const renaming = ref(false);
const newName = ref('');
function openRename() { newName.value = auth.user?.username ?? ''; renaming.value = true; }
async function saveRename() {
  const u = newName.value.trim();
  if (!u) { ui.toast('请填写新的ID', 'error'); return; }
  try { await api('/auth/profile', { method: 'PUT', body: { username: u } }); await auth.fetchMe(); renaming.value = false; ui.toast('ID 已修改'); } catch (e) { ui.error(e); }
}
async function renameUser(u: any) {
  const name = window.prompt(`为「${u.username}」设置新的ID：`, u.username);
  if (!name || name.trim() === u.username) return;
  try { await api(`/users/${u.id}`, { method: 'PUT', body: { username: name.trim() } }); await loadUsers(); ui.toast('ID 已修改'); } catch (e) { ui.error(e); }
}
/** 身份：管理员是全局角色；主办按是否在任一比赛担任主办判断 */
const myRole = computed(() => (auth.isAdmin ? '管理员' : auth.hostAnywhere ? '主办' : '幕后'));
const initial = computed(() => (auth.user?.displayName ?? '?').slice(0, 1).toUpperCase());

// 修改自己的密码（所有人）
const pw = reactive({ oldPassword: '', newPassword: '', newPassword2: '' });
const pwMsg = ref('');
async function changePassword() {
  pwMsg.value = '';
  if (pw.newPassword !== pw.newPassword2) { pwMsg.value = '两次新密码不一致'; return; }
  try {
    await api('/auth/change-password', { method: 'POST', body: { oldPassword: pw.oldPassword, newPassword: pw.newPassword } });
    Object.assign(pw, { oldPassword: '', newPassword: '', newPassword2: '' });
    ui.toast('密码修改成功');
  } catch (e) { pwMsg.value = e instanceof Error ? e.message : String(e); }
}

// 账号
const users = ref<any[]>([]);
async function loadUsers() { users.value = (await api('/users')).users; }
async function toggleDisabled(u: any) {
  try { await api(`/users/${u.id}`, { method: 'PUT', body: { disabled: !u.disabled } }); await loadUsers(); } catch (e) { ui.error(e); }
}
async function resetPassword(u: any) {
  const pw = window.prompt(`为「${u.username}」设置新密码（至少 4 位）：`);
  if (!pw) return;
  try { await api(`/users/${u.id}/reset-password`, { method: 'POST', body: { password: pw } }); ui.toast('密码已重置，请告知本人'); } catch (e) { ui.error(e); }
}
async function deleteUser(u: any) {
  if (!(await ui.confirm('删除账号', `删除「${u.username}」？其排班会一并删除，历史记录保留。`, { danger: true, okText: '删除' }))) return;
  try { await api(`/users/${u.id}`, { method: 'DELETE' }); await loadUsers(); } catch (e) { ui.error(e); }
}

// 全部操作日志（管理员）
const audit = ref<any[]>([]);
const auditTotal = ref(0);
async function loadAudit() { const d = await api('/system/audit?limit=200'); audit.value = d.logs; auditTotal.value = d.total; }
const short = (s: string | null) => (s ? (s.length > 120 ? s.slice(0, 120) + '…' : s) : '');

// 备份（管理员）
const importFile = ref<HTMLInputElement | null>(null);
const protoFile = ref<HTMLInputElement | null>(null);
const protoDate = ref(new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10));
const protoWipe = ref(false);
async function exportData() {
  try {
    const res = await fetch('/api/system/export', { credentials: 'same-origin' });
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
  if (!(await ui.confirm('恢复备份', '将用备份文件完全覆盖当前所有数据（包括账号和所有比赛）。此操作不可逆，确定？', { danger: true, okText: '覆盖恢复' }))) return;
  try { await api('/system/import', { method: 'POST', body: data, retries: 0 }); ui.toast('已恢复'); window.location.reload(); } catch (e) { ui.error(e); }
}
async function importProto() {
  const data = await readJson(protoFile.value);
  if (!data) return;
  if (!(await ui.confirm('导入原型数据', `导入旧版单页系统的备份到开发用比赛。开始/完成时间按 ${protoDate.value} 这一天解释。${protoWipe.value ? '\n会先清空开发用比赛的数据。' : ''}`, { danger: protoWipe.value }))) return;
  try {
    const d = await api('/system/import-prototype', { method: 'POST', body: { data, baseDate: protoDate.value, wipe: protoWipe.value }, retries: 0 });
    const r = d.report;
    ui.toast(`导入完成：账号 ${r.users}，队伍 ${r.teams}，赛段 ${r.episodes}，环节 ${r.legs}，记录 ${r.progress}，货币 ${r.ledger}`);
    if (r.warnings.length) alert('提示：\n' + r.warnings.join('\n'));
  } catch (e) { ui.error(e); }
}
async function resetAll(includeAccounts: boolean) {
  const msg = includeAccounts ? '清空所有比赛的赛段、队伍、记录、公告，并删除除管理员以外的全部账号。' : '清空所有比赛的赛段、环节、附件、队伍、记录、经费流水、公告，恢复开发用比赛的默认赛段与队伍。账号保留。';
  if (!(await ui.confirm('重置数据', msg + '\n请先导出备份！确定要继续吗？', { danger: true, okText: '确认重置' }))) return;
  try { await api('/system/reset', { method: 'POST', body: { includeAccounts } }); ui.toast('已重置'); window.location.reload(); } catch (e) { ui.error(e); }
}

onMounted(() => { if (auth.isAdmin) { loadUsers(); loadAudit(); } });
</script>

<template>
  <div v-if="auth.isAdmin" class="nav">
    <a href="#" :class="{ 'router-link-active': tab === 'users' }" @click.prevent="tab = 'users'">账号管理</a>
    <a href="#" :class="{ 'router-link-active': tab === 'me' }" @click.prevent="tab = 'me'">我的账号</a>
    <a href="#" :class="{ 'router-link-active': tab === 'audit' }" @click.prevent="tab = 'audit'; loadAudit()">全部日志</a>
    <a href="#" :class="{ 'router-link-active': tab === 'backup' }" @click.prevent="tab = 'backup'">备份与重置</a>
  </div>

  <!-- 我的账号：资料卡 + 基本信息 + 密码（Google 账号式） -->
  <div v-if="tab === 'me'" class="acc">
    <div class="acc-hero">
      <div class="acc-avatar">{{ initial }}</div>
      <div class="acc-hero-text">
        <div class="acc-name">{{ auth.user?.displayName }}</div>
        <div class="text-sm text-gray">{{ myRole }}<template v-if="auth.user?.createdAt"> · 注册于 {{ fmtDateTime(auth.user.createdAt) }}</template></div>
      </div>
    </div>
    <div class="acc-grid">
      <section class="card acc-card">
        <div class="acc-card-title">基本信息</div>
        <div class="acc-row">
          <div class="acc-row-label">幕后ID</div>
          <div v-if="!renaming" class="acc-row-value">{{ auth.user?.username }}</div>
          <div v-else class="acc-row-value acc-row-edit"><input v-model="newName" autofocus @keyup.enter="saveRename" @keyup.esc="renaming = false" /></div>
          <div class="acc-row-action">
            <template v-if="auth.isAdmin"><span class="text-xs text-gray">不可修改</span></template>
            <template v-else-if="!renaming"><button class="btn btn-text btn-sm" @click="openRename"><Icon name="edit" size="16" />修改</button></template>
            <template v-else><button class="btn btn-text btn-sm" @click="renaming = false">取消</button><button class="btn btn-sm" @click="saveRename">保存</button></template>
          </div>
        </div>
        <div class="acc-row"><div class="acc-row-label">身份</div><div class="acc-row-value">{{ myRole }}</div><div class="acc-row-action"></div></div>
        <div class="acc-row"><div class="acc-row-label">注册时间</div><div class="acc-row-value">{{ fmtDateTime(auth.user?.createdAt) }}</div><div class="acc-row-action"></div></div>
      </section>
      <section class="card acc-card">
        <div class="acc-card-title">密码</div>
        <form class="acc-pw" @submit.prevent="changePassword">
          <div class="form-group"><label>当前密码</label><input v-model="pw.oldPassword" type="password" autocomplete="current-password" /></div>
          <div class="form-group"><label>新密码</label><input v-model="pw.newPassword" type="password" autocomplete="new-password" /></div>
          <div class="form-group"><label>确认新密码</label><input v-model="pw.newPassword2" type="password" autocomplete="new-password" /></div>
          <div class="flex-between"><span class="form-error" style="margin: 0">{{ pwMsg }}</span><button class="btn" type="submit">修改密码</button></div>
        </form>
      </section>
    </div>
  </div>

  <div v-if="tab === 'users'" class="card">
    <div class="card-header">账号管理</div>
    <div class="scroll-table">
      <table class="table">
        <thead><tr><th>幕后ID</th><th class="c">角色</th><th class="c">状态</th><th>注册时间</th><th class="c">操作</th></tr></thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td><strong>{{ u.username }}</strong><span v-if="u.id === auth.user?.id" class="text-xs text-gray">（我）</span></td>
            <td class="c"><span class="badge" :class="u.role === 'admin' ? 'badge-host' : 'badge-crew'">{{ u.role === 'admin' ? '管理员' : '幕后' }}</span></td>
            <td class="c"><span :class="u.disabled ? 'status-eliminated' : 'status-alive'">{{ u.disabled ? '已停用' : '正常' }}</span></td>
            <td>{{ fmtDateTime(u.created_at) }}</td>
            <td class="flex c" style="gap: 6px">
              <button v-if="u.role !== 'admin'" class="btn btn-text btn-sm" @click="renameUser(u)"><Icon name="edit" size="16" />改ID</button>
              <button class="btn btn-text btn-sm" @click="resetPassword(u)"><Icon name="key" size="16" />重置密码</button>
              <button v-if="u.id !== auth.user?.id" class="btn btn-text btn-sm" @click="toggleDisabled(u)">{{ u.disabled ? '启用' : '停用' }}</button>
              <button v-if="u.id !== auth.user?.id" class="btn btn-text btn-text-danger btn-sm" @click="deleteUser(u)"><Icon name="delete" size="16" />删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div v-if="tab === 'audit'" class="card">
    <div class="card-header"><span>全部操作日志（最近 200 条 / 共 {{ auditTotal }}）</span><button class="btn btn-text btn-sm" @click="loadAudit"><Icon name="refresh" size="16" />刷新</button></div>
    <div class="scroll-table">
      <table class="table table-dense">
        <thead><tr><th>时间</th><th>比赛</th><th>操作人</th><th>动作</th><th>对象</th><th>变更前</th><th>变更后</th></tr></thead>
        <tbody>
          <tr v-for="l in audit" :key="l.id">
            <td>{{ fmtDateTime(l.created_at) }}</td><td>{{ l.event_id ?? '-' }}</td><td>{{ l.username }}</td><td>{{ l.action }}</td><td>{{ l.target_type }} {{ l.target_id }}</td>
            <td class="wrap text-xs mono">{{ short(l.before) }}</td><td class="wrap text-xs mono">{{ short(l.after) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <template v-if="tab === 'backup'">
    <div class="card">
      <div class="card-header">数据备份与恢复</div>
      <p class="text-gray text-sm">建议每个赛段结束后导出一次备份。备份包含全部数据（账号、所有比赛的赛程、记录、经费流水、操作日志），不含附件文件本身。</p>
      <div class="flex">
        <button class="btn" @click="exportData">导出全部数据备份</button>
        <span class="text-sm text-gray">恢复备份：</span><input ref="importFile" type="file" accept=".json" class="input-inline" style="width: 220px" />
        <button class="btn btn-warning" @click="importData">覆盖恢复</button>
      </div>
    </div>
    <div class="card">
      <div class="card-header">导入旧版单页系统（BJ20_CommandCenter.html）的备份到开发用比赛</div>
      <div class="flex">
        <input ref="protoFile" type="file" accept=".json" class="input-inline" style="width: 220px" />
        <span class="text-sm text-gray">记录日期：</span><input v-model="protoDate" type="date" class="input-inline" style="width: 160px" />
        <label class="text-sm"><input v-model="protoWipe" type="checkbox" />先清空开发用比赛的数据</label>
        <button class="btn" @click="importProto">导入</button>
      </div>
      <p class="info-text">旧版的开始/完成时间只有时分秒，需要指定这些记录属于哪一天。账号的旧密码会被加密后沿用。</p>
    </div>
    <div class="card" style="border-color: #fecaca">
      <div class="card-header text-danger">危险操作区</div>
      <div class="flex">
        <button class="btn btn-danger" @click="resetAll(false)">重置比赛数据（保留账号）</button>
        <button class="btn btn-danger" @click="resetAll(true)">重置全部（含账号）</button>
      </div>
      <p class="text-gray text-sm mt-2">重置不可逆，请先导出备份。</p>
    </div>
  </template>
</template>
