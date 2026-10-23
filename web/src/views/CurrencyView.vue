<script setup lang="ts">
import { computed, ref } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import LegTag from '@/components/LegTag.vue';
import { useUi } from '@/stores/ui';
import { fmtDateTime } from '@/utils/time';
import { fmtMoney, moneyUnit, moneyLabel, moneyMode } from '@/utils/money';
import CurrencyOps from '@/components/CurrencyOps.vue';
import EpSelector from '@/components/EpSelector.vue';
import { type LedgerEntry, legName } from '@/types';

const auth = useAuth();
const race = useRace();
const ui = useUi();
const ep = computed(() => race.currentEpisode);
const filterTeam = ref<number | ''>('');
/** 跟队只能操作所跟队伍：表单里直接固定队伍 */
const fixedTeam = computed(() => (!auth.isHost && race.myAssignment?.role === 'follow' ? race.myAssignment.team_id ?? undefined : undefined));
// 页面上只显示原始流水（被撤销的划线标出）；反向的撤销记录保留在数据库和操作日志里，不在列表中重复出现
const rows = computed(() => race.ledger.filter((l) => !l.reverts_id && (!filterTeam.value || l.team_id === filterTeam.value)));
/** 谁撤销了这条记录：找到它的反向流水的操作人 */
const revertedBy = (l: LedgerEntry) => race.ledger.find((x) => x.reverts_id === l.id)?.operator_name ?? '';
async function revert(l: LedgerEntry) {
  if (!(await ui.confirm('撤销经费变动', `撤销「${l.team_name}」的这笔 ${fmtMoney(l.delta, true)} ${moneyUnit()}（${l.reason || '手动调整'}）？会写入一条反向流水，余额相应恢复。`, { danger: true, okText: '撤销' }))) return;
  try { await api(`/ledger/${l.id}/revert`, { method: 'POST' }); await Promise.all([race.loadTeams(), race.loadLedger(), race.loadProgress()]); ui.toast('已撤销'); } catch (e) { ui.error(e); }
}
</script>

<template>
  <EpSelector />

  <!-- 背包：普通模式只看经费余额；货币模式看余额 + 持有物品 -->
  <div class="card">
    <div class="card-header"><span>背包</span></div>
    <div class="grid grid-4">
      <div v-for="t in race.teams" :key="t.id" class="team-card bag-card" :class="'team-' + t.status">
        <div class="flex-between"><strong>{{ t.label }}</strong><span v-if="t.status !== 'alive'" class="status-eliminated">{{ t.status === 'eliminated' ? '已淘汰' : '已退赛' }}</span></div>
        <div class="currency-box">{{ fmtMoney(t.currency) }} <span class="text-sm text-gray">{{ moneyUnit() }}</span></div>
        <div v-if="moneyMode() === 'coin'" class="bag-items">
          <span v-for="it in t.inventory" :key="it.name" class="bag-item">{{ it.name }}<span v-if="it.count > 1" class="bag-count">×{{ it.count }}</span></span>
          <span v-if="!t.inventory.length" class="bag-empty">暂无物品</span>
        </div>
      </div>
    </div>
  </div>

  <!-- 操作：与跟队「我的」页相同的表单，主办多一个队伍选择 -->
  <CurrencyOps :team-id="fixedTeam">
  </CurrencyOps>

  <div class="card">
    <div class="card-header">
      <span>{{ moneyLabel() }}变动日志</span>
      <MSelect v-model="filterTeam" sm style="width: 150px" :options="[{ value: '', label: '全部队伍' }, ...race.teams.map((t) => ({ value: t.id, label: t.label }))]" />
    </div>
    <div v-if="!rows.length" class="empty-state">暂无货币变动记录</div>
    <div v-else class="scroll-table">
      <table class="table table-dense">
        <thead><tr><th>时间</th><th>队伍</th><th>环节</th><th class="c">变动（{{ moneyUnit() }}）</th><th class="c">余额（{{ moneyUnit() }}）</th><th>操作人</th><th>原因</th><th class="c">其他</th></tr></thead>
        <tbody>
          <tr v-for="l in rows" :key="l.id" :class="{ 'row-reverted': l.reverted }">
            <td>{{ fmtDateTime(l.created_at) }}</td><td>{{ l.team_name }}</td><td><template v-if="l.leg_id && race.legById.get(l.leg_id)"><LegTag :type="race.legById.get(l.leg_id)!.type" /> {{ legName(race.legById.get(l.leg_id)!) }}</template><template v-else>{{ l.leg_name || '其他' }}</template></td>
            <td class="c" :class="l.delta > 0 ? 'log-positive' : 'log-negative'">{{ fmtMoney(l.delta, true) }}</td>
            <td class="c">{{ fmtMoney(l.balance_after) }}</td><td>{{ l.operator_name }}</td><td class="wrap">{{ l.reason || '-' }}</td>
            <td class="c"><span v-if="l.reverted" class="revert-note">{{ revertedBy(l) }}撤销</span><button v-else-if="race.canRevert(l.operator_id, l.team_id)" class="btn btn-text btn-sm" @click="revert(l)"><Icon name="undo" size="16" />撤销</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

</template>
