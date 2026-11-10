// Record table as cards (the website's TodayView rows and RecordTable on phones).
// teamId: one team, a row per leg (the follow's page); legId: one leg, a row per team (a station's leg).
// Rows offer: record the end time, start / end a side quest, edit a record; extra info (detour / roadblock / fast forward /
// target team) is filled in the row once the leg has started and until it ends.
const race = require('../../utils/race');
const auth = require('../../utils/auth');
const { onTick } = require('../../utils/ticker');
const { legName, endLabel, startLabel } = require('../../utils/types');
const { fmtTime, fmtTimeSec } = require('../../utils/time');
const record = require('../../utils/record');
const { editRecord, toast } = require('../../utils/dialogs');

/** The leg's extra info and its choices: kind, field label, option labels and values */
function extraOf(leg, team, p) {
  const t = leg.type;
  if (t === 'DT') return { kind: 'detour', label: '绕道选择', labels: ['未选', leg.detour_a || 'A', leg.detour_b || 'B'], values: ['', leg.detour_a || 'A', leg.detour_b || 'B'], value: (p && p.detour_choice) || '' };
  if (t === 'RB') { const m = race.memberOptions(team.id, p && p.roadblock_by); return { kind: 'roadblock', label: '路障完成人', labels: ['未选'].concat(m), values: [''].concat(m), value: (p && p.roadblock_by) || '' }; }
  if (t === 'FF') return { kind: 'ff', label: '快进结果', labels: ['未尝试', '成功', '失败'], values: ['', 'success', 'fail'], value: (p && p.ff_result) || '' };
  if (t === 'UT' || t === 'YD' || t === 'Union') {
    const others = race.teams.filter((x) => x.id !== team.id);
    return { kind: 'target', label: t === 'Union' ? '合作队伍' : '施加对象', labels: [t === 'Union' ? '未选择' : '未使用'].concat(others.map((x) => x.label)), values: [''].concat(others.map((x) => String(x.id))), value: p && p.target_team_id ? String(p.target_team_id) : '' };
  }
  return null;
}

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { teamId: { type: Number, value: 0 }, legId: { type: Number, value: 0 } },
  data: { rows: [] },
  lifetimes: {
    attached() {
      this.off = race.subscribe(() => this.render());
      this.offTick = onTick(() => this.render(true));
      this.render();
    },
    detached() { this.off && this.off(); this.offTick && this.offTick(); },
  },
  methods: {
    row(team, leg, perTeam) {
      const p = race.progressOf(team.id, leg.id);
      const isBranch = leg.type === 'SQ';
      const label = endLabel(leg.type);
      // legs after elimination / withdrawal, and unfinished side quests of a completed main leg: read-only and empty
      const locked = (race.isLocked(team.id, leg.id) && !auth.isAdmin) || (isBranch && race.branchLocked(team.id, leg.id) && !(p && p.completed_at) && !auth.isAdmin);
      const frozen = race.episodeFinished() || race.teamLocked(team.id);
      // the follow's own rows are always recordable for its team; a leg's rows follow the record / edit rights
      const can = !locked && (perTeam ? true : race.canRecord(team.id, leg.id));
      const edit = !locked && (perTeam ? true : race.canEdit(team.id));
      const stop = !(p && p.completed_at) ? race.stoppedLabel(team.id, leg.id) : null;
      const state = locked ? '-' : stop || (isBranch ? (p && p.completed_at ? '已完成' : p && p.arrived_at ? '进行中' : '未进入')
        : p && p.completed_at ? `已${label}` : race.waitingUntil(team.id, leg.id) ? '等待中' : p && p.arrived_at ? '进行中' : '未开始');
      const block = race.blockReason(team.id, leg.id);
      const reason = block || race.extraMissing(leg, p, team.id);
      let action = null;
      if (locked) action = null;
      else if (frozen) action = { type: 'locked', label: '已锁定', reason: race.lockReason(team.id) };
      else if (can && isBranch) action = !(p && p.arrived_at) ? { type: 'branchStart', label: '开始支线', disabled: !!block, reason: block }
        : !p.completed_at ? { type: 'branchEnd', label: '结束支线', success: true } : { type: 'edit', label: '修改记录', text: true };
      else if (can) action = !(p && p.completed_at) ? { type: 'complete', label: `记录${label}`, disabled: !!reason, reason } : { type: 'edit', label: '修改记录', text: true };
      else if (edit && p && p.completed_at) action = { type: 'edit', label: '修改记录', text: true };
      const ex = extraOf(leg, team, p);
      let extra = null;
      if (ex) {
        const text = ex.value ? ex.labels[Math.max(0, ex.values.indexOf(ex.value))] || ex.value : '-';
        // inline editing once the leg has started and until it ends; a 回转 fixes the detour choice
        const inline = can && !frozen && !!(p && p.arrived_at) && !p.completed_at && !(ex.kind === 'detour' && ex.value === '回转');
        extra = { kind: ex.kind, label: ex.label, text: ex.kind === 'detour' ? ex.value || '-' : text, inline, labels: ex.labels, values: ex.values, index: Math.max(0, ex.values.indexOf(ex.value)) };
      }
      return {
        key: `${team.id}-${leg.id}`, teamId: team.id, legId: leg.id,
        title: perTeam ? legName(leg) : team.label, legType: perTeam ? leg.type : '', dim: !perTeam && team.status !== 'alive',
        state, startLabel: isBranch ? '开始支线' : startLabel(leg.type), endLabel: isBranch ? '结束支线' : label,
        start: locked ? '-' : fmtTime(race.taskStart(team.id, leg.id)), startHit: race.startDelayed(team.id, leg.id),
        end: locked ? '-' : (leg.type === 'PS' ? fmtTimeSec : fmtTime)(p && p.completed_at), endHit: !!race.uturnOn(team.id, leg.id),
        extra, action,
      };
    },
    render(tickOnly) {
      const { teamId, legId } = this.data;
      const ep = race.currentEpisode();
      if (!ep) return;
      let rows = [];
      if (teamId) {
        const team = race.teamById.get(teamId);
        if (team) rows = ep.legs.map((l) => this.row(team, l, true));
      } else if (legId) {
        const leg = race.legById.get(legId);
        if (leg) rows = race.teams.map((t) => this.row(t, leg, false));
      }
      // each second only a wait ending changes a row: skip the update when nothing differs
      const json = JSON.stringify(rows);
      if (tickOnly && json === this.json) return;
      this.json = json;
      this.setData({ rows });
    },
    act(e) {
      const r = this.data.rows.find((x) => x.key === e.currentTarget.dataset.key);
      if (!r || !r.action) return;
      const a = r.action;
      if (a.type === 'locked') { toast(a.reason || '已锁定'); return; }
      if (a.disabled) { toast(a.reason); return; }
      if (a.type === 'complete') record.complete(r.teamId, r.legId);
      else if (a.type === 'branchStart') record.branch('start', r.teamId, r.legId);
      else if (a.type === 'branchEnd') record.branch('end', r.teamId, r.legId);
      else if (a.type === 'edit') editRecord(race.legById.get(r.legId), race.teamById.get(r.teamId), race.progressOf(r.teamId, r.legId));
    },
    pickExtra(e) {
      const r = this.data.rows.find((x) => x.key === e.currentTarget.dataset.key);
      if (!r || !r.extra) return;
      record.setValue(r.extra.kind, r.teamId, r.legId, r.extra.values[Number(e.detail.value)]);
    },
  },
});
