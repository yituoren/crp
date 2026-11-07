<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtMoney, moneyMode, moneyUnit, parseMoney } from '@/utils/money';
import { legName, type Leg } from '@/types';
import { fmtTime } from '@/utils/time';
import LegTag from './LegTag.vue';
import CutoffCard from './CutoffCard.vue';
import ShopModal from './ShopModal.vue';

/**
 * "Current leg" card on the follow's "Mine" page: offers the actions for the leg the team is on.
 *  - header: "current leg" + leg tag on the left; a "shop" button on the right (shop-open leg in coin mode) opening the item dialog
 *  - transport (Route Info): bike / taxi / subway / bus, single choice; the fare input is always present; confirm deducts and logs it.
 *    In coin mode bike and taxi use the matching bag card and need no amount
 *  - cutoffs (when the leg has any): same as the former team cutoff card
 * Shows "nothing to do" when neither transport nor cutoffs apply
 */
const props = defineProps<{ teamId: number }>();
const race = useRace();
const ui = useUi();
const team = computed(() => race.teamById.get(props.teamId));
const isCoin = computed(() => moneyMode() === 'coin');
/** The leg in progress: the furthest one with a start and no end (a running side quest counts) */
const currentLeg = computed<Leg | null>(() => {
  const legs = race.currentEpisode?.legs ?? [];
  let cur: Leg | null = null;
  for (const l of legs) { const p = race.progressOf(props.teamId, l.id); if (p?.arrived_at && !p.completed_at) cur = l; }
  return cur;
});
const canUse = computed(() => race.canAdjustCurrencyFor(props.teamId) && !race.episodePending);
const showTransport = computed(() => currentLeg.value?.type === 'RI');
const showShop = computed(() => isCoin.value && (currentLeg.value?.shop.length ?? 0) > 0);
const showCutoff = computed(() => (race.currentEpisode?.legs ?? []).some((l) => { const p = race.progressOf(props.teamId, l.id); return !!p?.arrived_at && !p.completed_at && l.cutoffs.length > 0; }));
// Waiting because of a twist card (missile): when it ends
const waitUntil = computed(() => (currentLeg.value ? race.waitingUntil(props.teamId, currentLeg.value.id) : null));
const waitEffect = computed(() => (currentLeg.value ? race.effectOn(props.teamId, currentLeg.value.id) : null));
const uturn = computed(() => (currentLeg.value ? race.uturnOn(props.teamId, currentLeg.value.id) : null));
const nothing = computed(() => !showTransport.value && !showCutoff.value && !waitUntil.value && !(uturn.value && !race.progressOf(props.teamId, currentLeg.value!.id)?.completed_at));

// ---- Transport ----
const TRANSPORT = ['单车', '打车', '地铁', '公交'] as const;
type Transport = (typeof TRANSPORT)[number];
const transport = ref<Transport | ''>('');
const fare = ref('');
/** In coin mode bike / taxi need a matching card: a bag item whose name contains 单车 / 打车 */
function cardFor(t: Transport) { return isCoin.value && (t === '单车' || t === '打车') ? (team.value?.inventory ?? []).find((i) => i.name.includes(t)) ?? null : null; }
const needsCard = (t: Transport) => isCoin.value && (t === '单车' || t === '打车');
const transportDisabled = (t: Transport) => !canUse.value || (needsCard(t) && !cardFor(t));
/** Coin mode: subway costs 3, bus costs 2, fixed; bike and taxi use cards. Cash mode: enter the actual fare */
const FIXED_FARE: Partial<Record<Transport, number>> = { 地铁: 3, 公交: 2 };
const fixedFare = computed(() => (isCoin.value && transport.value ? FIXED_FARE[transport.value] ?? null : null));
/** The fare input always stays (no layout jump) and is disabled for card use or fixed fares */
const fareOff = computed(() => transport.value === '' || needsCard(transport.value) || fixedFare.value !== null);
watch(fixedFare, (v) => { if (v !== null) fare.value = String(v); else if (transport.value && needsCard(transport.value)) fare.value = ''; });
const shopOpen = ref(false);
watch(currentLeg, () => { transport.value = ''; fare.value = ''; shopOpen.value = false; });
async function confirmTransport() {
  const t = transport.value; const tm = team.value; const leg = currentLeg.value;
  if (!t || !tm || !leg) return;
  if (needsCard(t)) {
    const card = cardFor(t); if (!card) return;
    if (!(await ui.confirm('使用卡片', `「${tm.label}」${t}，使用背包里的「${card.name}」。`))) return;
    try {
      await api('/items/use', { method: 'POST', body: { episodeId: race.currentEpisode?.id, teamId: tm.id, itemName: card.name, legId: leg.id } });
      transport.value = '';
      await Promise.all([race.loadTeams(), race.loadLedger()]);
      ui.toast(`已使用 ${card.name}`);
    } catch (e) { ui.error(e); }
    return;
  }
  const amount = fixedFare.value ?? parseMoney(fare.value);
  if (amount === null) { ui.toast(isCoin.value ? '消费必须是正整数' : '消费必须是正数，最多两位小数', 'error'); return; }
  if (!(await ui.confirm('交通消费', `「${tm.label}」${t}，扣除 ${fmtMoney(amount)} ${moneyUnit()}\n当前余额 ${fmtMoney(tm.currency)} → ${fmtMoney(tm.currency - amount)}`))) return;
  try {
    await api('/ledger', { method: 'POST', body: { episodeId: race.currentEpisode?.id, teamId: tm.id, delta: -amount, reason: `交通：${t}`, kind: 'other', legId: leg.id } });
    transport.value = ''; fare.value = '';
    await Promise.all([race.loadTeams(), race.loadLedger()]);
    ui.toast(`已扣除 ${fmtMoney(amount)} ${moneyUnit()}`);
  } catch (e) { ui.error(e); }
}
</script>

<template>
  <div class="card">
    <div class="card-header">
      <span class="cl-title">当前环节<span v-if="currentLeg" class="cl-leg"><LegTag :type="currentLeg.type" /> {{ legName(currentLeg) }}</span></span>
      <button v-if="showShop" class="btn btn-tonal btn-sm" :disabled="!canUse" @click="shopOpen = true"><Icon name="storefront" size="18" />商店</button>
    </div>
    <div v-if="nothing" class="empty-rows">暂无操作</div>
    <template v-else>
      <div v-if="uturn" class="alert alert-warning">被{{ uturn.source_name }}的「{{ uturn.item_name }}」作用：完成绕道的另一个分支（{{ uturn.note }}）后，在本环节重新记录完成</div>
      <div v-if="waitUntil" class="alert alert-warning">
        被{{ waitEffect?.source_name }}的「{{ waitEffect?.item_name }}」作用，原地等待到 {{ fmtTime(waitUntil) }}，之前不能记录
        <!-- the same choice as in the pop-up, for whoever records this team -->
        <div v-if="waitEffect && (waitEffect.options.shield || waitEffect.options.reflect)" class="popup-answer">
          <span class="text-sm">背包里有可用的卡，是否使用？</span>
          <button v-if="waitEffect.options.shield" class="btn btn-tonal btn-sm" @click="race.answerTwist(waitEffect.id, 'shield')">使用护盾</button>
          <button v-if="waitEffect.options.reflect" class="btn btn-tonal btn-sm" @click="race.answerTwist(waitEffect.id, 'reflect')">使用反弹</button>
          <button class="btn btn-text btn-sm" @click="race.answerTwist(waitEffect.id, 'accept')">不使用</button>
        </div>
      </div>
      <!-- Transport -->
      <div v-if="showTransport" class="cl-section">
        <div class="cl-label">交通</div>
        <div class="cl-row">
          <div class="cl-tiles">
            <button v-for="t in TRANSPORT" :key="t" type="button" class="bag-tile cl-tile" :class="{ on: transport === t, off: transportDisabled(t) }" :disabled="transportDisabled(t)" :title="needsCard(t) && !cardFor(t) ? '背包里没有对应卡片' : ''" @click="transport = t">
              <span class="bag-tile-name">{{ t }}</span>
            </button>
          </div>
          <input v-model="fare" type="number" :inputmode="isCoin ? 'numeric' : 'decimal'" min="0" step="1" class="cl-amount" :placeholder="transport && needsCard(transport) ? '用卡片' : `消费（${moneyUnit()}）`" :disabled="fareOff" />
          <button class="btn btn-sm cl-confirm" :disabled="!transport || !canUse" @click="confirmTransport">确认</button>
        </div>
      </div>
      <!-- Cutoffs -->
      <div v-if="showCutoff" class="cl-section">
        <div class="cl-label">熔断</div>
        <CutoffCard :team-id="teamId" plain />
      </div>
    </template>
  </div>
  <ShopModal v-if="shopOpen && currentLeg" :team-id="teamId" :leg-id="currentLeg.id" @close="shopOpen = false" />
</template>
