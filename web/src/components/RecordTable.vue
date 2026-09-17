<script setup lang="ts">
import { computed, ref } from 'vue';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useRecord } from '@/composables/record';
import { fmtTime, fmtTimeSec } from '@/utils/time';
import { endLabel, hasStart, type Leg, type Progress, type Team } from '@/types';
import TeamStatus from './TeamStatus.vue';
import ProgressEditModal from './ProgressEditModal.vue';

const props = defineProps<{ leg: Leg; onlyTeamId?: number }>();
const auth = useAuth();
const race = useRace();
const rec = useRecord();
const editing = ref<{ team: Team; progress: Progress | null } | null>(null);

const rows = computed(() => {
  const list = props.onlyTeamId ? race.teams.filter((t) => t.id === props.onlyTeamId) : race.teams;
  return list.map((team) => ({ team, p: race.progressOf(team.id, props.leg.id), can: race.canRecord(team.id, props.leg.id) && (team.status === 'alive' || auth.isHost), edit: race.canEdit(team.id), block: race.blockReason(team.id, props.leg.id) }));
});
/** 附加信息原地编辑：上一环节完成（本环节开始）后、本环节完成前允许；完成后只能通过“修改记录”弹窗改 */
const inline = (can: boolean, p: Progress | null) => can && !!p?.arrived_at && !p?.completed_at;
const showTarget = computed(() => props.leg.type === 'UT' || props.leg.type === 'YD');
const label = computed(() => endLabel(props.leg.type));
const withStart = computed(() => hasStart(props.leg.type));
const stateOf = (p: Progress | null) => (p?.completed_at ? `已${label.value}` : withStart.value && p?.arrived_at ? '进行中' : withStart.value ? '未开始' : `未${label.value}`);
/** 记录按钮不可用的原因：顺序未到 / 附加信息没填 */
const disabledReason = (p: Progress | null, block: string | null) => block ?? race.extraMissing(props.leg, p);

function detourOptions(): string[] {
  const l = props.leg;
  return [l.detour_a || 'A', l.detour_b || 'B'];
}
</script>

<template>
  <div class="scroll-table">
    <table class="table record-table">
      <thead>
        <tr>
          <th class="col-first">队伍</th><th class="col-status">状态</th>
          <th v-if="withStart" class="col-time">开始</th><th class="col-time">{{ label }}</th>
          <th v-if="showTarget" class="col-extra">施加对象</th>
          <th v-if="leg.type === 'DT'" class="col-extra">绕道选择</th>
          <th v-if="leg.type === 'RB'" class="col-extra">路障完成人</th>
          <th v-if="leg.type === 'FF'" class="col-extra">快进结果</th>
          <th class="col-action">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="{ team, p, can, edit, block } in rows" :key="team.id" :style="team.status !== 'alive' ? 'opacity:.55' : ''">
          <td><strong>{{ team.label }}</strong> <TeamStatus v-if="team.status !== 'alive'" :status="team.status" /></td>
          <td>{{ stateOf(p) }}</td>
          <td v-if="withStart"><span class="record-time">{{ fmtTime(p?.arrived_at) }}</span></td>
          <td><span class="record-time">{{ leg.type === 'PS' ? fmtTimeSec(p?.completed_at) : fmtTime(p?.completed_at) }}</span></td>
          <td v-if="showTarget">
            <select v-if="inline(can, p)" class="input-sm input-inline" style="width: 120px" :value="p?.target_team_id ?? ''" @change="rec.setValue('target', team.id, leg.id, ($event.target as HTMLSelectElement).value)">
              <option value="">未使用</option>
              <option v-for="t in race.teams.filter((x) => x.id !== team.id)" :key="t.id" :value="t.id">{{ t.label }}</option>
            </select>
            <span v-else>{{ p?.target_team_id ? race.teamById.get(p.target_team_id)?.label : '-' }}</span>
          </td>
          <td v-if="leg.type === 'DT'">
            <select v-if="inline(can, p)" class="input-sm input-inline" :value="p?.detour_choice ?? ''" @change="rec.setValue('detour', team.id, leg.id, ($event.target as HTMLSelectElement).value)">
              <option value="">未选</option>
              <option v-for="o in detourOptions()" :key="o" :value="o">{{ o }}</option>
            </select>
            <span v-else>{{ p?.detour_choice || '-' }}</span>
          </td>
          <td v-if="leg.type === 'RB'">
            <select v-if="inline(can, p)" class="input-sm input-inline" style="width: 110px" :value="p?.roadblock_by ?? ''" @change="rec.setValue('roadblock', team.id, leg.id, ($event.target as HTMLSelectElement).value)">
              <option value="">未选</option>
              <option v-for="m in race.memberOptions(team.id, p?.roadblock_by)" :key="m" :value="m">{{ m }}</option>
            </select>
            <span v-else>{{ p?.roadblock_by || '-' }}</span>
          </td>
          <td v-if="leg.type === 'FF'">
            <select v-if="inline(can, p)" class="input-sm input-inline" :value="p?.ff_result ?? ''" @change="rec.setValue('ff', team.id, leg.id, ($event.target as HTMLSelectElement).value)">
              <option value="">未尝试</option><option value="success">成功</option><option value="fail">失败</option>
            </select>
            <span v-else>{{ p?.ff_result === 'success' ? '成功' : p?.ff_result === 'fail' ? '失败' : '-' }}</span>
          </td>
          <td>
            <div class="flex" style="gap: 6px; flex-wrap: nowrap">
              <template v-if="race.episodeFinished">
                <button v-if="edit" class="btn btn-outline btn-sm btn-slot" @click="editing = { team, progress: p }">修改记录</button>
                <span v-else class="text-gray text-sm">已锁定</span>
              </template>
              <template v-else-if="can">
                <button v-if="!p?.completed_at" class="btn btn-sm btn-slot" :disabled="!!disabledReason(p, block)" :title="disabledReason(p, block) ?? ''" @click="rec.complete(team.id, leg.id)">记录{{ label }}</button>
                <button v-else class="btn btn-outline btn-sm btn-slot" @click="editing = { team, progress: p }">修改记录</button>
              </template>
              <template v-else-if="edit && p?.completed_at">
                <button class="btn btn-outline btn-sm btn-slot" @click="editing = { team, progress: p }">修改记录</button>
              </template>
              <span v-if="can && !p?.completed_at && disabledReason(p, block)" class="block-hint" :title="disabledReason(p, block) ?? ''">{{ disabledReason(p, block) }}</span>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <ProgressEditModal v-if="editing" :leg="leg" :team="editing.team" :progress="editing.progress" @close="editing = null" />
</template>
