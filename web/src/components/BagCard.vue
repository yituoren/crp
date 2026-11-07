<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import ItemLogTable from './ItemLogTable.vue';
import Modal from './Modal.vue';
import { isTipItem, twistKind, isDirectedTwist } from '@/types';

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
// Directed twist cards always ask for a target team, other twist cards with logic never do; other items follow the "needs a target" setting
const needsTarget = (name: string) => !isTipItem(name) && (isDirectedTwist(name) || (!twistKind(name) && !!race.shopItems.find((i) => i.name === name)?.needs_target));
const targetNames = computed(() => selected.value.filter(needsTarget));
// 锦囊 cards can be used at any time: the crew types the 锦囊 id they are used on
const tipNames = computed(() => selected.value.filter(isTipItem));
/** A twist card cannot pick a team this kind of card has already been played on in this episode */
function taken(name: string, teamId: number) {
  if (!isDirectedTwist(name)) return false;
  const kind = twistKind(name);
  if (kind) return race.effects.some((e) => e.kind === kind && e.target_team_id === teamId && ['pending', 'queued', 'hit'].includes(e.status));
  return race.itemLog.some((l) => l.item_name === name && l.kind === 'use' && !l.reverted && !l.reverts_id && l.target_team_id === teamId && l.episode_id === race.currentEpisode?.id);
}
const targetOptionsFor = (name: string) => race.teams.filter((t) => t.status === 'alive' && t.id !== props.teamId && !taken(name, t.id)).map((t) => ({ value: String(t.id), label: t.label }));
// 盗窃: the card drawn offline from the target's bag ('-' = nothing taken)
const isStealName = (name: string) => name.includes('盗窃');
const stealItem = ref<Record<string, string>>({});
const stealOptions = (name: string) => {
  const t = race.teamById.get(Number(targets.value[name]));
  return [{ value: '-', label: '未拿到（对方无牌或被挡下）' }, ...(t?.inventory ?? []).map((i) => ({ value: i.name, label: `${i.name} ×${i.count}` }))];
};
const picking = ref(false);
const targets = ref<Record<string, string>>({});
async function useSelected() {
  const names = [...selected.value]; if (!names.length || !team.value) return;
  if (targetNames.value.length || tipNames.value.length) { targets.value = {}; stealItem.value = {}; picking.value = true; return; }
  if (!(await ui.confirm('使用物品', `「${team.value.label}」使用：${names.join('、')}。每件物品记一条使用记录，用掉的从背包里消失。`))) return;
  await submit(names);
}
async function confirmTargets() {
  const missing = [...targetNames.value, ...tipNames.value].find((n) => !targets.value[n]?.trim());
  if (missing) { ui.toast(`请选择「${missing}」的对象`, 'error'); return; }
  const noCard = targetNames.value.find((n) => isStealName(n) && !stealItem.value[n]);
  if (noCard) { ui.toast(`请选择「${noCard}」拿到的卡`, 'error'); return; }
  picking.value = false;
  await submit([...selected.value]);
}
async function submit(names: string[]) {
  busy.value = true;
  try {
    for (const name of names) {
      const pick = targets.value[name] ? (isTipItem(name) ? { tipCode: targets.value[name].trim() } : { targetTeamId: Number(targets.value[name]) }) : {};
      await api('/items/use', { method: 'POST', body: { episodeId: race.currentEpisode?.id ?? null, teamId: props.teamId, itemName: name, ...pick, ...(isStealName(name) && stealItem.value[name] !== '-' ? { stealItem: stealItem.value[name] } : {}) } });
    }
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
    <Modal v-if="picking" title="使用物品" small @close="picking = false">
      <div class="text-sm text-gray mb-2">「{{ team?.label }}」使用：{{ selected.join('、') }}。每件物品记一条使用记录，用掉的从背包里消失。</div>
      <div v-for="n in targetNames" :key="n" class="form-group"><label>{{ n }} 的对象</label><MSelect v-model="targets[n]" outlined placeholder="选择队伍" :options="targetOptionsFor(n)" @update:model-value="stealItem[n] = ''" /></div>
      <div v-for="n in targetNames.filter((x) => isStealName(x) && targets[x])" :key="`steal-${n}`" class="form-group"><label>{{ n }}：拿到的卡（线下抽到的）</label><MSelect v-model="stealItem[n]" outlined placeholder="选择卡片" :options="stealOptions(n)" /></div>
      <div v-for="n in tipNames" :key="n" class="form-group"><label>{{ n }} 的对象</label><input v-model="targets[n]" placeholder="填写锦囊 id" /></div>
      <div class="modal-actions">
        <button class="btn btn-text" @click="picking = false">取消</button>
        <button class="btn" :disabled="busy" @click="confirmTargets">使用</button>
      </div>
    </Modal>
    <!-- Item log: gains and uses, separate from the money ledger -->
    <div class="bag-log"><ItemLogTable :team-id="teamId" :limit="plain ? 10 : 0" /></div>
  </div>
</template>
