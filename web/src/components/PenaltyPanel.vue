<script setup lang="ts">
import { computed, reactive } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtDateTime } from '@/utils/time';

const auth = useAuth();
const race = useRace();
const ui = useUi();
const ep = computed(() => race.currentEpisode);
const form = reactive({ teamId: '' as number | '', minutes: '', reason: '' });
const totals = computed(() => {
  const m = new Map<number, number>();
  for (const p of race.penalties) m.set(p.team_id, (m.get(p.team_id) ?? 0) + p.minutes);
  return m;
});

async function apply(sign: 1 | -1) {
  if (!ep.value) return;
  const minutes = Number(form.minutes);
  if (!form.teamId) { ui.toast('请选择队伍', 'error'); return; }
  if (!Number.isInteger(minutes) || minutes <= 0) { ui.toast('分钟数必须是正整数，减少请用「减少罚时」按钮', 'error'); return; }
  const team = race.teamById.get(Number(form.teamId))?.name ?? '';
  const reason = form.reason.trim() || (sign > 0 ? '补罚时' : '罚时更正');
  const cur = totals.value.get(Number(form.teamId)) ?? 0;
  if (!(await ui.confirm(sign > 0 ? '增加罚时' : '减少罚时', `「${team}」${sign > 0 ? '增加' : '减少'} ${minutes} 分钟罚时，原因：${reason}\n本赛段累计罚时 ${cur} → ${cur + minutes * sign} 分钟`))) return;
  try {
    await api(`/episodes/${ep.value.id}/penalties`, { method: 'POST', body: { teamId: form.teamId, minutes: minutes * sign, reason } });
    form.minutes = ''; form.reason = '';
    await race.loadProgress();
    ui.toast(`已${sign > 0 ? '增加' : '减少'} ${minutes} 分钟罚时`);
  } catch (e) { ui.error(e); }
}
async function remove(id: number) {
  if (!(await ui.confirm('删除罚时记录', '确定删除这条罚时记录？', { danger: true }))) return;
  try { await api(`/penalties/${id}`, { method: 'DELETE' }); await race.loadProgress(); } catch (e) { ui.error(e); }
}
</script>

<template>
  <div class="card">
    <div class="card-header">
      <span>{{ ep?.code }} 罚时</span>
      <span v-if="!race.canAdjustCurrency" class="text-sm text-gray">只有主办与本赛段站点人员可以补罚时</span>
    </div>
    <div v-if="race.canAdjustCurrency" class="flex mb-2">
      <select v-model="form.teamId" class="input-inline" style="width: 140px"><option value="">选择队伍</option><option v-for="t in race.teams" :key="t.id" :value="t.id">{{ t.name }}</option></select>
      <input v-model="form.minutes" type="number" inputmode="numeric" min="1" step="1" class="input-inline" placeholder="分钟" style="width: 90px" />
      <input v-model="form.reason" class="input-inline" placeholder="原因（如：打车超预算）" style="flex: 1; min-width: 160px" />
      <button class="btn btn-danger" @click="apply(1)">增加罚时</button>
      <button class="btn btn-success" @click="apply(-1)">减少罚时</button>
    </div>
    <div v-if="!race.penalties.length" class="text-gray text-sm">本赛段暂无罚时</div>
    <div v-else class="scroll-table">
      <table class="table">
        <thead><tr><th>时间</th><th>队伍</th><th>变动（分钟）</th><th>累计</th><th>操作人</th><th>原因</th><th v-if="auth.isHost"></th></tr></thead>
        <tbody>
          <tr v-for="p in race.penalties" :key="p.id">
            <td>{{ fmtDateTime(p.applied_at) }}</td>
            <td>{{ p.team_name }}</td>
            <td :class="p.minutes > 0 ? 'log-negative' : 'log-positive'">{{ p.minutes > 0 ? '+' : '' }}{{ p.minutes }}</td>
            <td>{{ totals.get(p.team_id) ?? 0 }}</td>
            <td>{{ p.applied_by_name ?? '-' }}</td>
            <td class="wrap">{{ p.reason || '-' }}</td>
            <td v-if="auth.isHost"><button class="btn btn-outline btn-sm" @click="remove(p.id)">删</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
