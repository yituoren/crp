<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from '@/api';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtMoney, moneyMode, moneyUnit, parseMoney } from '@/utils/money';
import { legName, type Leg } from '@/types';
import LegTag from './LegTag.vue';
import CutoffCard from './CutoffCard.vue';

/**
 * 跟队「我的」页的「当前环节」卡：按所跟队伍正在进行的环节给出可做的操作，从上到下用横线隔开：
 *  - 交通（路线信息）：单车 / 打车 / 地铁 / 公交 四选一，填消费后确认直接扣费记流水；货币比赛里单车、打车要用背包里的对应卡片
 *  - 商店（环节开放商店且货币比赛）：选商品、填数量直接购买，一次买多个分多条流水
 *  - 熔断（环节配置了熔断）：与原来的本队熔断一样
 * 三样都没有时显示「暂无操作」
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
const nothing = computed(() => !showTransport.value && !showShop.value && !showCutoff.value);

// ---- 交通 ----
const TRANSPORT = ['单车', '打车', '地铁', '公交'] as const;
type Transport = (typeof TRANSPORT)[number];
const transport = ref<Transport | ''>('');
const fare = ref('');
/** 货币比赛里单车 / 打车要有对应卡片：背包里名字含“单车”/“打车”的物品 */
function cardFor(t: Transport) { return isCoin.value && (t === '单车' || t === '打车') ? (team.value?.inventory ?? []).find((i) => i.name.includes(t)) ?? null : null; }
const needsCard = (t: Transport) => isCoin.value && (t === '单车' || t === '打车');
const transportDisabled = (t: Transport) => !canUse.value || (needsCard(t) && !cardFor(t));
const fareNeeded = computed(() => transport.value !== '' && !needsCard(transport.value));
watch(currentLeg, () => { transport.value = ''; fare.value = ''; shopItem.value = ''; qty.value = 1; });
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
  const amount = parseMoney(fare.value);
  if (amount === null) { ui.toast(isCoin.value ? '消费必须是正整数' : '消费必须是正数，最多两位小数', 'error'); return; }
  if (!(await ui.confirm('交通消费', `「${tm.label}」${t}，扣除 ${fmtMoney(amount)} ${moneyUnit()}\n当前余额 ${fmtMoney(tm.currency)} → ${fmtMoney(tm.currency - amount)}`))) return;
  try {
    await api('/ledger', { method: 'POST', body: { episodeId: race.currentEpisode?.id, teamId: tm.id, delta: -amount, reason: `交通：${t}`, kind: 'other', legId: leg.id } });
    transport.value = ''; fare.value = '';
    await Promise.all([race.loadTeams(), race.loadLedger()]);
    ui.toast(`已扣除 ${fmtMoney(amount)} ${moneyUnit()}`);
  } catch (e) { ui.error(e); }
}

// ---- 商店 ----
const shopItem = ref<number | ''>('');
const qty = ref(1);
const chosen = computed(() => (shopItem.value === '' ? null : race.shopItems.find((i) => i.id === shopItem.value) ?? null));
const buying = ref(false);
async function confirmBuy() {
  const it = chosen.value; const tm = team.value; const leg = currentLeg.value;
  if (!it || !tm || !leg) return;
  const n = Math.floor(Number(qty.value));
  if (!(n >= 1)) { ui.toast('数量必须是正整数', 'error'); return; }
  const total = it.price * n;
  if (!(await ui.confirm('商店购买', `「${tm.label}」购买「${it.name}」× ${n}，共扣除 ${fmtMoney(total)} ${moneyUnit()}（每件一条记录）\n当前余额 ${fmtMoney(tm.currency)} → ${fmtMoney(tm.currency - total)}`))) return;
  buying.value = true;
  let done = 0;
  try {
    for (let i = 0; i < n; i++) { await api('/ledger', { method: 'POST', body: { episodeId: race.currentEpisode?.id, teamId: tm.id, kind: 'shop', itemId: it.id, legId: leg.id } }); done++; }
    shopItem.value = ''; qty.value = 1;
    ui.toast(`已购买 ${it.name} × ${done}`);
  } catch (e) { ui.error(e); if (done) ui.toast(`已购买 ${done} 件，之后的失败`, 'error'); } finally { buying.value = false; await Promise.all([race.loadTeams(), race.loadLedger()]); }
}
</script>

<template>
  <div class="card">
    <div class="card-header"><span>当前环节</span><span v-if="currentLeg" class="text-sm text-gray"><LegTag :type="currentLeg.type" /> {{ legName(currentLeg) }}</span></div>
    <div v-if="nothing" class="empty-rows">暂无操作</div>
    <template v-else>
      <!-- 交通 -->
      <div v-if="showTransport" class="cl-section">
        <div class="cl-label">交通</div>
        <div class="cl-row">
          <div class="cl-tiles">
            <button v-for="t in TRANSPORT" :key="t" type="button" class="bag-tile cl-tile" :class="{ on: transport === t, off: transportDisabled(t) }" :disabled="transportDisabled(t)" :title="needsCard(t) && !cardFor(t) ? '背包里没有对应卡片' : ''" @click="transport = t">
              <span class="bag-tile-name">{{ t }}</span>
              <span v-if="needsCard(t)" class="bag-tile-count">{{ cardFor(t) ? '卡' : '无卡' }}</span>
            </button>
          </div>
          <input v-if="fareNeeded" v-model="fare" type="number" :inputmode="isCoin ? 'numeric' : 'decimal'" min="0" step="1" class="cl-amount" :placeholder="`消费（${moneyUnit()}）`" />
          <button class="btn btn-sm cl-confirm" :disabled="!transport || !canUse" @click="confirmTransport">确认</button>
        </div>
      </div>
      <!-- 商店 -->
      <div v-if="showShop" class="cl-section">
        <div class="cl-label">商店</div>
        <div class="cl-row">
          <div class="cl-tiles">
            <button v-for="it in race.shopItems" :key="it.id" type="button" class="bag-tile cl-tile" :class="{ on: shopItem === it.id, off: !canUse }" :disabled="!canUse" @click="shopItem = it.id">
              <span class="bag-tile-name">{{ it.name }}</span><span class="bag-tile-count">{{ fmtMoney(it.price) }} {{ moneyUnit() }}</span>
            </button>
          </div>
          <input v-model.number="qty" type="number" inputmode="numeric" min="1" step="1" class="cl-amount" placeholder="数量" />
          <button class="btn btn-sm cl-confirm" :disabled="!chosen || !canUse || buying" @click="confirmBuy">确认</button>
        </div>
      </div>
      <!-- 熔断 -->
      <div v-if="showCutoff" class="cl-section">
        <div class="cl-label">熔断</div>
        <CutoffCard :team-id="teamId" plain />
      </div>
    </template>
  </div>
</template>
