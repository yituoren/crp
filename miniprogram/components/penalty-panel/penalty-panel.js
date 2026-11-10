// Penalties and credits (the website's PenaltyPanel). legId: one station leg's records; teamId: one team's (follow); neither: all.
// Hosts and this episode's stations act on any team (stations on their own legs only), follows on their own team.
const { api } = require('../../utils/api');
const race = require('../../utils/race');
const auth = require('../../utils/auth');
const { legName } = require('../../utils/types');
const { fmtDateTime, fmtPenMin } = require('../../utils/time');

Component({
  options: { styleIsolation: 'apply-shared' },
  // flat: no bottom margin (inside a stack that spaces its own items)
  properties: { legId: { type: Number, value: 0 }, teamId: { type: Number, value: 0 }, flat: { type: Boolean, value: false } },
  data: {
    title: '', canAdd: false, pending: false, finished: false, showTeamPick: false,
    teamOptions: [], teamIndex: -1, legOptions: [], legIndex: -1, minutes: '', reason: '', rows: [],
  },
  lifetimes: {
    attached() { this.off = race.subscribe(() => this.render()); this.render(); },
    detached() { this.off && this.off(); },
  },
  methods: {
    render() {
      const { legId, teamId } = this.data;
      const ep = race.currentEpisode();
      const canAdd = teamId ? race.canManagePenaltyFor(teamId) : race.canManagePenalty();
      const teams = race.teams.filter((t) => race.canManagePenaltyFor(t.id));
      const allowed = race.currencyLegIds();
      // leg options: every leg of the episode, stations only their own legs; "other" is hosts only
      const legs = ((ep && ep.legs) || []).filter((l) => !allowed || allowed.includes(l.id)).map((l) => ({ id: l.id, label: `${l.type} · ${legName(l)}` }));
      if (auth.isHost) legs.push({ id: 0, label: '其他' });
      const totals = new Map();
      race.penalties.forEach((p) => totals.set(p.team_id, (totals.get(p.team_id) || 0) + p.minutes));
      // only original rows are shown (reverted ones struck through); reverse rows stay in the database and audit log
      const rows = race.penalties.filter((p) => !p.reverts_id && (!legId || p.leg_id === legId) && (!teamId || p.team_id === teamId)).map((p) => {
        const leg = p.leg_id ? race.legById.get(p.leg_id) : null;
        const by = race.penalties.find((x) => x.reverts_id === p.id);
        return {
          id: p.id, time: fmtDateTime(p.applied_at), team: p.team_name, legType: leg ? leg.type : '', legName: leg ? legName(leg) : (p.leg_name || '其他'),
          penalty: p.minutes > 0, amount: fmtPenMin(p.minutes), net: fmtPenMin(totals.get(p.team_id) || 0), by: p.applied_by_name || '-', reason: p.reason || '-',
          reverted: !!p.reverted, revertedBy: by ? by.applied_by_name || '' : '', canRevert: !p.reverted && race.canRevert(p.applied_by, p.team_id), minutes: p.minutes, teamId: p.team_id,
        };
      });
      this.teams = teams; this.legs = legs; this.totals = totals;
      this.setData({
        title: legId ? '本站点罚时与补时' : teamId ? '本队罚时与补时' : '罚时与补时',
        canAdd, pending: race.episodePending(), finished: race.episodeFinished(), showTeamPick: !teamId,
        teamOptions: teams.map((t) => t.label), legOptions: legs.map((l) => l.label), rows,
      });
    },
    pickTeam(e) { this.setData({ teamIndex: Number(e.detail.value) }); },
    pickLeg(e) { this.setData({ legIndex: Number(e.detail.value) }); },
    onInput(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
    add() { this.apply(1); },
    credit() { this.apply(-1); },
    async apply(sign) {
      const ep = race.currentEpisode(); if (!ep) return;
      const toast = (title) => wx.showToast({ title, icon: 'none' });
      const teamId = this.data.teamId || (this.teams[this.data.teamIndex] || {}).id;
      if (!teamId) { toast('请选择队伍'); return; }
      let legId = this.data.legId || null;
      if (!this.data.legId) {
        const leg = this.legs[this.data.legIndex];
        if (!leg) { toast('请选择环节'); return; }
        legId = leg.id || null;
      }
      const minutes = Number(this.data.minutes);
      if (!Number.isInteger(minutes) || minutes <= 0) { toast('分钟数必须是正整数，补时请用「补充时间」按钮'); return; }
      const team = (race.teamById.get(teamId) || {}).name || '';
      const reason = this.data.reason.trim() || (sign > 0 ? '罚时' : '补充时间');
      const cur = this.totals.get(teamId) || 0;
      const ok = await new Promise((r) => wx.showModal({
        title: sign > 0 ? '增加罚时' : '补充时间',
        content: `「${team}」${sign > 0 ? `增加 ${minutes} 分钟罚时` : `补充 ${minutes} 分钟时间（从最终用时中扣除）`}，原因：${reason}\n本赛段净罚时 ${cur} → ${cur + minutes * sign} 分钟`,
        success: (x) => r(x.confirm),
      }));
      if (!ok) return;
      try {
        await api(`/episodes/${ep.id}/penalties`, { method: 'POST', body: { teamId, minutes: minutes * sign, reason, legId } });
        this.setData({ minutes: '', reason: '' });
        await race.loadProgress();
        toast(sign > 0 ? `已增加 ${minutes} 分钟罚时` : `已补充 ${minutes} 分钟时间`);
      } catch (e) { toast(e.message); }
    },
    revert(e) {
      const p = this.data.rows.find((r) => r.id === e.currentTarget.dataset.id); if (!p) return;
      const what = p.minutes > 0 ? `${p.minutes} 分钟罚时` : `${-p.minutes} 分钟补时`;
      wx.showModal({
        title: '撤销记录', content: `撤销「${p.team}」的这条 ${what}（${p.reason}）？会写入一条反向记录，净罚时和名次相应恢复。`, confirmText: '撤销', confirmColor: '#b3261e',
        success: async (r) => {
          if (!r.confirm) return;
          try { await api(`/penalties/${p.id}/revert`, { method: 'POST' }); await race.loadProgress(); wx.showToast({ title: '已撤销', icon: 'none' }); } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
        },
      });
    },
  },
});
