<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import ItemLogTable from './ItemLogTable.vue';
import Modal from './Modal.vue';
import { isTipItem, legName, twistKind, isDirectedTwist } from '@/types';

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
// 锦囊 cards pick one of the tips of the leg the team is on right now (started, not finished)
const tipNames = computed(() => selected.value.filter(isTipItem));
const currentLeg = computed(() => [...(race.currentEpisode?.legs ?? [])].reverse().find((l) => { const p = race.progressOf(props.teamId, l.id); return !!p?.arrived_at && !p.completed_at; }) ?? null);
const tipOptions = computed(() => (currentLeg.value?.tips ?? []).map((t) => ({ value: String(t.id), label: t.code })));
/** A twist card cannot pick a team this kind of card has already been played on in this episode */
function taken(name: string, teamId: number) {
  if (!isDirectedTwist(name)) return false;
  const kind = twistKind(name);
  if (kind) return race.effects.some((e) => e.kind === kind && e.target_team_id === teamId && ['pending', 'queued', 'hit'].includes(e.status));
  return race.itemLog.some((l) => l.item_name === name && l.kind === 'use' && !l.reverted && !l.reverts_id && l.target_team_id === teamId && l.episode_id === race.currentEpisode?.id);
}
const targetOptionsFor = (name: string) => race.teams.filter((t) => t.status === 'alive' && t.id !== props.teamId && !taken(name, t.id)).map((t) => ({ value: String(t.id), label: t.label }));
const picking = ref(false);
const targets = ref<Record<string, string>>({});
async function useSelected() {
  const names = [...selected.value]; if (!names.length || !team.value) return;
  if (tipNames.value.length) {
    if (!currentLeg.value) { ui.toast('本队当前不在任何环节中，不能使用锦囊', 'error'); return; }
    if (!currentLeg.value.tips.length) { ui.toast(`「${legName(currentLeg.value)}」没有设置锦囊`, 'error'); return; }
  }
  if (targetNames.value.length || tipNames.value.length) { targets.value = {}; picking.value = true; return; }
  if (!(await ui.confirm('使用物品', `「${team.value.label}」使用：${names.join('、')}。每件物品记一条使用记录，用掉的从背包里消失。`))) return;
  await submit(names);
}
async function confirmTargets() {
  const missing = [...targetNames.value, ...tipNames.value].find((n) => !targets.value[n]);
  if (missing) { ui.toast(`请选择「${missing}」的对象`, 'error'); return; }
  picking.value = false;
  await submit([...selected.value]);
}
async function submit(names: string[]) {
  busy.value = true;
  try {
    const revealed: string[] = [];
    for (const name of names) {
      const pick = targets.value[name] ? Number(targets.value[name]) : undefined;
      const r = await api('/items/use', { method: 'POST', body: { episodeId: race.currentEpisode?.id ?? null, teamId: props.teamId, itemName: name, ...(isTipItem(name) ? { tipId: pick } : { targetTeamId: pick }) } });
      if (r.tip) revealed.push(`【${r.tip.code}】\n${r.tip.tip || '（未填写提示）'}`);
    }
    if (revealed.length) void ui.alert('锦囊提示', revealed.join('\n\n'));
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
      <div v-for="n in targetNames" :key="n" class="form-group"><label>{{ n }} 的对象</label><MSelect v-model="targets[n]" outlined placeholder="选择队伍" :options="targetOptionsFor(n)" /></div>
      <div v-for="n in tipNames" :key="n" class="form-group"><label>{{ n }}：选择「{{ currentLeg ? legName(currentLeg) : '' }}」的锦囊</label><MSelect v-model="targets[n]" outlined placeholder="选择 id" :options="tipOptions" /></div>
      <div class="modal-actions">
        <button class="btn btn-text" @click="picking = false">取消</button>
        <button class="btn" :disabled="busy" @click="confirmTargets">使用</button>
      </div>
    </Modal>
    <!-- Item log: gains and uses, separate from the money ledger -->
    <div class="bag-log"><ItemLogTable :team-id="teamId" :limit="plain ? 10 : 0" /></div>
  </div>
</template>
