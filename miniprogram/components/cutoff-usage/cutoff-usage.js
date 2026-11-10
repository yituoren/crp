// Cutoff uses on a leg (the website's CutoffUsage): per team, each cutoff's use count and countdown; hosts open a team's
// uses and delete one (a coin charge is refunded, the countdown follows the remaining uses).
const { api } = require('../../utils/api');
const race = require('../../utils/race');
const auth = require('../../utils/auth');
const { onTick } = require('../../utils/ticker');
const { fmtTimeSec } = require('../../utils/time');
const { confirm, toast } = require('../../utils/dialogs');

const countdown = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? `${h}:` : '') + `${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; };

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { legId: { type: Number, value: 0 } },
  data: { show: false, rows: [], isHost: false, editing: null, uses: [] },
  lifetimes: {
    attached() {
      this.off = race.subscribe(() => this.render());
      this.offTick = onTick(() => this.render(true));
      this.render();
    },
    detached() { this.off && this.off(); this.offTick && this.offTick(); },
  },
  methods: {
    render(tickOnly) {
      const leg = race.legById.get(this.data.legId);
      if (!leg || !leg.cutoffs.length) { if (this.data.show) this.setData({ show: false }); return; }
      const rows = race.teams.map((t) => ({
        id: t.id, label: t.label,
        cells: leg.cutoffs.map((cf) => {
          const used = race.cutoffUseCount(t.id, cf.id);
          const ready = race.cutoffReadyAt(t.id, leg, cf);
          return { id: cf.id, name: cf.name, text: ready === null ? `${used} 次` : `${used} 次 · ${ready - auth.nowMs <= 0 ? '可用' : countdown(ready - auth.nowMs)}` };
        }),
      }));
      const json = JSON.stringify(rows);
      if (tickOnly && json === this.json) return;
      this.json = json;
      this.setData({ show: true, rows, isHost: auth.isHost });
      if (this.data.editing) this.openUses(this.data.editing.id);
    },
    edit(e) { this.openUses(e.currentTarget.dataset.id); },
    openUses(teamId) {
      const t = race.teamById.get(teamId);
      const locked = race.episodeFinished() || race.teamLocked(teamId);
      const uses = race.cutoffUses.filter((u) => u.leg_id === this.data.legId && u.team_id === teamId)
        .map((u) => ({ id: u.id, time: fmtTimeSec(u.used_at), name: u.cutoff_name, by: u.used_by_name, locked }));
      this.setData({ editing: { id: teamId, title: `熔断记录 · ${t ? t.label : ''}` }, uses });
    },
    close() { this.setData({ editing: null }); },
    noop() {},
    async remove(e) {
      if (!(await confirm('删除使用记录', '删除这次熔断使用？若扣过币会一并退回，倒计时按剩余记录重新计算。', { danger: true, okText: '删除' }))) return;
      try { await api(`/cutoff-uses/${e.currentTarget.dataset.id}`, { method: 'DELETE' }); await Promise.all([race.loadProgress(), race.loadTeams(), race.loadLedger()]); toast('已删除'); } catch (err) { toast(err.message); }
    },
  },
});
