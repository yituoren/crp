<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtMoney, moneyMode, moneyUnit } from '@/utils/money';
import { legName, type Leg } from '@/types';

/** 跟队「我的」页：所跟队伍当前环节可用的熔断。未就绪显示倒计时，就绪可点击使用（货币模式显示消耗） */
const props = withDefaults(defineProps<{ teamId: number; plain?: boolean }>(), { plain: false });
const auth = useAuth();
const race = useRace();
const ui = useUi();
const now = ref(Date.now() + auth.serverOffsetMs);
let timer: number | undefined;
onMounted(() => { timer = window.setInterval(() => { now.value = Date.now() + auth.serverOffsetMs; }, 1000); });
onUnmounted(() => clearInterval(timer));

/** 当前进行中的环节（含支线）：有开始没结束的，取最靠后的 */
const currentLegs = computed<Leg[]>(() => {
  const ep = race.currentEpisode; if (!ep) return [];
  return ep.legs.filter((l) => { const p = race.progressOf(props.teamId, l.id); return !!p?.arrived_at && !p.completed_at && l.cutoffs.length > 0; });
});
const canUse = computed(() => !race.episodePending && !race.episodeFinished && !race.teamLocked(props.teamId) && race.canRecord(props.teamId, 0));
const fmtCountdown = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? `${h}:` : '') + `${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; };
function rows(leg: Leg) {
  return leg.cutoffs.map((cf) => {
    const ready = race.cutoffReadyAt(props.teamId, leg, cf);
    const remain = ready === null ? 0 : ready - now.value;
    return { cf, used: race.cutoffUseCount(props.teamId, cf.id), remain, ready: remain <= 0, cost: moneyMode() === 'coin' && cf.cost > 0 ? cf.cost : 0 };
  });
}
async function use(leg: Leg, cf: Leg['cutoffs'][number], cost: number) {
  const team = race.teamById.get(props.teamId)?.label ?? '';
  if (!(await ui.confirm('使用熔断', `「${team}」在「${legName(leg)}」使用熔断「${cf.name}」${cost ? `，消耗 ${fmtMoney(cost)} ${moneyUnit()}` : ''}。使用后立即开始下一次倒计时。`))) return;
  try {
    await api(`/cutoffs/${cf.id}/use`, { method: 'POST', body: { teamId: props.teamId } });
    await Promise.all([race.loadProgress(), race.loadTeams(), race.loadLedger()]);
    ui.toast(`已使用熔断：${cf.name}`);
  } catch (e) { ui.error(e); }
}
</script>

<template>
  <div :class="plain ? '' : 'card'">
    <div v-if="!plain" class="card-header"><span>本队熔断</span></div>
    <div v-if="!currentLegs.length" class="empty-rows">当前环节暂无可用熔断</div>
    <div v-for="leg in currentLegs" :key="leg.id" class="cutoff-group">
      <div class="text-sm text-gray mb-1"><LegTag :type="leg.type" /> {{ legName(leg) }}</div>
      <div v-for="r in rows(leg)" :key="r.cf.id" class="cutoff-row">
        <div class="cutoff-info">
          <strong>{{ r.cf.name }}</strong>
          <span class="text-xs text-gray">已用 {{ r.used }} 次 · 间隔 {{ r.cf.interval_min }} 分钟</span>
        </div>
        <button v-if="r.ready" class="btn btn-tonal btn-sm btn-slot" :disabled="!canUse" @click="use(leg, r.cf, r.cost)">使用{{ r.cost ? ` · ${fmtMoney(r.cost)} ${moneyUnit()}` : '' }}</button>
        <button v-else class="btn btn-tonal btn-sm btn-slot cutoff-wait" disabled>{{ fmtCountdown(r.remain) }}</button>
      </div>
    </div>
  </div>
</template>
