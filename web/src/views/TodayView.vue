<script setup lang="ts">
import { computed, ref } from 'vue';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useRecord } from '@/composables/record';
import { fmtTime, fmtTimeSec } from '@/utils/time';
import EpSelector from '@/components/EpSelector.vue';
import LegTag from '@/components/LegTag.vue';
import RecordTable from '@/components/RecordTable.vue';
import PenaltyPanel from '@/components/PenaltyPanel.vue';
import LegExtraField from '@/components/LegExtraField.vue';
import TeamCurrencyPanel from '@/components/TeamCurrencyPanel.vue';
import ProgressEditModal from '@/components/ProgressEditModal.vue';
import { type Leg, type Progress, legName } from '@/types';
import { singleLabel } from '@/types';
import { fmtMoney, moneyUnit } from '@/utils/money';

const auth = useAuth();
const race = useRace();
const rec = useRecord();
const editing = ref<{ leg: Leg; progress: Progress | null } | null>(null);

const ep = computed(() => race.currentEpisode);
const my = computed(() => race.myAssignment);
const myTeam = computed(() => (my.value?.team_id ? race.teamById.get(my.value.team_id) ?? null : null));
// 站点可能驻守多个环节：按环节顺序从早到晚
const myLegs = computed(() => (ep.value?.legs ?? []).filter((l) => (my.value?.leg_ids ?? []).includes(l.id)));

const legRows = computed(() => {
  if (!ep.value || !myTeam.value) return [];
  return ep.value.legs.filter((leg) => leg.record_mode !== 'none').map((leg) => ({ leg, p: race.progressOf(myTeam.value!.id, leg.id), single: leg.record_mode === 'single', label: singleLabel(leg.type), block: race.blockReason(myTeam.value!.id, leg.id) }));
});
const stats = computed(() => ({
  alive: race.aliveTeams.length,
  total: race.teams.length,
  legs: ep.value?.legs.length ?? 0,
  staffed: race.assignments.length,
  finished: ep.value ? race.teams.filter((t) => ep.value!.legs.some((l) => l.type === 'PS' && race.progressOf(t.id, l.id)?.completed_at)).length : 0,
}));

</script>

<template>
  <EpSelector />

  <div v-if="race.episodePending" class="alert alert-warning">{{ ep?.code }} 尚未开始。主办点「开始赛段」后才能记录时间、操作经费和罚时。</div>
  <div v-else-if="race.episodeFinished" class="alert alert-info">{{ ep?.code }} 已结束，记录已锁定。{{ auth.isHost ? '如需修正，请使用各环节的「修改记录」。' : '幕后只读，如需修正请联系主办。' }}</div>

  <!-- 主办概览 -->
  <div v-if="auth.isHost" class="card">
    <div class="card-header">概览</div>
    <template v-if="auth.isHost">
      <div class="grid grid-stat">
        <div class="team-card"><div class="text-gray text-sm">存活队伍</div><div class="stat-num" style="color: var(--success)">{{ stats.alive }}<span class="text-gray text-sm"> / {{ stats.total }}</span></div></div>
        <div class="team-card"><div class="text-gray text-sm">本赛段环节</div><div class="stat-num" style="color: var(--primary)">{{ stats.legs }}</div></div>
        <div class="team-card"><div class="text-gray text-sm">已排班幕后</div><div class="stat-num" style="color: var(--primary)">{{ stats.staffed }}</div></div>
        <div class="team-card"><div class="text-gray text-sm">已到中继站</div><div class="stat-num" style="color: #db2777">{{ stats.finished }}</div></div>
      </div>
      <div class="flex mt-2">
        <router-link to="/progress" class="btn">查看进度</router-link>
        <router-link to="/schedule" class="btn btn-outline">去排班</router-link>
        
      </div>
    </template>
  </div>

  <!-- 我的分工（按排班，主办也可能被排为跟队/站点） -->
  <div class="card">
    <div class="card-header">我的分工</div>
    <template v-if="my?.role === 'follow' && myTeam">
      <p><span class="badge badge-follow">跟队</span> 你本赛段跟随 <strong>{{ myTeam.label }}</strong>，当前余额 <strong class="text-warning">{{ fmtMoney(myTeam.currency) }} {{ moneyUnit() }}</strong></p>
      <div class="scroll-table">
        <table class="table record-table">
          <thead><tr><th class="col-first">环节</th><th class="col-status">状态</th><th class="col-time">开始</th><th class="col-time">完成 / 打卡</th><th class="col-extra">记录信息</th><th class="col-action">操作</th></tr></thead>
          <tbody>
            <tr v-for="{ leg, p, single, label, block } in legRows" :key="leg.id">
              <td><LegTag :type="leg.type" /> <router-link :to="{ name: 'leg', params: { episodeId: ep!.id, legId: leg.id } }">{{ legName(leg) }}</router-link></td>
              <td>{{ single ? (p?.completed_at ? `已${label}` : `未${label}`) : p?.completed_at ? '已完成' : p?.arrived_at ? '进行中' : '未开始' }}</td>
              <td><span class="record-time">{{ single ? '-' : fmtTime(p?.arrived_at) }}</span></td>
              <td><span class="record-time">{{ leg.type === 'PS' ? fmtTimeSec(p?.completed_at) : fmtTime(p?.completed_at) }}</span></td>
              <td><LegExtraField :leg="leg" :team-id="myTeam!.id" :progress="p" :can="!!p?.arrived_at && !p?.completed_at && !race.episodeFinished" /></td>
              <td>
                <template v-if="race.episodeFinished">
                  <button v-if="race.canEdit(myTeam!.id)" class="btn btn-outline btn-sm btn-slot" @click="editing = { leg, progress: p }">修改记录</button>
                  <span v-else class="text-gray text-sm">已锁定</span>
                </template>
                <template v-else-if="single">
                  <button v-if="!p?.completed_at" class="btn btn-sm btn-slot" :disabled="!!block" :title="block ?? ''" @click="rec.single(myTeam!.id, leg.id, label)">记录{{ label }}</button>
                  <button v-else class="btn btn-outline btn-sm btn-slot" @click="editing = { leg, progress: p }">修改记录</button>
                </template>
                <template v-else>
                  <button v-if="!p?.arrived_at" class="btn btn-sm btn-slot" :disabled="!!block" :title="block ?? ''" @click="rec.arrive(myTeam!.id, leg.id)">记录开始</button>
                  <button v-else-if="!p?.completed_at" class="btn btn-success btn-sm btn-slot" :disabled="!!race.extraMissing(leg, p)" :title="race.extraMissing(leg, p) ?? ''" @click="rec.complete(myTeam!.id, leg.id)">记录完成</button>
                  <button v-else class="btn btn-outline btn-sm btn-slot" @click="editing = { leg, progress: p }">修改记录</button>
                </template>
                <div v-if="block && !p?.arrived_at" class="block-hint" :title="block">{{ block }}</div>
                <div v-else-if="p?.arrived_at && !p?.completed_at && race.extraMissing(leg, p)" class="block-hint">{{ race.extraMissing(leg, p) }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="mt-3"><TeamCurrencyPanel :team-id="myTeam.id" /></div>
    </template>

    <template v-else-if="my?.role === 'station' && myLegs.length">
      <p><span class="badge badge-station">站点</span> 你本赛段驻守 {{ myLegs.length }} 个环节：{{ myLegs.map((l) => legName(l)).join('、') }}。开始和完成时间由各队跟队记录，站点这里只看；本站点的罚时、补时在各环节下方操作。</p>
      <div v-for="(l, i) in myLegs" :key="l.id" class="station-leg" :class="{ 'mt-3': i > 0 }">
        <div class="flex-between mb-1">
          <span class="section-title"><LegTag :type="l.type" full /> {{ legName(l) }}</span>
          <router-link :to="{ name: 'leg', params: { episodeId: ep!.id, legId: l.id } }" class="btn btn-outline btn-sm">环节详情 / 附件</router-link>
        </div>
        <p v-if="l.address" class="text-sm text-gray">地址：{{ l.address }} <a v-if="l.map_url" :href="l.map_url" target="_blank">地图</a></p>
        <p v-if="l.open_time || l.close_time" class="text-sm text-gray">开放时间：{{ l.open_time || '-' }} ~ {{ l.close_time || '-' }}</p>
        <div v-if="l.judge_criteria" class="alert alert-info pre">判定标准：{{ l.judge_criteria }}</div>
        <RecordTable :leg="l" />
        <div class="mt-2"><PenaltyPanel :leg-id="l.id" /></div>
      </div>
    </template>

    <template v-else-if="my?.role === 'live'">
      <p><span class="badge badge-live">直播员</span> 你本赛段负责直播跟进，可以查看所有队伍、环节、经费与罚时数据，但不做记录。</p>
      <div class="flex">
        <router-link to="/progress" class="btn">查看进度</router-link>
        <router-link to="/episodes" class="btn btn-outline">赛段与环节</router-link>
        <router-link to="/announcements" class="btn btn-outline">公告</router-link>
      </div>
    </template>

    <div v-else class="empty-state">
      <template v-if="auth.isHost">本赛段没有给你排跟队或站点任务。</template>
      <template v-else>本赛段你没有跟队或站点任务（机动幕后）。<br /><span class="text-sm">可以在「赛段信息」查看环节安排，排班有变动会实时更新。</span></template>
    </div>
  </div>

  <ProgressEditModal v-if="editing && myTeam" :leg="editing.leg" :team="myTeam" :progress="editing.progress" @close="editing = null" />
</template>
