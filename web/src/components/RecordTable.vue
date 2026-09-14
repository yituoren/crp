<script setup lang="ts">
import { computed, ref } from 'vue';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useRecord } from '@/composables/record';
import { fmtTime } from '@/utils/time';
import type { Leg, Progress, Team } from '@/types';
import TeamStatus from './TeamStatus.vue';
import ProgressEditModal from './ProgressEditModal.vue';

const props = defineProps<{ leg: Leg; onlyTeamId?: number }>();
const auth = useAuth();
const race = useRace();
const rec = useRecord();
const editing = ref<{ team: Team; progress: Progress | null } | null>(null);

const rows = computed(() => {
  const list = props.onlyTeamId ? race.teams.filter((t) => t.id === props.onlyTeamId) : race.teams;
  return list.map((team) => ({ team, p: race.progressOf(team.id, props.leg.id), can: race.canRecord(team.id, props.leg.id) && (team.status === 'alive' || auth.isHost) }));
});
const stateOf = (p: Progress | null) => (p?.completed_at ? '✅ 已完成' : p?.arrived_at ? '⏳ 已到达' : '⏹ 未到达');

function detourOptions(): string[] {
  const l = props.leg;
  return [l.detour_a || 'A', l.detour_b || 'B'];
}
</script>

<template>
  <div class="scroll-table">
    <table class="table">
      <thead>
        <tr>
          <th>队伍</th><th>状态</th><th>到达</th><th>完成</th>
          <th v-if="leg.type === 'DT'">绕道选择</th>
          <th v-if="leg.type === 'RB'">路障完成人</th>
          <th v-if="leg.type === 'FO'">快进结果</th>
          <th style="min-width: 150px">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="{ team, p, can } in rows" :key="team.id" :style="team.status !== 'alive' ? 'opacity:.55' : ''">
          <td><strong>{{ team.name }}</strong> <TeamStatus v-if="team.status !== 'alive'" :status="team.status" /></td>
          <td>{{ stateOf(p) }}</td>
          <td><span class="record-time">{{ fmtTime(p?.arrived_at) }}</span></td>
          <td><span class="record-time">{{ fmtTime(p?.completed_at) }}</span></td>
          <td v-if="leg.type === 'DT'">
            <select v-if="can" class="input-sm input-inline" :value="p?.detour_choice ?? ''" @change="rec.setValue('detour', team.id, leg.id, ($event.target as HTMLSelectElement).value)">
              <option value="">未选</option>
              <option v-for="o in detourOptions()" :key="o" :value="o">{{ o }}</option>
            </select>
            <span v-else>{{ p?.detour_choice || '-' }}</span>
          </td>
          <td v-if="leg.type === 'RB'">
            <input v-if="can" class="input-sm input-inline" style="width: 110px" :value="p?.roadblock_by ?? ''" placeholder="姓名" @change="rec.setValue('roadblock', team.id, leg.id, ($event.target as HTMLInputElement).value)" />
            <span v-else>{{ p?.roadblock_by || '-' }}</span>
          </td>
          <td v-if="leg.type === 'FO'">
            <select v-if="can" class="input-sm input-inline" :value="p?.ff_result ?? ''" @change="rec.setValue('ff', team.id, leg.id, ($event.target as HTMLSelectElement).value)">
              <option value="">未尝试</option><option value="success">成功</option><option value="fail">失败</option>
            </select>
            <span v-else>{{ p?.ff_result === 'success' ? '成功' : p?.ff_result === 'fail' ? '失败' : '-' }}</span>
          </td>
          <td>
            <div class="flex" style="gap: 6px; flex-wrap: nowrap">
              <template v-if="can">
                <button v-if="!p?.arrived_at" class="btn btn-sm" @click="rec.arrive(team.id, leg.id)">记录到达</button>
                <button v-else-if="!p?.completed_at" class="btn btn-success btn-sm" @click="rec.complete(team.id, leg.id)">记录完成</button>
                <span v-else class="text-success text-sm">✔</span>
              </template>
              <button v-if="auth.isHost" class="btn btn-outline btn-sm" @click="editing = { team, progress: p }">修改</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <ProgressEditModal v-if="editing" :leg="leg" :team="editing.team" :progress="editing.progress" @close="editing = null" />
</template>
