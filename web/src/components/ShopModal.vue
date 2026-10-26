<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtMoney, moneyUnit } from '@/utils/money';
import Modal from './Modal.vue';

/**
 * Shop dialog: items are tiles like the bag; selecting one shows a quantity stepper on its right (the space is reserved
 * when unselected so tiles keep their size). Confirming charges the default price per unit, one ledger row each.
 */
const props = defineProps<{ teamId: number; legId: number }>();
const emit = defineEmits<{ close: [] }>();
const race = useRace();
const ui = useUi();
const team = computed(() => race.teamById.get(props.teamId));
const qty = reactive<Record<number, number>>({});
const picked = computed(() => race.shopItems.filter((i) => (qty[i.id] ?? 0) > 0));
const total = computed(() => picked.value.reduce((s, i) => s + i.price * qty[i.id]!, 0));
function toggle(id: number) { if (qty[id]) delete qty[id]; else qty[id] = 1; }
function step(id: number, d: number) { const n = (qty[id] ?? 0) + d; if (n <= 0) delete qty[id]; else qty[id] = n; }
const busy = ref(false);
async function buy() {
  const tm = team.value; if (!tm || !picked.value.length) return;
  const lines = picked.value.map((i) => `${i.name} × ${qty[i.id]}`).join('、');
  if (!(await ui.confirm('商店购买', `「${tm.label}」购买 ${lines}，共扣除 ${fmtMoney(total.value)} ${moneyUnit()}（每件一条记录）\n当前余额 ${fmtMoney(tm.currency)} → ${fmtMoney(tm.currency - total.value)}`))) return;
  busy.value = true;
  let done = 0;
  try {
    for (const it of picked.value) for (let k = 0; k < qty[it.id]!; k++) { await api('/ledger', { method: 'POST', body: { episodeId: race.currentEpisode?.id, teamId: props.teamId, kind: 'shop', itemId: it.id, legId: props.legId } }); done++; }
    ui.toast(`已购买 ${done} 件`);
    emit('close');
  } catch (e) { ui.error(e); if (done) ui.toast(`已购买 ${done} 件，之后的失败`, 'error'); } finally { busy.value = false; await Promise.all([race.loadTeams(), race.loadLedger()]); }
}
</script>

<template>
  <Modal title="商店" small @close="emit('close')">
    <div class="text-sm text-gray mb-2">{{ team?.label }} · 余额 {{ fmtMoney(team?.currency ?? 0) }} {{ moneyUnit() }}</div>
    <div class="shop-grid">
      <div v-for="it in race.shopItems" :key="it.id" class="bag-tile shop-tile" :class="{ on: !!qty[it.id] }" role="button" tabindex="0" @click="toggle(it.id)" @keyup.enter="toggle(it.id)">
        <span class="bag-tile-check"><Icon v-if="qty[it.id]" name="check" size="16" /></span>
        <span class="bag-tile-name">{{ it.name }}</span>
        <span class="bag-tile-count">{{ fmtMoney(it.price) }} {{ moneyUnit() }}</span>
        <span class="shop-qty" :class="{ show: !!qty[it.id] }" @click.stop>
          <button type="button" class="shop-step" :disabled="!qty[it.id]" aria-label="减少" @click="step(it.id, -1)"><Icon name="remove" size="16" /></button>
          <span class="shop-num">{{ qty[it.id] ?? '' }}</span>
          <button type="button" class="shop-step" :disabled="!qty[it.id]" aria-label="增加" @click="step(it.id, 1)"><Icon name="add" size="16" /></button>
        </span>
      </div>
    </div>
    <div class="modal-actions" style="align-items: center">
      <span class="text-sm text-gray" style="margin-right: auto">{{ picked.length ? `共 ${fmtMoney(total)} ${moneyUnit()}` : '点选商品' }}</span>
      <button class="btn btn-text" @click="emit('close')">取消</button>
      <button class="btn" :disabled="!picked.length || busy" @click="buy">购买</button>
    </div>
  </Modal>
</template>
