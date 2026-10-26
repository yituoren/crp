<script setup lang="ts">
import { computed, ref } from 'vue';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useRecord } from '@/composables/record';
import { fmtTime, fmtTimeSec } from '@/utils/time';
import { endLabel, startLabel, hasStart, type Leg, type Progress, type Team } from '@/types';
import TeamStatus from './TeamStatus.vue';
import ProgressEditModal from './ProgressEditModal.vue';

const props = defineProps<{ leg: Leg; onlyTeamId?: number }>();
const auth = useAuth();
const race = useRace();
const rec = useRecord();
const editing = ref<{ team: Team; progress: Progress | null } | null>(null);

const rows = computed(() => {
  const list = props.onlyTeamId ? race.teams.filter((t) => t.id === props.onlyTeamId) : race.teams;
  return list.map((team) => {
    const locked = (race.isLocked(team.id, props.leg.id) && !auth.isAdmin) || (race.branchLocked(team.id, props.leg.id) && !race.progressOf(team.id, props.leg.id)?.completed_at && !auth.isAdmin); // Legs after elimination / withdrawal and unfinished side quests of a completed main leg: read-only and empty (earlier legs show records but cannot be edited)
    return { team, p: race.progressOf(team.id, props.leg.id), locked, can: !locked && race.canRecord(team.id, props.leg.id), edit: !locked && race.canEdit(team.id), block: race.blockReason(team.id, props.leg.id) };
  });
});
/** Inline editing of extra info: allowed after the previous leg completes (this leg starts) and before this leg completes; afterwards only through the edit dialog */
const inline = (can: boolean, p: Progress | null) => can && !!p?.arrived_at && !p?.completed_at;
const showTarget = computed(() => props.leg.type === 'UT' || props.leg.type === 'YD' || props.leg.type === 'Union');
const targetLabel = computed(() => (props.leg.type === 'Union' ? '合作队伍' : '施加对象'));
const label = computed(() => endLabel(props.leg.type));
const withStart = computed(() => hasStart(props.leg.type));
const isBranch = computed(() => props.leg.type === 'SQ');
const stateOf = (p: Progress | null) => (isBranch.value ? (p?.completed_at ? '已完成' : p?.arrived_at ? '进行中' : '未进入') : p?.completed_at ? `已${label.value}` : withStart.value && p?.arrived_at ? '进行中' : withStart.value ? '未开始' : `未${label.value}`);
/** Why the record button is disabled: out of order / extra info missing */
const disabledReason = (p: Progress | null, block: string | null, teamId: number) => block ?? race.extraMissing(props.leg, p, teamId);

function detourOptions(): string[] {
  const l = props.leg;
  return [l.detour_a || 'A', l.detour_b || 'B'];
}
</script>

<template>
  <div class="scroll-table">
    <table v-mobile-table class="table record-table">
      <thead>
        <tr>
          <th class="col-first">队伍</th><th class="col-status">状态</th>
          <th v-if="withStart" class="col-time">{{ isBranch ? '开始支线' : startLabel(leg.type) }}</th><th class="col-time">{{ isBranch ? '结束支线' : label }}</th>
          <th v-if="showTarget" class="col-extra c">{{ targetLabel }}</th>
          <th v-if="leg.type === 'DT'" class="col-extra c">绕道选择</th>
          <th v-if="leg.type === 'RB'" class="col-extra c">路障完成人</th>
          <th v-if="leg.type === 'FF'" class="col-extra c">快进结果</th>
          <th class="col-action c">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="{ team, p, can, edit, block, locked } in rows" :key="team.id" :style="team.status !== 'alive' ? 'opacity:.55' : ''">
          <td><strong>{{ team.label }}</strong> <TeamStatus v-if="team.status !== 'alive'" :status="team.status" /></td>
          <td>{{ locked ? '-' : stateOf(p) }}</td>
          <td v-if="withStart"><span class="record-time">{{ fmtTime(p?.arrived_at) }}</span></td>
          <td><span class="record-time">{{ leg.type === 'PS' ? fmtTimeSec(p?.completed_at) : fmtTime(p?.completed_at) }}</span></td>
          <td v-if="showTarget" class="c">
            <MSelect v-if="inline(can, p)" sm style="width: 130px" :model-value="p?.target_team_id ?? ''" :options="[{ value: '', label: leg.type === 'Union' ? '未选择' : '未使用' }, ...race.teams.filter((x) => x.id !== team.id).map((t) => ({ value: t.id, label: t.label }))]" @update:model-value="rec.setValue('target', team.id, leg.id, String($event))" />
            <span v-else>{{ p?.target_team_id ? race.teamById.get(p.target_team_id)?.label : '-' }}</span>
          </td>
          <td v-if="leg.type === 'DT'" class="c">
            <MSelect v-if="inline(can, p)" sm style="width: 120px" :model-value="p?.detour_choice ?? ''" :options="[{ value: '', label: '未选' }, ...detourOptions().map((o) => ({ value: o, label: o }))]" @update:model-value="rec.setValue('detour', team.id, leg.id, String($event))" />
            <span v-else>{{ p?.detour_choice || '-' }}</span>
          </td>
          <td v-if="leg.type === 'RB'" class="c">
            <MSelect v-if="inline(can, p)" sm style="width: 120px" :model-value="p?.roadblock_by ?? ''" :options="[{ value: '', label: '未选' }, ...race.memberOptions(team.id, p?.roadblock_by).map((m) => ({ value: m, label: m }))]" @update:model-value="rec.setValue('roadblock', team.id, leg.id, String($event))" />
            <span v-else>{{ p?.roadblock_by || '-' }}</span>
          </td>
          <td v-if="leg.type === 'FF'" class="c">
            <MSelect v-if="inline(can, p)" sm style="width: 110px" :model-value="p?.ff_result ?? ''" :options="[{ value: '', label: '未尝试' }, { value: 'success', label: '成功' }, { value: 'fail', label: '失败' }]" @update:model-value="rec.setValue('ff', team.id, leg.id, String($event))" />
            <span v-else>{{ p?.ff_result === 'success' ? '成功' : p?.ff_result === 'fail' ? '失败' : '-' }}</span>
          </td>
          <td class="c">
            <div class="flex" style="gap: 6px; flex-wrap: nowrap">
              <template v-if="locked"><span class="text-gray text-sm">-</span></template>
              <template v-else-if="race.episodeFinished || race.teamLocked(team.id)">
                <span class="text-gray text-sm" :title="race.lockReason(team.id) ?? ''">已锁定</span>
              </template>
              <template v-else-if="can && isBranch">
                <button v-if="!p?.arrived_at" class="btn btn-sm btn-slot" :disabled="!!block" :title="block ?? ''" @click="rec.branch('start', team.id, leg.id)">开始支线</button>
                <button v-else-if="!p?.completed_at" class="btn btn-success btn-sm btn-slot" @click="rec.branch('end', team.id, leg.id)">结束支线</button>
                <button v-else class="btn btn-text btn-sm btn-slot" @click="editing = { team, progress: p }">修改记录</button>
              </template>
              <template v-else-if="can">
                <button v-if="!p?.completed_at" class="btn btn-sm btn-slot" :disabled="!!disabledReason(p, block, team.id)" :title="disabledReason(p, block, team.id) ?? ''" @click="rec.complete(team.id, leg.id)">记录{{ label }}</button>
                <button v-else class="btn btn-text btn-sm btn-slot" @click="editing = { team, progress: p }">修改记录</button>
              </template>
              <template v-else-if="edit && p?.completed_at">
                <button class="btn btn-text btn-sm btn-slot" @click="editing = { team, progress: p }">修改记录</button>
              </template>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <ProgressEditModal v-if="editing" :leg="leg" :team="editing.team" :progress="editing.progress" @close="editing = null" />
</template>
