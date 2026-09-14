<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import type { Team } from '@/types';
import Modal from '@/components/Modal.vue';
import TeamStatus from '@/components/TeamStatus.vue';
import { fmtMoney, moneyUnit } from '@/utils/money';

const auth = useAuth();
const race = useRace();
const ui = useUi();
const editing = ref<Team | 'new' | null>(null);
const form = reactive({ name: '', members: [] as string[] });
const size = computed(() => Math.max(1, auth.event.teamSize || 1));

function open(t: Team | 'new') {
  editing.value = t;
  const members = t === 'new' ? [] : [...t.members];
  while (members.length < size.value) members.push('');
  Object.assign(form, { name: t === 'new' ? String(race.teams.length + 1).padStart(2, '0') : t.name, members });
}
async function save() {
  try {
    if (editing.value === 'new') await api('/teams', { method: 'POST', body: form });
    else await api(`/teams/${(editing.value as Team).id}`, { method: 'PUT', body: form });
    await race.loadTeams();
    editing.value = null;
    ui.toast('已保存');
  } catch (e) { ui.error(e); }
}
async function setStatus(t: Team, status: Team['status']) {
  const label = { alive: '恢复', eliminated: '淘汰', withdrawn: '退赛' }[status];
  if (!(await ui.confirm(`${label}队伍`, `确定将「${t.label}」标记为${label}？`, { danger: status !== 'alive' }))) return;
  try { await api(`/teams/${t.id}`, { method: 'PUT', body: { status } }); await race.loadTeams(); ui.toast(`已${label}`); } catch (e) { ui.error(e); }
}
async function remove(t: Team) {
  if (!(await ui.confirm('删除队伍', `删除「${t.label}」？其所有记录和货币日志也会被删除。`, { danger: true, okText: '删除' }))) return;
  try { await api(`/teams/${t.id}`, { method: 'DELETE' }); await race.loadTeams(); ui.toast('已删除'); } catch (e) { ui.error(e); }
}
async function resetAll() {
  if (!(await ui.confirm('重置队伍数据', '所有队伍恢复为存活、余额清零（队名保留）。确定？', { danger: true }))) return;
  try { await api('/teams/reset', { method: 'POST' }); await race.loadTeams(); ui.toast('已重置'); } catch (e) { ui.error(e); }
}
</script>

<template>
  <div class="flex-between mb-2">
    <div class="section-title">队伍列表（共 {{ race.teams.length }} 支，存活 {{ race.aliveTeams.length }}）</div>
    <div v-if="auth.isHost" class="flex">
      <button class="btn" @click="open('new')">+ 新增队伍</button>
      <button class="btn btn-outline" @click="resetAll">重置队伍数据</button>
    </div>
  </div>
  <div class="grid grid-3">
    <div v-for="t in race.teams" :key="t.id" class="team-card" :class="'team-' + t.status">
      <div class="flex-between" style="margin-bottom: 4px">
        <span style="font-weight: 700; font-size: 16px">{{ t.label }}</span>
        <TeamStatus :status="t.status" />
      </div>
      <div class="currency-box mt-1">{{ fmtMoney(t.currency) }} <span class="text-sm text-gray">{{ moneyUnit() }}</span></div>
      <div v-if="auth.isHost" class="flex mt-2" style="gap: 6px; flex-wrap: nowrap">
        <button class="btn btn-outline btn-sm" @click="open(t)">编辑</button>
        <button v-if="t.status !== 'alive'" class="btn btn-success btn-sm" @click="setStatus(t, 'alive')">恢复</button>
        <template v-else>
          <button class="btn btn-danger btn-sm" @click="setStatus(t, 'eliminated')">淘汰</button>
          <button class="btn btn-secondary btn-sm" @click="setStatus(t, 'withdrawn')">退赛</button>
        </template>
        <button class="btn btn-outline btn-sm" @click="remove(t)">删除</button>
      </div>
    </div>
  </div>

  <Modal v-if="editing" :title="editing === 'new' ? '新增队伍' : '编辑队伍'" small @close="editing = null">
    <div class="form-group"><label>队名（编号）</label><input v-model="form.name" placeholder="如 01" /></div>
    <div v-for="i in form.members.length" :key="i" class="form-group"><label>成员 {{ i }}</label><input v-model="form.members[i - 1]" :placeholder="`成员 ${i} 姓名`" /></div>
    <div class="info-text">填了成员后，各处显示为「编号 成员1&成员2」；每队人数在「主办后台 → 赛事设置」里改。</div>
    <div class="modal-actions"><button class="btn btn-secondary" @click="editing = null">取消</button><button class="btn" @click="save">保存</button></div>
  </Modal>
</template>
