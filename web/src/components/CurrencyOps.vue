<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtMoney, parseMoney, moneyUnit, moneyLabel, moneyMode } from '@/utils/money';
import { legName } from '@/types';

/**
 * 经费 / 货币操作表单（跟队「我的」页与「经费」页共用）
 * - teamId 固定时不显示队伍选择；否则按权限列出可操作的队伍（主办全部，跟队只有所跟队伍）
 * - 货币模式多一个“类型”：商店购买 / 其他。商店购买时原因栏换成商品下拉，金额固定为价格，只能扣除，且必须选开放商店的环节
 */
const props = defineProps<{ teamId?: number; legId?: number }>(); // legId：固定在某个环节上（站点「我的」页）
const auth = useAuth();
const race = useRace();
const ui = useUi();
const ep = computed(() => race.currentEpisode);
const isCoin = computed(() => moneyMode() === 'coin');
const form = reactive({ teamId: (props.teamId ?? '') as number | '', kind: 'other' as 'other' | 'shop' | 'cutoff', legId: (props.legId ?? '') as number | '', itemId: '' as number | '', amount: '', reason: '' });
const stationOnly = computed(() => race.currencyLegIds !== null); // 站点：必须选自己驻守的环节
watch(() => props.teamId, (v) => { form.teamId = v ?? ''; });

// 淘汰 / 退赛的队伍仍在列表里，但只有管理员能对它们操作（canAdjustCurrencyFor 已包含这条规则）
const teamOptions = computed(() => race.teams.filter((t) => race.canAdjustCurrencyFor(t.id)).map((t) => ({ value: t.id, label: t.status === 'alive' ? t.label : `${t.label}（${t.status === 'withdrawn' ? '已退赛' : '已淘汰'}）` })));
const team = computed(() => (form.teamId === '' ? null : race.teamById.get(Number(form.teamId)) ?? null));
const legs = computed(() => ep.value?.legs ?? []);
const legOptions = computed(() => {
  let list = form.kind === 'shop' ? legs.value.filter((l) => l.shop_open) : legs.value;
  if (race.currencyLegIds) list = list.filter((l) => race.currencyLegIds!.includes(l.id));
  const opts = list.map((l) => ({ value: l.id, label: legName(l) }));
  // “其他”只有主办能选；商店购买必须选具体环节
  return form.kind !== 'shop' && auth.isHost ? [...opts, { value: 0, label: '其他' }] : opts;
});
const kindOptions = computed(() => [
  { value: 'other', label: '其他（非熔断）' },
  ...(isCoin.value && race.shopItems.length ? [{ value: 'shop', label: '商店购买' }] : []),
]);
const item = computed(() => (form.itemId === '' ? null : race.shopItems.find((i) => i.id === Number(form.itemId)) ?? null));
const itemOptions = computed(() => race.shopItems.map((i) => ({ value: i.id, label: `${i.name}（${fmtMoney(i.price)} ${moneyUnit()}）` })));
const canOperate = computed(() => !race.episodePending && (team.value ? race.canAdjustCurrencyFor(team.value.id) : race.canAdjustCurrency));
watch(() => form.kind, () => { form.legId = props.legId ?? ''; form.itemId = ''; form.amount = ''; form.reason = ''; });

async function apply(sign: 1 | -1) {
  const t = team.value;
  if (!t) { ui.toast('请选择队伍', 'error'); return; }
  if (form.kind === 'shop') {
    if (!item.value) { ui.toast('请选择商品', 'error'); return; }
    if (form.legId === '' || form.legId === 0) { ui.toast('请选择开放商店的环节', 'error'); return; }
    const price = item.value.price;
    if (!(await ui.confirm('商店购买', `「${t.label}」购买「${item.value.name}」，扣除 ${fmtMoney(price)} ${moneyUnit()}\n当前余额 ${fmtMoney(t.currency)} → ${fmtMoney(t.currency - price)}`))) return;
    try {
      await api('/ledger', { method: 'POST', body: { episodeId: ep.value?.id, teamId: t.id, kind: 'shop', itemId: item.value.id, legId: form.legId } });
      form.itemId = '';
      await Promise.all([race.loadTeams(), race.loadLedger()]);
      ui.toast(`已购买 ${item.value?.name ?? ''}`);
    } catch (e) { ui.error(e); }
    return;
  }
  if (form.legId === '') { ui.toast(stationOnly.value ? '请选择你驻守的环节' : '请选择环节', 'error'); return; }
  const amount = parseMoney(form.amount);
  if (amount === null) { ui.toast(isCoin.value ? '数量必须是正整数；扣除请用「扣除」按钮' : '金额必须是正数，最多两位小数；扣除请用「扣除」按钮', 'error'); return; }
  const delta = amount * sign;
  const reason = form.reason.trim() || (form.kind === 'cutoff' ? '熔断' : sign > 0 ? '任务奖励' : '手动扣除');
  if (!(await ui.confirm(sign > 0 ? `增加${moneyLabel()}` : `扣除${moneyLabel()}`, `「${t.label}」${sign > 0 ? '增加' : '扣除'} ${fmtMoney(amount)} ${moneyUnit()}，原因：${reason}\n当前余额 ${fmtMoney(t.currency)} → ${fmtMoney(t.currency + delta)}`))) return;
  try {
    await api('/ledger', { method: 'POST', body: { episodeId: ep.value?.id, teamId: t.id, delta, reason: form.kind === 'cutoff' ? form.reason.trim() : reason, kind: form.kind, legId: form.legId === 0 ? null : form.legId } });
    form.amount = ''; form.reason = '';
    await Promise.all([race.loadTeams(), race.loadLedger()]);
    ui.toast(`已${sign > 0 ? '增加' : '扣除'} ${fmtMoney(amount)} ${moneyUnit()}`);
  } catch (e) { ui.error(e); }
}
</script>

<template>
  <div class="card">
    <div class="card-header">
      <span class="flex" style="gap: 12px">
        <span>{{ moneyLabel() }}操作</span>
        <MSelect v-if="props.teamId === undefined && canOperate" v-model="form.teamId" sm style="width: 170px" placeholder="选择队伍" :options="teamOptions" />
        <slot name="title" />
      </span>
      <slot name="header" />
    </div>
    <div v-if="race.episodePending" class="alert alert-warning">赛段尚未开始，开始赛段后才能操作{{ moneyLabel() }}。</div>
    <div v-else-if="race.episodeFinished" class="alert alert-info">赛段已结束，{{ moneyLabel() }}记录已锁定，只有管理员可以修改。</div>
  <div v-else-if="props.teamId !== undefined && race.teamLocked(props.teamId)" class="alert alert-info">{{ race.lockReason(props.teamId) }}</div>
    <div v-else-if="!canOperate" class="text-sm text-gray">主办可操作所有队伍，跟队只能操作所跟队伍，站点只能记在自己驻守的环节上</div>
    <div v-else class="ops">
      <!-- 选择项：类型（货币模式）/ 环节，固定宽度 -->
      <div class="ops-selects">
        <MSelect v-model="form.kind" outlined class="ops-kind" :options="kindOptions" />
        <MSelect v-if="props.legId === undefined" v-model="form.legId" outlined class="ops-leg" :placeholder="form.kind === 'shop' ? '开放商店的环节' : '选择环节'" :options="legOptions" />
      </div>
      <!-- 金额 / 原因（或商品）/ 按钮，槽位不随类型变化 -->
      <div class="ops-main">
        <input v-if="form.kind === 'shop'" :value="item ? fmtMoney(item.price) : ''" class="ops-amount" :placeholder="moneyUnit() === '币' ? '数量' : '金额'" disabled />
        <input v-else v-model="form.amount" type="number" :inputmode="isCoin ? 'numeric' : 'decimal'" min="0" step="1" class="ops-amount" :placeholder="moneyUnit() === '币' ? '数量' : '金额'" />
        <MSelect v-if="form.kind === 'shop'" v-model="form.itemId" outlined class="ops-reason" placeholder="选择商品" :options="itemOptions" />
        <input v-else v-model="form.reason" class="ops-reason" :placeholder="form.kind === 'cutoff' ? '熔断说明（可不填）' : '原因（如：任务奖励、买线索）'" />
        <button class="btn btn-tonal" :disabled="form.kind !== 'other'" :title="form.kind === 'shop' ? '商店购买只能扣除' : form.kind === 'cutoff' ? '熔断只能扣除' : ''" @click="apply(1)"><Icon name="add" size="18" />增加</button>
        <button class="btn btn-tonal btn-tonal-danger" :disabled="form.kind === 'shop' && !item" @click="apply(-1)">扣除</button>
      </div>
    </div>
    <slot />
  </div>
</template>
