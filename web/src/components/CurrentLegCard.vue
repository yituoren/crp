<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtMoney, moneyMode, moneyUnit, parseMoney } from '@/utils/money';
import { legName, type Leg } from '@/types';
import LegTag from './LegTag.vue';
import CutoffCard from './CutoffCard.vue';
import ShopModal from './ShopModal.vue';

/**
 * 跟队「我的」页的「当前环节」卡：按所跟队伍正在进行的环节给出可做的操作。
 *  - 标题行：左边「当前环节」+ 环节标签；右边「商店」按钮（环节开放商店且货币比赛时出现），点开是商品选项卡弹窗
 *  - 交通（路线信息）：单车 / 打车 / 地铁 / 公交 四选一，右侧消费输入框固定存在，确认直接扣费记流水；货币比赛里单车、打车要用背包里的对应卡片，此时不用填金额
 *  - 熔断（环节配置了熔断）：与原来的本队熔断一样
 * 交通与熔断都没有时显示「暂无操作」
 */
const props = defineProps<{ teamId: number }>();
const race = useRace();
const ui = useUi();
const team = computed(() => race.teamById.get(props.teamId));
const isCoin = computed(() => moneyMode() === 'coin');
/** 正在进行的环节：有开始没结束的里最靠后的一个（支线进行中就是支线） */
const currentLeg = computed<Leg | null>(() => {
  const legs = race.currentEpisode?.legs ?? [];
  let cur: Leg | null = null;
  for (const l of legs) { const p = race.progressOf(props.teamId, l.id); if (p?.arrived_at && !p.completed_at) cur = l; }
  return cur;
});
const canUse = computed(() => race.canAdjustCurrencyFor(props.teamId) && !race.episodePending);
const showTransport = computed(() => currentLeg.value?.type === 'RI');
const showShop = computed(() => isCoin.value && !!currentLeg.value?.shop_open && race.shopItems.length > 0);
const showCutoff = computed(() => (race.currentEpisode?.legs ?? []).some((l) => { const p = race.progressOf(props.teamId, l.id); return !!p?.arrived_at && !p.completed_at && l.cutoffs.length > 0; }));
const nothing = computed(() => !showTransport.value && !showCutoff.value);

// ---- 交通 ----
const TRANSPORT = ['单车', '打车', '地铁', '公交'] as const;
type Transport = (typeof TRANSPORT)[number];
const transport = ref<Transport | ''>('');
const fare = ref('');
/** 货币比赛里单车 / 打车要有对应卡片：背包里名字含“单车”/“打车”的物品 */
function cardFor(t: Transport) { return isCoin.value && (t === '单车' || t === '打车') ? (team.value?.inventory ?? []).find((i) => i.name.includes(t)) ?? null : null; }
const needsCard = (t: Transport) => isCoin.value && (t === '单车' || t === '打车');
const transportDisabled = (t: Transport) => !canUse.value || (needsCard(t) && !cardFor(t));
/** 货币比赛：地铁固定 3 币、公交固定 2 币，不能改；单车、打车用卡片。经费比赛：都填实际消费 */
const FIXED_FARE: Partial<Record<Transport, number>> = { 地铁: 3, 公交: 2 };
const fixedFare = computed(() => (isCoin.value && transport.value ? FIXED_FARE[transport.value] ?? null : null));
/** 金额框一直在（布局不跳）：用卡片或固定票价时置灰 */
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
      await api('/ledger', { method: 'POST', body: { episodeId: race.currentEpisode?.id, teamId: tm.id, kind: 'use', itemName: card.name, legId: leg.id } });
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
      <!-- 交通 -->
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
      <!-- 熔断 -->
      <div v-if="showCutoff" class="cl-section">
        <div class="cl-label">熔断</div>
        <CutoffCard :team-id="teamId" plain />
      </div>
    </template>
  </div>
  <ShopModal v-if="shopOpen && currentLeg" :team-id="teamId" :leg-id="currentLeg.id" @close="shopOpen = false" />
</template>
