<script setup lang="ts">
import { computed } from 'vue';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtDateTime } from '@/utils/time';
import { legName, type ItemLogEntry } from '@/types';
import LegTag from './LegTag.vue';

/** Item log: gains (mirrored from purchases) and uses, separate from the money ledger. Uses can be reverted (item returns to the bag); purchases are reverted in the ledger and synced here */
const props = withDefaults(defineProps<{ teamId?: number; limit?: number }>(), { limit: 0 });
const race = useRace();
const ui = useUi();
const rows = computed(() => {
  let list = race.itemLog.filter((l) => !l.reverts_id && (!props.teamId || l.team_id === props.teamId));
  if (props.limit) list = list.slice(0, props.limit);
  return list;
});
const revertedBy = (l: ItemLogEntry) => race.itemLog.find((x) => x.reverts_id === l.id)?.operator_name ?? '';
const kindText = (l: ItemLogEntry) => (l.kind === 'buy' ? '购买' : '使用');
async function revert(l: ItemLogEntry) {
  if (!(await ui.confirm('撤销使用', `撤销「${l.team_name}」这次使用「${l.item_name}」？物品会回到背包。`, { danger: true, okText: '撤销' }))) return;
  try { await api(`/item-log/${l.id}/revert`, { method: 'POST' }); await Promise.all([race.loadTeams(), race.loadItemLog()]); ui.toast('已撤销'); } catch (e) { ui.error(e); }
}
</script>

<template>
  <div v-if="!rows.length" class="empty-rows">暂无记录</div>
  <div v-else class="scroll-table">
    <table v-mobile-table class="table table-dense">
      <thead><tr><th>时间</th><th v-if="!teamId">队伍</th><th>环节</th><th>道具</th><th class="c">类型</th><th class="c">变动</th><th>操作人</th><th class="c">其他</th></tr></thead>
      <tbody>
        <tr v-for="l in rows" :key="l.id" :class="{ 'row-reverted': l.reverted }">
          <td>{{ fmtDateTime(l.created_at) }}</td>
          <td v-if="!teamId">{{ l.team_name }}</td>
          <td><template v-if="l.leg_id && race.legById.get(l.leg_id)"><LegTag :type="race.legById.get(l.leg_id)!.type" /> {{ legName(race.legById.get(l.leg_id)!) }}</template><template v-else>{{ l.leg_name || '其他' }}</template></td>
          <td>{{ l.item_name }}</td>
          <td class="c">{{ kindText(l) }}</td>
          <td class="c" :class="l.delta > 0 ? 'log-positive' : 'log-negative'">{{ l.delta > 0 ? `+${l.delta}` : l.delta }}</td>
          <td>{{ l.operator_name }}</td>
          <td class="c">
            <span v-if="l.reverted" class="revert-note">{{ revertedBy(l) }}撤销</span>
            <span v-else-if="l.kind === 'buy'" class="text-xs text-gray">经费流水撤销</span>
            <button v-else-if="race.canRevert(l.operator_id, l.team_id)" class="btn btn-text btn-sm" @click="revert(l)"><Icon name="undo" size="16" />撤销</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
