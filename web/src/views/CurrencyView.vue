<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtDateTime } from '@/utils/time';
import { fmtMoney, parseMoney, moneyUnit, moneyLabel, moneyMode } from '@/utils/money';
import EpSelector from '@/components/EpSelector.vue';
import type { Team, LedgerEntry } from '@/types';

const auth = useAuth();
const race = useRace();
const ui = useUi();
const ep = computed(() => race.currentEpisode);
const inputs = reactive<Record<number, { amount: string; reason: string }>>({});
const legSel = ref<number | ''>(''); // 本次变动发生的环节；空 = 其他，不做校验
const filterTeam = ref<number | ''>('');
const get = (id: number) => (inputs[id] ??= { amount: '', reason: '' });

async function apply(t: Team, sign: 1 | -1) {
  const inp = get(t.id);
  const amount = parseMoney(inp.amount);
  if (amount === null) { ui.toast(moneyMode() === 'coin' ? '数量必须是正整数；扣除请用「扣除」按钮' : '金额必须是正数，最多两位小数；扣除请用「扣除」按钮', 'error'); return; }
  const delta = amount * sign;
  const reason = inp.reason.trim() || (sign > 0 ? '任务奖励' : '手动扣除');
  if (!(await ui.confirm(sign > 0 ? '增加货币' : '扣除货币', `「${t.label}」${sign > 0 ? '增加' : '扣除'} ${fmtMoney(amount)} ${moneyUnit()}，原因：${reason}\n当前余额 ${fmtMoney(t.currency)} → ${fmtMoney(t.currency + delta)}`))) return;
  try {
    await api('/ledger', { method: 'POST', body: { episodeId: ep.value?.id, teamId: t.id, delta, reason, legId: legSel.value === '' ? null : legSel.value } });
    inp.amount = ''; inp.reason = '';
    await Promise.all([race.loadTeams(), race.loadLedger()]);
    ui.toast(`已${sign > 0 ? '增加' : '扣除'} ${fmtMoney(amount)} ${moneyUnit()}`);
  } catch (e) { ui.error(e); }
}
// 页面上只显示原始流水（被撤销的划线标出）；反向的撤销记录保留在数据库和操作日志里，不在列表中重复出现
const rows = computed(() => race.ledger.filter((l) => !l.reverts_id && (!filterTeam.value || l.team_id === filterTeam.value)));
const canRevertAny = computed(() => race.canAdjustCurrency);
async function revert(l: LedgerEntry) {
  if (!(await ui.confirm('撤销经费变动', `撤销「${l.team_name}」的这笔 ${fmtMoney(l.delta, true)} ${moneyUnit()}（${l.reason || '手动调整'}）？会写入一条反向流水，余额相应恢复。`, { danger: true, okText: '撤销' }))) return;
  try { await api(`/ledger/${l.id}/revert`, { method: 'POST' }); await Promise.all([race.loadTeams(), race.loadLedger()]); ui.toast('已撤销'); } catch (e) { ui.error(e); }
}
</script>

<template>
  <EpSelector />
  <div class="flex-between mb-2">
    <div class="flex">
      <div class="section-title">{{ moneyLabel() }}操作</div>
      <select v-if="race.canAdjustCurrency" v-model="legSel" class="input-sm input-inline" style="width: 150px" title="本次变动发生的环节">
        <option value="">环节：其他</option>
        <option v-for="l in ep?.legs ?? []" :key="l.id" :value="l.id">环节：{{ l.name }}</option>
      </select>
    </div>
    <span v-if="!race.canAdjustCurrency" class="text-sm text-gray">主办可操作所有队伍，跟队只能操作所跟队伍</span>
  </div>
  <div v-if="race.episodePending" class="alert alert-warning">赛段尚未开始，开始赛段后才能操作经费。</div>
  <div v-else-if="race.episodeFinished && !auth.isHost" class="alert alert-info">赛段已结束，经费记录已锁定，只有主办可以修改。</div>
  <div class="grid grid-4">
    <div v-for="t in race.teams" :key="t.id" class="team-card" :class="'team-' + t.status">
      <div class="flex-between"><strong>{{ t.label }}</strong><span v-if="t.status !== 'alive'" class="status-eliminated">{{ t.status === 'eliminated' ? '已淘汰' : '已退赛' }}</span></div>
      <div class="currency-box">{{ fmtMoney(t.currency) }} <span class="text-sm text-gray">{{ moneyUnit() }}</span></div>
      <div v-if="race.canAdjustCurrencyFor(t.id) && t.status === 'alive' && !race.episodePending" class="mt-1">
        <div class="flex" style="gap: 6px; flex-wrap: nowrap">
          <input v-model="get(t.id).amount" type="number" :inputmode="moneyMode() === 'coin' ? 'numeric' : 'decimal'" min="0" step="1" class="input-sm" :placeholder="moneyUnit() === '币' ? '数量' : '金额'" style="width: 90px" />
          <input v-model="get(t.id).reason" class="input-sm" placeholder="原因" style="flex: 1; min-width: 60px" />
        </div>
        <div class="flex mt-1" style="gap: 6px">
          <button class="btn btn-success btn-sm" style="flex: 1" @click="apply(t, 1)">增加</button>
          <button class="btn btn-danger btn-sm" style="flex: 1" @click="apply(t, -1)">扣除</button>
        </div>
      </div>
    </div>
  </div>

  <div class="card mt-3">
    <div class="card-header">
      <span>{{ moneyLabel() }}变动日志</span>
      <select v-model="filterTeam" class="input-sm input-inline" style="width: 140px"><option value="">全部队伍</option><option v-for="t in race.teams" :key="t.id" :value="t.id">{{ t.label }}</option></select>
    </div>
    <div v-if="!rows.length" class="empty-state">暂无货币变动记录</div>
    <div v-else class="scroll-table">
      <table class="table">
        <thead><tr><th>时间</th><th>队伍</th><th>环节</th><th>变动（{{ moneyUnit() }}）</th><th>余额（{{ moneyUnit() }}）</th><th>操作人</th><th>原因</th><th v-if="canRevertAny"></th></tr></thead>
        <tbody>
          <tr v-for="l in rows" :key="l.id" :style="l.reverted ? 'opacity:.5;text-decoration:line-through' : ''">
            <td>{{ fmtDateTime(l.created_at) }}</td><td>{{ l.team_name }}</td><td>{{ l.leg_name || '其他' }}</td>
            <td :class="l.delta > 0 ? 'log-positive' : 'log-negative'">{{ fmtMoney(l.delta, true) }}</td>
            <td>{{ fmtMoney(l.balance_after) }}</td><td>{{ l.operator_name }}</td><td>{{ l.reason || '-' }}</td>
            <td v-if="canRevertAny"><button v-if="!l.reverted && !l.reverts_id && race.canAdjustCurrencyFor(l.team_id)" class="btn btn-outline btn-sm" @click="revert(l)">撤销</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

</template>
