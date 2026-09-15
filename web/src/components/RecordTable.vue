<script setup lang="ts">
import { computed, ref } from 'vue';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useRecord } from '@/composables/record';
import { fmtTime, fmtTimeSec } from '@/utils/time';
import { singleLabel, type Leg, type Progress, type Team } from '@/types';
import TeamStatus from './TeamStatus.vue';
import ProgressEditModal from './ProgressEditModal.vue';

const props = defineProps<{ leg: Leg; onlyTeamId?: number }>();
const auth = useAuth();
const race = useRace();
const rec = useRecord();
const editing = ref<{ team: Team; progress: Progress | null } | null>(null);

const rows = computed(() => {
  const list = props.onlyTeamId ? race.teams.filter((t) => t.id === props.onlyTeamId) : race.teams;
  return list.map((team) => ({ team, p: race.progressOf(team.id, props.leg.id), can: race.canRecord(team.id, props.leg.id) && (team.status === 'alive' || auth.isHost), block: race.blockReason(team.id, props.leg.id) }));
});
const isSingle = computed(() => props.leg.record_mode === 'single');
const isNone = computed(() => props.leg.record_mode === 'none');
const showTarget = computed(() => props.leg.type === 'UT' || props.leg.type === 'YD');
const label = computed(() => singleLabel(props.leg.type));
const stateOf = (p: Progress | null) => (isSingle.value ? (p?.completed_at ? `已${label.value}` : `未${label.value}`) : p?.completed_at ? '已完成' : p?.arrived_at ? '进行中' : '未开始');

function detourOptions(): string[] {
  const l = props.leg;
  return [l.detour_a || 'A', l.detour_b || 'B'];
}
</script>

<template>
  <div v-if="isNone" class="alert alert-info">本环节不记录时间。</div>
  <div v-else class="scroll-table">
    <table class="table record-table">
      <thead>
        <tr>
          <th class="col-first">队伍</th><th class="col-status">状态</th>
          <template v-if="isSingle"><th class="col-time">{{ label }}时间</th></template>
          <template v-else><th class="col-time">开始</th><th class="col-time">{{ leg.type === 'Shuffle' ? '出发' : '完成' }}</th></template>
          <th v-if="showTarget" class="col-extra">施加对象</th>
          <th v-if="leg.type === 'DT'" class="col-extra">绕道选择</th>
          <th v-if="leg.type === 'RB'" class="col-extra">路障完成人</th>
          <th v-if="leg.type === 'FF'" class="col-extra">快进结果</th>
          <th class="col-action">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="{ team, p, can, block } in rows" :key="team.id" :style="team.status !== 'alive' ? 'opacity:.55' : ''">
          <td><strong>{{ team.label }}</strong> <TeamStatus v-if="team.status !== 'alive'" :status="team.status" /></td>
          <td>{{ stateOf(p) }}</td>
          <template v-if="isSingle"><td><span class="record-time">{{ leg.type === 'PS' ? fmtTimeSec(p?.completed_at) : fmtTime(p?.completed_at) }}</span></td></template>
          <template v-else>
            <td><span class="record-time">{{ fmtTime(p?.arrived_at) }}</span></td>
            <td><span class="record-time">{{ fmtTime(p?.completed_at) }}</span></td>
          </template>
          <td v-if="showTarget">
            <select v-if="can" class="input-sm input-inline" style="width: 120px" :value="p?.target_team_id ?? ''" @change="rec.setValue('target', team.id, leg.id, ($event.target as HTMLSelectElement).value)">
              <option value="">未使用</option>
              <option v-for="t in race.teams.filter((x) => x.id !== team.id)" :key="t.id" :value="t.id">{{ t.label }}</option>
            </select>
            <span v-else>{{ p?.target_team_id ? race.teamById.get(p.target_team_id)?.label : '-' }}</span>
          </td>
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
          <td v-if="leg.type === 'FF'">
            <select v-if="can" class="input-sm input-inline" :value="p?.ff_result ?? ''" @change="rec.setValue('ff', team.id, leg.id, ($event.target as HTMLSelectElement).value)">
              <option value="">未尝试</option><option value="success">成功</option><option value="fail">失败</option>
            </select>
            <span v-else>{{ p?.ff_result === 'success' ? '成功' : p?.ff_result === 'fail' ? '失败' : '-' }}</span>
          </td>
          <td>
            <div class="flex" style="gap: 6px; flex-wrap: nowrap">
              <template v-if="can && isSingle">
                <button v-if="!p?.completed_at" class="btn btn-sm btn-slot" :disabled="!!block" :title="block ?? ''" @click="rec.single(team.id, leg.id, label)">记录{{ label }}</button>
                <button v-else class="btn btn-outline btn-sm btn-slot" @click="editing = { team, progress: p }">修改时间</button>
              </template>
              <template v-else-if="can">
                <button v-if="!p?.arrived_at" class="btn btn-sm btn-slot" :disabled="!!block" :title="block ?? ''" @click="rec.arrive(team.id, leg.id)">记录开始</button>
                <button v-else-if="!p?.completed_at" class="btn btn-success btn-sm btn-slot" :disabled="!!race.extraMissing(leg, p)" :title="race.extraMissing(leg, p) ?? ''" @click="rec.complete(team.id, leg.id)">{{ leg.type === 'Shuffle' ? '记录出发' : '记录完成' }}</button>
                <button v-else class="btn btn-outline btn-sm btn-slot" @click="editing = { team, progress: p }">修改时间</button>
              </template>
              <template v-else-if="auth.isHost && p?.completed_at">
                <button class="btn btn-outline btn-sm btn-slot" @click="editing = { team, progress: p }">修改时间</button>
              </template>
              <span v-if="can && block && !p?.arrived_at" class="block-hint" :title="block">{{ block }}</span>
              <span v-else-if="can && p?.arrived_at && !p?.completed_at && race.extraMissing(leg, p)" class="block-hint">{{ race.extraMissing(leg, p) }}</span>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <ProgressEditModal v-if="editing" :leg="leg" :team="editing.team" :progress="editing.progress" @close="editing = null" />
</template>
