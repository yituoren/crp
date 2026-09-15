<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtDateTime } from '@/utils/time';
import { fmtMoney, parseMoney, moneyUnit, moneyLabel, moneyMode } from '@/utils/money';
import type { LedgerEntry } from '@/types';

// 跟队在「我的」页面对所跟队伍的经费操作：加减、环节、最近流水与撤销
const props = defineProps<{ teamId: number }>();
const race = useRace();
const ui = useUi();
const ep = computed(() => race.currentEpisode);
const team = computed(() => race.teamById.get(props.teamId));
const form = reactive({ amount: '', reason: '' });
const legSel = ref<number | ''>('');
const rows = computed(() => race.ledger.filter((l) => l.team_id === props.teamId && !l.reverts_id).slice(0, 20));

async function apply(sign: 1 | -1) {
  const t = team.value; if (!t) return;
  const amount = parseMoney(form.amount);
  if (amount === null) { ui.toast(moneyMode() === 'coin' ? '数量必须是正整数；扣除请用「扣除」按钮' : '金额必须是正数，最多两位小数；扣除请用「扣除」按钮', 'error'); return; }
  const delta = amount * sign;
  const reason = form.reason.trim() || (sign > 0 ? '任务奖励' : '手动扣除');
  if (!(await ui.confirm(sign > 0 ? '增加经费' : '扣除经费', `「${t.label}」${sign > 0 ? '增加' : '扣除'} ${fmtMoney(amount)} ${moneyUnit()}，原因：${reason}\n当前余额 ${fmtMoney(t.currency)} → ${fmtMoney(t.currency + delta)}`))) return;
  try {
    await api('/ledger', { method: 'POST', body: { episodeId: ep.value?.id, teamId: t.id, delta, reason, legId: legSel.value === '' ? null : legSel.value } });
    form.amount = ''; form.reason = '';
    await Promise.all([race.loadTeams(), race.loadLedger()]);
    ui.toast(`已${sign > 0 ? '增加' : '扣除'} ${fmtMoney(amount)} ${moneyUnit()}`);
  } catch (e) { ui.error(e); }
}
async function revert(l: LedgerEntry) {
  if (!(await ui.confirm('撤销经费变动', `撤销这笔 ${fmtMoney(l.delta, true)} ${moneyUnit()}（${l.reason || '手动调整'}）？会写入一条反向流水，余额相应恢复。`, { danger: true, okText: '撤销' }))) return;
  try { await api(`/ledger/${l.id}/revert`, { method: 'POST' }); await Promise.all([race.loadTeams(), race.loadLedger()]); ui.toast('已撤销'); } catch (e) { ui.error(e); }
}
</script>

<template>
  <div v-if="team" class="card">
    <div class="card-header">
      <span>{{ moneyLabel() }}操作 <span class="text-gray text-sm">当前余额 {{ fmtMoney(team.currency) }} {{ moneyUnit() }}</span></span>
    </div>
    <div v-if="race.episodePending" class="alert alert-warning">赛段尚未开始，开始赛段后才能操作经费。</div>
    <div v-else class="flex mb-2">
      <input v-model="form.amount" type="number" :inputmode="moneyMode() === 'coin' ? 'numeric' : 'decimal'" min="0" step="1" class="input-inline" :placeholder="moneyUnit() === '币' ? '数量' : '金额'" style="width: 110px" />
      <select v-model="legSel" class="input-inline" style="width: 150px">
        <option value="">环节：其他</option>
        <option v-for="l in ep?.legs ?? []" :key="l.id" :value="l.id">环节：{{ l.name }}</option>
      </select>
      <input v-model="form.reason" class="input-inline" placeholder="原因（如：任务奖励、买线索）" style="flex: 1; min-width: 160px" />
      <button class="btn btn-success" @click="apply(1)">增加</button>
      <button class="btn btn-danger" @click="apply(-1)">扣除</button>
    </div>
    <div v-if="!rows.length" class="text-gray text-sm">本赛段暂无变动</div>
    <div v-else class="scroll-table">
      <table class="table">
        <thead><tr><th>时间</th><th>环节</th><th>变动（{{ moneyUnit() }}）</th><th>余额（{{ moneyUnit() }}）</th><th>操作人</th><th>原因</th><th></th></tr></thead>
        <tbody>
          <tr v-for="l in rows" :key="l.id" :style="l.reverted ? 'opacity:.5;text-decoration:line-through' : ''">
            <td>{{ fmtDateTime(l.created_at) }}</td><td>{{ l.leg_name || '其他' }}</td>
            <td :class="l.delta > 0 ? 'log-positive' : 'log-negative'">{{ fmtMoney(l.delta, true) }}</td>
            <td>{{ fmtMoney(l.balance_after) }}</td><td>{{ l.operator_name }}</td><td>{{ l.reason || '-' }}</td>
            <td><button v-if="!l.reverted" class="btn btn-outline btn-sm" @click="revert(l)">撤销</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
