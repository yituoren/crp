<script setup lang="ts">
import { computed, reactive } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import LegTag from './LegTag.vue';
import { legName } from '@/types';
import { useUi } from '@/stores/ui';
import { fmtDateTime } from '@/utils/time';

// legId：只显示该环节（站点）的记录，新增也记在该环节上；teamId：只显示该队伍（跟队）的记录，新增也只针对该队
const props = defineProps<{ legId?: number; teamId?: number }>();
const auth = useAuth();
const race = useRace();
const ui = useUi();
const ep = computed(() => race.currentEpisode);
const form = reactive({ teamId: (props.teamId ?? '') as number | '', minutes: '', reason: '', legId: '' as number | '' });
const canAdd = computed(() => (props.teamId ? race.canManagePenaltyFor(props.teamId) : race.canManagePenalty));
// 站点可选所有队伍；跟队只能选所跟队伍
const teamOptions = computed(() => race.teams.filter((t) => race.canManagePenaltyFor(t.id)));
// 环节选项：本赛段所有环节；“其他”只有主办能选
const legOptions = computed(() => (ep.value?.legs ?? []));
const totals = computed(() => {
  const m = new Map<number, number>();
  for (const p of race.penalties) m.set(p.team_id, (m.get(p.team_id) ?? 0) + p.minutes);
  return m;
});

async function apply(sign: 1 | -1) {
  if (!ep.value) return;
  const minutes = Number(form.minutes);
  if (!form.teamId) { ui.toast('请选择队伍', 'error'); return; }
  const legId = props.legId ?? (form.legId === '' || Number(form.legId) === 0 ? null : Number(form.legId));
  if (!props.legId && form.legId === '') { ui.toast('请选择环节', 'error'); return; }
  if (!props.legId && !legId && !auth.isHost) { ui.toast('“其他”只能由主办操作', 'error'); return; }
  if (!Number.isInteger(minutes) || minutes <= 0) { ui.toast('分钟数必须是正整数，补时请用「补充时间」按钮', 'error'); return; }
  const team = race.teamById.get(Number(form.teamId))?.name ?? '';
  const reason = form.reason.trim() || (sign > 0 ? '罚时' : '补充时间');
  const cur = totals.value.get(Number(form.teamId)) ?? 0;
  if (!(await ui.confirm(sign > 0 ? '增加罚时' : '补充时间', `「${team}」${sign > 0 ? `增加 ${minutes} 分钟罚时` : `补充 ${minutes} 分钟时间（从最终用时中扣除）`}，原因：${reason}\n本赛段净罚时 ${cur} → ${cur + minutes * sign} 分钟`))) return;
  try {
    await api(`/episodes/${ep.value.id}/penalties`, { method: 'POST', body: { teamId: form.teamId, minutes: minutes * sign, reason, legId } });
    form.minutes = ''; form.reason = '';
    await race.loadProgress();
    ui.toast(sign > 0 ? `已增加 ${minutes} 分钟罚时` : `已补充 ${minutes} 分钟时间`);
  } catch (e) { ui.error(e); }
}
async function revert(p: { id: number; team_name: string; minutes: number; reason: string }) {
  const what = p.minutes > 0 ? `${p.minutes} 分钟罚时` : `${-p.minutes} 分钟补时`;
  if (!(await ui.confirm('撤销记录', `撤销「${p.team_name}」的这条 ${what}（${p.reason || '-'}）？会写入一条反向记录，净罚时和名次相应恢复。`, { danger: true, okText: '撤销' }))) return;
  try { await api(`/penalties/${p.id}/revert`, { method: 'POST' }); await race.loadProgress(); ui.toast('已撤销'); } catch (e) { ui.error(e); }
}
// 页面只显示原始记录（被撤销的划线）；反向记录留在数据库与操作日志里
const revertedBy = (id: number) => race.penalties.find((x) => x.reverts_id === id)?.applied_by_name ?? '';
const visible = computed(() => race.penalties.filter((p) => !p.reverts_id && (!props.legId || p.leg_id === props.legId) && (!props.teamId || p.team_id === props.teamId)));
</script>

<template>
  <div class="card">
    <div class="card-header">
      <span class="flex" style="gap: 12px">
        <span>{{ props.legId ? '本站点罚时与补时' : props.teamId ? '本队罚时与补时' : '罚时与补时' }}</span>
        <MSelect v-if="!props.teamId && canAdd && !race.episodePending" v-model="form.teamId" sm style="width: 170px" placeholder="选择队伍" :options="teamOptions.map((t) => ({ value: t.id, label: t.label }))" />
      </span>
      <span v-if="!canAdd" class="text-sm text-gray">主办、本赛段站点可操作所有队伍，跟队只能操作所跟队伍</span>
    </div>
    <div v-if="race.episodePending" class="alert alert-warning">赛段尚未开始，开始赛段后才能操作罚时。</div>
    <div v-else-if="race.episodeFinished" class="alert alert-info">赛段已结束，罚时记录已锁定，只有管理员可以修改。</div>
    <div v-else-if="canAdd" class="flex mb-2 penalty-form">
      <MSelect v-if="!props.legId" v-model="form.legId" outlined style="width: 160px" placeholder="选择环节" :options="[...legOptions.map((l) => ({ value: l.id, label: legName(l), tag: l.type })), ...(auth.isHost ? [{ value: 0, label: '其他' }] : [])]" />
      <input v-model="form.minutes" type="number" inputmode="numeric" min="1" step="1" class="input-inline pf-min" placeholder="分钟" style="width: 90px" />
      <input v-model="form.reason" class="input-inline pf-reason" placeholder="原因（如：打车超预算 / 站点失误耽误）" style="flex: 1; min-width: 160px" />
      <button class="btn btn-tonal btn-tonal-danger" @click="apply(1)">增加罚时</button>
      <button class="btn btn-tonal" @click="apply(-1)">补充时间</button>
    </div>
    <div v-if="!visible.length" class="empty-rows">暂无记录</div>
    <div v-else class="scroll-table">
      <table v-mobile-table class="table table-dense">
        <thead><tr><th>时间</th><th>队伍</th><th v-if="!props.legId">环节</th><th class="c">类型</th><th class="c">分钟</th><th class="c">净罚时</th><th>操作人</th><th>原因</th><th class="c">其他</th></tr></thead>
        <tbody>
          <tr v-for="p in visible" :key="p.id" :class="{ 'row-reverted': p.reverted }">
            <td>{{ fmtDateTime(p.applied_at) }}</td>
            <td>{{ p.team_name }}</td>
            <td v-if="!props.legId"><template v-if="p.leg_id && race.legById.get(p.leg_id)"><LegTag :type="race.legById.get(p.leg_id)!.type" /> {{ legName(race.legById.get(p.leg_id)!) }}</template><template v-else>{{ p.leg_name || '其他' }}</template></td>
            <td class="c" :class="p.minutes > 0 ? 'log-negative' : 'log-positive'">{{ p.minutes > 0 ? '罚时' : '补时' }}</td>
            <td class="c" :class="p.minutes > 0 ? 'log-negative' : 'log-positive'">{{ p.minutes > 0 ? '+' : '' }}{{ p.minutes }}</td>
            <td class="c">{{ totals.get(p.team_id) ?? 0 }}</td>
            <td>{{ p.applied_by_name ?? '-' }}</td>
            <td class="wrap">{{ p.reason || '-' }}</td>
            <td class="c"><span v-if="p.reverted" class="revert-note">{{ revertedBy(p.id) }}撤销</span><button v-else-if="race.canRevert(p.applied_by, p.team_id)" class="btn btn-text btn-sm" @click="revert(p)"><Icon name="undo" size="16" />撤销</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
