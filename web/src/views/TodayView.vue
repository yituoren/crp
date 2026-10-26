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
import CurrencyOps from '@/components/CurrencyOps.vue';
import CurrentLegCard from '@/components/CurrentLegCard.vue';
import BagCard from '@/components/BagCard.vue';
import ProgressEditModal from '@/components/ProgressEditModal.vue';
import { type Leg, type Progress, legName } from '@/types';
import { endLabel, hasStart } from '@/types';
import { fmtMoney, moneyUnit, moneyMode } from '@/utils/money';

const auth = useAuth();
const race = useRace();
const rec = useRecord();
const editing = ref<{ leg: Leg; progress: Progress | null } | null>(null);

const ep = computed(() => race.currentEpisode);
const my = computed(() => race.myAssignment);
const myTeam = computed(() => (my.value?.team_id ? race.teamById.get(my.value.team_id) ?? null : null));
// A station may cover several legs: in leg order
const myLegs = computed(() => (ep.value?.legs ?? []).filter((l) => (my.value?.leg_ids ?? []).includes(l.id)));

const legRows = computed(() => {
  if (!ep.value || !myTeam.value) return [];
  return ep.value.legs.map((leg) => {
    const p = race.progressOf(myTeam.value!.id, leg.id);
    const block = race.blockReason(myTeam.value!.id, leg.id) ?? race.extraMissing(leg, p, myTeam.value!.id);
    const isBranch = leg.type === 'SQ';
    const locked = (race.isLocked(myTeam.value!.id, leg.id) && !auth.isAdmin) || (isBranch && race.branchLocked(myTeam.value!.id, leg.id) && !p?.completed_at && !auth.isAdmin);
    const state = locked ? '-' : isBranch ? (p?.completed_at ? '已完成' : p?.arrived_at ? '进行中' : '未进入') : p?.completed_at ? `已${endLabel(leg.type)}` : hasStart(leg.type) ? (p?.arrived_at ? '进行中' : '未开始') : '未出发';
    return { leg, p, label: endLabel(leg.type), block, locked, isBranch, state };
  });
});

</script>

<template>
  <EpSelector />

  <div v-if="race.episodePending" class="alert alert-warning">{{ ep?.code }} 尚未开始。主办点「开始赛段」后才能记录时间、操作经费和罚时。</div>
  <div v-else-if="race.episodeFinished" class="alert alert-info">{{ ep?.code }} 已结束，所有记录已锁定，只有管理员可以修改。</div>

  <!-- My assignment, no outer card. Follow = status line + borderless table + cards (current leg / bag / money / penalties); station = one section per leg, separated by rules -->
  <div class="my-work">
    <template v-if="my?.role === 'follow' && myTeam">
      <p class="my-work-head"><span class="badge badge-follow">跟队</span> 你本赛段跟随 <strong>{{ myTeam.label }}</strong>，当前余额 <strong class="text-warning">{{ fmtMoney(myTeam.currency) }} {{ moneyUnit() }}</strong></p>
      <CurrentLegCard :team-id="myTeam.id" />
      <div class="scroll-table my-work-table">
        <table v-mobile-table class="table record-table">
          <thead><tr><th class="col-first">环节</th><th class="col-status">状态</th><th class="col-time">开始</th><th class="col-time">结束</th><th class="col-extra c">记录信息</th><th class="col-action c">操作</th></tr></thead>
          <tbody>
            <tr v-for="{ leg, p, label, block, state, locked, isBranch } in legRows" :key="leg.id">
              <td><LegTag :type="leg.type" /> <router-link :to="{ name: 'leg', params: { episodeId: ep!.id, legId: leg.id } }">{{ legName(leg) }}</router-link></td>
              <td>{{ state }}</td>
              <td><span class="record-time">{{ hasStart(leg.type) ? fmtTime(p?.arrived_at) : '-' }}</span></td>
              <td><span class="record-time">{{ leg.type === 'PS' ? fmtTimeSec(p?.completed_at) : fmtTime(p?.completed_at) }}</span></td>
              <td class="c"><LegExtraField :leg="leg" :team-id="myTeam!.id" :progress="p" :can="!locked && !!p?.arrived_at && !p?.completed_at && !race.episodeFinished" /></td>
              <td class="c">
                <template v-if="locked"><span class="text-gray text-sm">-</span></template>
                <template v-else-if="race.episodeFinished || race.teamLocked(myTeam!.id)">
                  <span class="text-gray text-sm" :title="race.lockReason(myTeam!.id) ?? ''">已锁定</span>
                </template>
                <template v-else-if="isBranch">
                  <div class="flex" style="gap: 6px; flex-wrap: nowrap">
                    <button v-if="!p?.arrived_at" class="btn btn-sm btn-slot" :disabled="!!block" :title="block ?? ''" @click="rec.branch('start', myTeam!.id, leg.id)">开始支线</button>
                    <button v-else-if="!p?.completed_at" class="btn btn-success btn-sm btn-slot" @click="rec.branch('end', myTeam!.id, leg.id)">结束支线</button>
                    <button v-else class="btn btn-text btn-sm btn-slot" @click="editing = { leg, progress: p }">修改记录</button>
                  </div>
                </template>
                <template v-else>
                  <div class="flex" style="gap: 6px; flex-wrap: nowrap">
                    <button v-if="!p?.completed_at" class="btn btn-sm btn-slot" :disabled="!!block" :title="block ?? ''" @click="rec.complete(myTeam!.id, leg.id)">记录{{ label }}</button>
                    <button v-else class="btn btn-text btn-sm btn-slot" @click="editing = { leg, progress: p }">修改记录</button>
                  </div>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <BagCard v-if="moneyMode() === 'coin'" :team-id="myTeam.id" />
      <TeamCurrencyPanel :team-id="myTeam.id" />
      <PenaltyPanel :team-id="myTeam.id" />
    </template>

    <template v-else-if="my?.role === 'station' && myLegs.length">
      <p class="my-work-head"><span class="badge badge-station">站点</span> 你本赛段驻守 {{ myLegs.length }} 个环节：{{ myLegs.map((l) => legName(l)).join('、') }}</p>
      <div v-for="l in myLegs" :key="l.id" class="station-leg">
        <div class="flex-between mb-1">
          <span class="section-title"><LegTag :type="l.type" full /> {{ legName(l) }}</span>
          <router-link :to="{ name: 'leg', params: { episodeId: ep!.id, legId: l.id } }" class="btn btn-text btn-sm">环节详情 / 附件<Icon name="open_in_new" size="16" /></router-link>
        </div>
        <p v-if="l.address" class="text-sm text-gray">地址：{{ l.address }} <a v-if="l.map_url" :href="l.map_url" target="_blank">地图</a></p>
        <p v-if="l.open_time || l.close_time" class="text-sm text-gray">开放时间：{{ l.open_time || '-' }} ~ {{ l.close_time || '-' }}</p>
        <div v-if="l.judge_criteria" class="alert alert-info pre">判定标准：{{ l.judge_criteria }}</div>
        <RecordTable :leg="l" />
        <PenaltyPanel :leg-id="l.id" />
        <CurrencyOps :leg-id="l.id" />
      </div>
    </template>

    <template v-else-if="my?.role === 'live'">
      <p class="my-work-head"><span class="badge badge-live">直播员</span> 本赛段只读</p>
      <div class="flex">
        <router-link :to="{ name: 'progress' }" class="btn">查看进度</router-link>
        <router-link :to="{ name: 'episodes' }" class="btn btn-tonal">赛段与环节</router-link>
        <router-link :to="{ name: 'announcements' }" class="btn btn-tonal">公告</router-link>
      </div>
    </template>

    <div v-else class="empty-state">
      <template v-if="auth.isHost">本赛段没有给你排跟队或站点任务。</template>
      <template v-else>本赛段你没有跟队或站点任务（机动幕后）。<br /><span class="text-sm">可以在「赛段信息」查看环节安排，排班有变动会实时更新。</span></template>
    </div>
  </div>

  <ProgressEditModal v-if="editing && myTeam" :leg="editing.leg" :team="myTeam" :progress="editing.progress" @close="editing = null" />
</template>
