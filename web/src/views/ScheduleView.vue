<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import EpSelector from '@/components/EpSelector.vue';

const auth = useAuth();
const race = useRace();
const ui = useUi();
const ep = computed(() => race.currentEpisode);

interface RowForm { userId: number; role: 'crew' | 'follow' | 'station' | 'live'; teamId: number | ''; legId: number | '' }
const form = reactive<{ rows: RowForm[] }>({ rows: [] });

function rebuild() {
  form.rows = race.users.filter((u) => !u.disabled).map((u) => {
    const a = race.assignments.find((x) => x.user_id === u.id);
    return { userId: u.id, role: (a?.role ?? 'crew') as RowForm['role'], teamId: a?.team_id ?? '', legId: a?.leg_id ?? '' };
  });
}
watch(() => [race.assignments, race.users, ep.value?.id], rebuild, { immediate: true, deep: true });

const userById = computed(() => new Map(race.users.map((u) => [u.id, u])));
const roleLabel: Record<string, [string, string]> = { admin: ['管理员', 'badge-host'], host: ['主办', 'badge-host'], follow: ['跟队', 'badge-follow'], station: ['站点', 'badge-station'], live: ['直播员', 'badge-live'], crew: ['机动', 'badge-crew'] };
function displayRole(userId: number) {
  const a = race.assignments.find((x) => x.user_id === userId);
  if (a) return roleLabel[a.role]!;
  const r = userById.value.get(userId)?.role;
  return r === 'admin' ? roleLabel.admin! : r === 'host' ? roleLabel.host! : roleLabel.crew!;
}
function assignText(userId: number) {
  const a = race.assignments.find((x) => x.user_id === userId);
  if (!a) return '-';
  if (a.role === 'follow') return `跟队 → ${a.team_name ?? '?'}`;
  if (a.role === 'live') return '直播员 → 全赛段（只读）';
  return `站点 → ${a.leg_name ?? '?'}`;
}
const conflicts = computed(() => {
  const seen = new Map<number, number>();
  const dup: number[] = [];
  for (const r of form.rows) if (r.role === 'follow' && r.teamId) { const n = (seen.get(Number(r.teamId)) ?? 0) + 1; seen.set(Number(r.teamId), n); if (n > 1) dup.push(Number(r.teamId)); }
  return [...new Set(dup)].map((id) => race.teamById.get(id)?.label ?? id);
});
const unassignedTeams = computed(() => race.aliveTeams.filter((t) => !form.rows.some((r) => r.role === 'follow' && Number(r.teamId) === t.id)).map((t) => t.label));

async function save() {
  if (!ep.value) return;
  for (const r of form.rows) {
    if (r.role === 'follow' && !r.teamId) { ui.toast(`${userById.value.get(r.userId)?.displayName} 是跟队但没选队伍`, 'error'); return; }
    if (r.role === 'station' && !r.legId) { ui.toast(`${userById.value.get(r.userId)?.displayName} 是站点但没选环节`, 'error'); return; }
  }
  try {
    await api(`/episodes/${ep.value.id}/assignments`, { method: 'PUT', body: { items: form.rows } });
    await race.loadAssignments();
    ui.toast('排班已保存并同步');
  } catch (e) { ui.error(e); }
}
async function copyPrev() {
  if (!ep.value) return;
  const idx = race.episodes.findIndex((e) => e.id === ep.value!.id);
  const prev = race.episodes[idx - 1];
  if (!prev) { ui.toast('没有上一赛段', 'error'); return; }
  if (!(await ui.confirm('复制排班', `用 ${prev.code} 的跟队安排覆盖 ${ep.value.code} 当前排班？（站点需重新指定）`))) return;
  try { await api(`/episodes/${ep.value.id}/assignments/copy-from/${prev.id}`, { method: 'POST' }); await race.loadAssignments(); ui.toast('已复制'); } catch (e) { ui.error(e); }
}
</script>

<template>
  <EpSelector />
  <div class="card">
    <div class="card-header">
      <span>{{ ep?.code }} 排班表</span>
      <div v-if="auth.isHost" class="flex">
        <button class="btn btn-outline" @click="copyPrev">复制上一赛段跟队</button>
        <button class="btn" @click="save">保存排班</button>
      </div>
    </div>
    <div v-if="!race.users.length" class="empty-state">暂无注册幕后</div>
    <div v-else class="scroll-table">
      <table class="table">
        <thead><tr><th style="width: 22%">幕后</th><th style="width: 12%">角色</th><th style="width: 26%">分配详情</th><th v-if="auth.isHost" style="min-width: 290px">编辑</th></tr></thead>
        <tbody>
          <tr v-for="r in form.rows" :key="r.userId">
            <td><strong>{{ userById.get(r.userId)?.displayName }}</strong> <span v-if="userById.get(r.userId)?.role === 'admin'" class="badge badge-host">管理员</span><span v-else-if="userById.get(r.userId)?.role === 'host'" class="badge badge-host">主办</span></td>
            <td><span class="badge" :class="displayRole(r.userId)[1]">{{ displayRole(r.userId)[0] }}</span></td>
            <td>{{ assignText(r.userId) }}</td>
            <td v-if="auth.isHost">
              <div class="flex" style="gap: 6px; flex-wrap: nowrap">
                <select v-model="r.role" class="input-sm input-inline" style="width: 90px; flex: none">
                  <option value="crew">机动</option><option value="follow">跟队</option><option value="station">站点</option><option value="live">直播员</option>
                </select>
                <select v-if="r.role === 'follow'" v-model="r.teamId" class="input-sm input-inline" style="width: 180px; flex: none">
                  <option value="">选择队伍</option>
                  <option v-for="t in race.teams" :key="t.id" :value="t.id">{{ t.label }}{{ t.status !== 'alive' ? '（已淘汰）' : '' }}</option>
                </select>
                <select v-else-if="r.role === 'station'" v-model="r.legId" class="input-sm input-inline" style="width: 180px; flex: none">
                  <option value="">选择环节</option>
                  <option v-for="l in (ep?.legs ?? []).filter((x) => x.needs_staff)" :key="l.id" :value="l.id">{{ l.type }} · {{ l.name }}</option>
                </select>
                <span v-else class="text-xs text-gray" style="width: 180px; flex: none">{{ r.role === 'live' ? '全赛段只读' : '无需分配' }}</span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="auth.isHost" class="mt-2 text-sm">
      <div v-if="conflicts.length" class="alert alert-warning">以下队伍被分配了多个跟队：{{ conflicts.join('、') }}</div>
      <div v-if="unassignedTeams.length" class="alert alert-info">尚无跟队的存活队伍：{{ unassignedTeams.join('、') }}</div>
    </div>
  </div>
</template>
