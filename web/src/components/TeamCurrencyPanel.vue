<script setup lang="ts">
import { computed } from 'vue';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import LegTag from './LegTag.vue';
import { useUi } from '@/stores/ui';
import { fmtDateTime } from '@/utils/time';
import { fmtMoney, moneyUnit, moneyLabel } from '@/utils/money';
import CurrencyOps from './CurrencyOps.vue';
import { legName, type LedgerEntry } from '@/types';

// 跟队在「我的」页面对所跟队伍的经费操作：加减、环节、最近流水与撤销
const props = defineProps<{ teamId: number }>();
const race = useRace();
const ui = useUi();
const team = computed(() => race.teamById.get(props.teamId));
const rows = computed(() => race.ledger.filter((l) => l.team_id === props.teamId && !l.reverts_id).slice(0, 20));
const revertedBy = (l: LedgerEntry) => race.ledger.find((x) => x.reverts_id === l.id)?.operator_name ?? '';

async function revert(l: LedgerEntry) {
  if (!(await ui.confirm('撤销经费变动', `撤销这笔 ${fmtMoney(l.delta, true)} ${moneyUnit()}（${l.reason || '手动调整'}）？会写入一条反向流水，余额相应恢复。`, { danger: true, okText: '撤销' }))) return;
  try { await api(`/ledger/${l.id}/revert`, { method: 'POST' }); await Promise.all([race.loadTeams(), race.loadLedger()]); ui.toast('已撤销'); } catch (e) { ui.error(e); }
}
</script>

<template>
  <CurrencyOps v-if="team" :team-id="props.teamId">
    <template #title><span class="text-gray text-sm">当前余额 {{ fmtMoney(team.currency) }} {{ moneyUnit() }}</span></template>
    <div v-if="!rows.length" class="text-gray text-sm">本赛段暂无变动</div>
    <div v-else class="scroll-table">
      <table class="table table-dense">
        <thead><tr><th>时间</th><th>环节</th><th class="c">变动（{{ moneyUnit() }}）</th><th class="c">余额（{{ moneyUnit() }}）</th><th>操作人</th><th>原因</th><th class="c">其他</th></tr></thead>
        <tbody>
          <tr v-for="l in rows" :key="l.id" :class="{ 'row-reverted': l.reverted }">
            <td>{{ fmtDateTime(l.created_at) }}</td><td><template v-if="l.leg_id && race.legById.get(l.leg_id)"><LegTag :type="race.legById.get(l.leg_id)!.type" /> {{ legName(race.legById.get(l.leg_id)!) }}</template><template v-else>{{ l.leg_name || '其他' }}</template></td>
            <td class="c" :class="l.delta > 0 ? 'log-positive' : 'log-negative'">{{ fmtMoney(l.delta, true) }}</td>
            <td class="c">{{ fmtMoney(l.balance_after) }}</td><td>{{ l.operator_name }}</td><td class="wrap">{{ l.reason || '-' }}</td>
            <td class="c"><span v-if="l.reverted" class="revert-note">{{ revertedBy(l) }}撤销</span><button v-else-if="race.canRevert(l.operator_id)" class="btn btn-text btn-sm" @click="revert(l)"><Icon name="undo" size="16" />撤销</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </CurrencyOps>
</template>
