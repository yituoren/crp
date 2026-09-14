<script setup lang="ts">
import { computed, reactive } from 'vue';
import { api } from '@/api';
import { useAuth } from '@/stores/auth';
import { useRace } from '@/stores/race';
import { useUi } from '@/stores/ui';
import { useRecord } from '@/composables/record';
import { fmtTime, fmtDateTime } from '@/utils/time';
import EpSelector from '@/components/EpSelector.vue';
import LegTag from '@/components/LegTag.vue';
import RecordTable from '@/components/RecordTable.vue';
import { singleLabel } from '@/types';
import { fmtMoney } from '@/utils/money';

const auth = useAuth();
const race = useRace();
const ui = useUi();
const rec = useRecord();

const ep = computed(() => race.currentEpisode);
const my = computed(() => race.myAssignment);
const myTeam = computed(() => (my.value?.team_id ? race.teamById.get(my.value.team_id) ?? null : null));
const myLeg = computed(() => (my.value?.leg_id ? ep.value?.legs.find((l) => l.id === my.value!.leg_id) ?? null : null));

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

const annForm = reactive({ content: '', level: 'info' });
async function postAnnouncement() {
  if (!annForm.content.trim()) return;
  try {
    await api('/announcements', { method: 'POST', body: annForm });
    annForm.content = '';
    await race.loadAnnouncements();
    ui.toast('公告已发布');
  } catch (e) { ui.error(e); }
}
async function removeAnnouncement(id: number) {
  if (!(await ui.confirm('删除公告', '确定删除这条公告？', { danger: true }))) return;
  try { await api(`/announcements/${id}`, { method: 'DELETE' }); await race.loadAnnouncements(); } catch (e) { ui.error(e); }
}
const levelLabel: Record<string, string> = { info: '通知', warning: '注意', urgent: '紧急' };
</script>

<template>
  <EpSelector />

  <!-- 公告 -->
  <div class="card">
    <div class="card-header">公告</div>
    <div v-if="auth.isHost" class="flex mb-2" style="align-items: stretch">
      <input v-model="annForm.content" placeholder="发布一条公告给所有幕后…" style="flex: 1; min-width: 200px" @keyup.enter="postAnnouncement" />
      <select v-model="annForm.level" class="input-inline" style="width: 90px"><option value="info">通知</option><option value="warning">注意</option><option value="urgent">紧急</option></select>
      <button class="btn" @click="postAnnouncement">发布</button>
    </div>
    <div v-if="!race.announcements.length" class="text-gray text-sm">暂无公告</div>
    <div v-for="a in race.announcements.slice(0, 5)" :key="a.id" class="alert" :class="'alert-' + a.level">
      <div class="flex-between">
        <span class="pre"><span class="badge" :class="'badge-' + a.level">{{ levelLabel[a.level] }}</span> {{ a.content }}</span>
        <span class="text-xs text-gray">{{ a.created_by }} · {{ fmtDateTime(a.created_at) }} <button v-if="auth.isHost" class="btn btn-outline btn-sm" @click="removeAnnouncement(a.id)">删</button></span>
      </div>
    </div>
  </div>

  <!-- 主办概览 -->
  <div v-if="auth.isHost" class="card">
    <div class="card-header">{{ ep?.code }} 概览</div>
    <template v-if="auth.isHost">
      <div class="grid grid-stat">
        <div class="team-card"><div class="text-gray text-sm">存活队伍</div><div class="stat-num" style="color: var(--success)">{{ stats.alive }}<span class="text-gray text-sm"> / {{ stats.total }}</span></div></div>
        <div class="team-card"><div class="text-gray text-sm">本赛段环节</div><div class="stat-num" style="color: var(--primary)">{{ stats.legs }}</div></div>
        <div class="team-card"><div class="text-gray text-sm">已排班幕后</div><div class="stat-num" style="color: var(--primary)">{{ stats.staffed }}</div></div>
        <div class="team-card"><div class="text-gray text-sm">已到终点</div><div class="stat-num" style="color: #db2777">{{ stats.finished }}</div></div>
      </div>
      <div class="flex mt-2">
        <router-link to="/dashboard" class="btn">打开实时大屏</router-link>
        <router-link to="/schedule" class="btn btn-outline">去排班</router-link>
        <router-link to="/pitstop" class="btn btn-outline">终点结算</router-link>
      </div>
    </template>
  </div>

  <!-- 我的分工（按排班，主办也可能被排为跟队/站点） -->
  <div class="card">
    <div class="card-header">我在 {{ ep?.code }} 的分工</div>
    <template v-if="my?.role === 'follow' && myTeam">
      <p><span class="badge badge-follow">跟队</span> 你本赛段跟随 <strong>{{ myTeam.name }}</strong>（{{ myTeam.members || '成员未填写' }}），当前余额 <strong class="text-warning">{{ fmtMoney(myTeam.currency) }} 元</strong></p>
      <div class="scroll-table">
        <table class="table">
          <thead><tr><th>环节</th><th>状态</th><th>到达</th><th>完成 / 打卡</th><th style="min-width: 110px">操作</th></tr></thead>
          <tbody>
            <tr v-for="{ leg, p, single, label, block } in legRows" :key="leg.id">
              <td><LegTag :type="leg.type" /> <router-link :to="{ name: 'leg', params: { episodeId: ep!.id, legId: leg.id } }">{{ leg.name }}</router-link></td>
              <td>{{ single ? (p?.completed_at ? `已${label}` : `未${label}`) : p?.completed_at ? '已完成' : p?.arrived_at ? '已到达' : '未到达' }}</td>
              <td><span class="record-time">{{ single ? '-' : fmtTime(p?.arrived_at) }}</span></td>
              <td><span class="record-time">{{ fmtTime(p?.completed_at) }}</span></td>
              <td>
                <template v-if="single">
                  <button v-if="!p?.completed_at" class="btn btn-sm" :disabled="!!block" :title="block ?? ''" @click="rec.single(myTeam!.id, leg.id, label)">记录{{ label }}</button>
                  <span v-else class="text-success">✔</span>
                </template>
                <template v-else>
                  <button v-if="!p?.arrived_at" class="btn btn-sm" :disabled="!!block" :title="block ?? ''" @click="rec.arrive(myTeam!.id, leg.id)">记录到达</button>
                  <button v-else-if="!p?.completed_at" class="btn btn-success btn-sm" @click="rec.complete(myTeam!.id, leg.id)">记录完成</button>
                  <span v-else class="text-success">✔</span>
                </template>
                <div v-if="block && !p?.arrived_at" class="text-xs text-gray">{{ block }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <template v-else-if="my?.role === 'station' && myLeg">
      <p><span class="badge badge-station">站点</span> 你本赛段驻守 <LegTag :type="myLeg.type" full /> <strong>{{ myLeg.name }}</strong>
        <router-link :to="{ name: 'leg', params: { episodeId: ep!.id, legId: myLeg.id } }" class="btn btn-outline btn-sm" style="margin-left: 8px">查看环节详情 / 附件</router-link>
      </p>
      <p v-if="myLeg.address" class="text-sm text-gray">地址：{{ myLeg.address }} <a v-if="myLeg.map_url" :href="myLeg.map_url" target="_blank">地图</a></p>
      <p v-if="myLeg.open_time || myLeg.close_time" class="text-sm text-gray">开放时间：{{ myLeg.open_time || '-' }} ~ {{ myLeg.close_time || '-' }}</p>
      <div v-if="myLeg.judge_criteria" class="alert alert-info pre">判定标准：{{ myLeg.judge_criteria }}</div>
      <RecordTable :leg="myLeg" />
    </template>

    <div v-else class="empty-state">
      <template v-if="auth.isHost">本赛段没有给你排跟队或站点任务。</template>
      <template v-else>本赛段你没有跟队或站点任务（机动幕后）。<br /><span class="text-sm">可以在「赛段信息」查看环节安排，排班有变动会实时更新。</span></template>
    </div>
  </div>
</template>
