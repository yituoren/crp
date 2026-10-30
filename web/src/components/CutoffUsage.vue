<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { fmtTimeSec } from '@/utils/time';
import { type Leg, type Team } from '@/types';
import Modal from './Modal.vue';

/** Bottom of the leg page: per-team use counts and countdowns for each cutoff of this leg; hosts may delete a use */
const props = defineProps<{ leg: Leg }>();
const auth = useAuth();
const race = useRace();
const ui = useUi();
const now = ref(Date.now() + auth.serverOffsetMs);
let timer: number | undefined;
onMounted(() => { timer = window.setInterval(() => { now.value = Date.now() + auth.serverOffsetMs; }, 1000); });
onUnmounted(() => clearInterval(timer));
const editing = ref<Team | null>(null);

const fmtCountdown = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? `${h}:` : '') + `${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; };
function cellText(teamId: number, cf: Leg['cutoffs'][number]) {
  const used = race.cutoffUseCount(teamId, cf.id);
  const ready = race.cutoffReadyAt(teamId, props.leg, cf);
  if (ready === null) return `${used} 次`;
  const remain = ready - now.value;
  return `${used} 次 · ${remain <= 0 ? '可用' : fmtCountdown(remain)}`;
}
const usesOf = computed(() => (teamId: number) => race.cutoffUses.filter((u) => u.leg_id === props.leg.id && u.team_id === teamId));
async function removeUse(id: number) {
  if (!(await ui.confirm('删除使用记录', '删除这次熔断使用？若扣过币会一并退回，倒计时按剩余记录重新计算。', { danger: true, okText: '删除' }))) return;
  try { await api(`/cutoff-uses/${id}`, { method: 'DELETE' }); await Promise.all([race.loadProgress(), race.loadTeams(), race.loadLedger()]); ui.toast('已删除'); } catch (e) { ui.error(e); }
}
</script>

<template>
  <div v-if="leg.cutoffs.length" class="card">
    <div class="card-header"><span>熔断使用情况</span></div>
    <div class="scroll-table">
      <table v-mobile-table class="table table-dense">
        <thead><tr><th>队伍</th><th v-for="cf in leg.cutoffs" :key="cf.id" class="c">{{ cf.name }}</th><th v-if="auth.isHost" class="c">操作</th></tr></thead>
        <tbody>
          <tr v-for="t in race.teams" :key="t.id">
            <td><strong>{{ t.label }}</strong></td>
            <td v-for="cf in leg.cutoffs" :key="cf.id" class="c">{{ cellText(t.id, cf) }}</td>
            <td v-if="auth.isHost" class="c"><button class="btn btn-text btn-sm btn-slot" @click="editing = t">修改记录</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
  <Modal v-if="editing" :title="`熔断记录 · ${editing.label}`" small @close="editing = null">
    <div v-if="!usesOf(editing.id).length" class="empty-rows">暂无记录</div>
    <table v-else class="table table-dense">
      <thead><tr><th>时间</th><th>种类</th><th>操作人</th><th class="c"></th></tr></thead>
      <tbody>
        <tr v-for="u in usesOf(editing.id)" :key="u.id">
          <td>{{ fmtTimeSec(u.used_at) }}</td><td>{{ u.cutoff_name }}</td><td>{{ u.used_by_name }}</td>
          <td class="c"><button class="btn btn-text btn-text-danger btn-sm" :disabled="race.episodeFinished || race.teamLocked(editing.id)" @click="removeUse(u.id)"><Icon name="delete" size="16" />删除</button></td>
        </tr>
      </tbody>
    </table>
    <div class="modal-actions"><button class="btn btn-text" @click="editing = null">关闭</button></div>
  </Modal>
</template>
