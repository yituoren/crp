<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import ItemLogTable from './ItemLogTable.vue';

/**
 * Bag card: lists a team's items separately; select several and click "use" to write one use record per item,
 * used items disappear from the bag. Shown directly on the follow's "Mine" page and reused in a dialog on the money page.
 */
const props = withDefaults(defineProps<{ teamId: number; title?: string; plain?: boolean }>(), { title: '本队背包', plain: false });
const race = useRace();
const ui = useUi();
const team = computed(() => race.teamById.get(props.teamId));
const items = computed(() => team.value?.inventory ?? []);
const selected = ref<string[]>([]);
watch(items, (list) => { selected.value = selected.value.filter((n) => list.some((i) => i.name === n)); });
const canUse = computed(() => race.canAdjustCurrencyFor(props.teamId) && !race.episodePending);
function toggle(name: string) {
  if (!canUse.value) return;
  const i = selected.value.indexOf(name);
  if (i >= 0) selected.value.splice(i, 1); else selected.value.push(name);
}
const busy = ref(false);
async function useSelected() {
  const names = [...selected.value]; if (!names.length || !team.value) return;
  if (!(await ui.confirm('使用物品', `「${team.value.label}」使用：${names.join('、')}。每件物品记一条使用记录，用掉的从背包里消失。`))) return;
  busy.value = true;
  try {
    for (const name of names) await api('/items/use', { method: 'POST', body: { episodeId: race.currentEpisode?.id ?? null, teamId: props.teamId, itemName: name } });
    selected.value = [];
    await Promise.all([race.loadTeams(), race.loadLedger()]);
    ui.toast(`已使用 ${names.length} 件物品`);
  } catch (e) { ui.error(e); await Promise.all([race.loadTeams(), race.loadLedger()]); } finally { busy.value = false; }
}
</script>

<template>
  <div :class="plain ? '' : 'card'">
    <div v-if="!plain" class="card-header"><span>{{ title }}</span></div>
    <div v-if="!items.length" class="empty-rows">暂无物品</div>
    <template v-else>
      <div class="bag-grid">
        <button v-for="it in items" :key="it.name" type="button" class="bag-tile" :class="{ on: selected.includes(it.name), off: !canUse }" :disabled="!canUse" @click="toggle(it.name)">
          <span class="bag-tile-check"><Icon v-if="selected.includes(it.name)" name="check" size="16" /></span>
          <span class="bag-tile-name">{{ it.name }}</span>
          <span class="bag-tile-count">×{{ it.count }}</span>
        </button>
      </div>
      <div class="bag-actions">
        <span class="text-sm text-gray">{{ selected.length ? `已选 ${selected.length} 件` : canUse ? '点选物品后使用' : '' }}</span>
        <button class="btn btn-tonal btn-sm" :disabled="!selected.length || busy" @click="useSelected">使用</button>
      </div>
    </template>
    <!-- Item log: gains and uses, separate from the money ledger -->
    <div class="bag-log"><ItemLogTable :team-id="teamId" :limit="plain ? 10 : 0" /></div>
  </div>
</template>
