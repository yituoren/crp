// Edit a record (the website's ProgressEditModal): start / end time, the leg's extra info and a note.
// open({ leg, team, progress }) shows it; empty times mean "not started" / "not finished".
const { api } = require('../../utils/api');
const race = require('../../utils/race');
const { legName, endLabel } = require('../../utils/types');

Component({
  options: { styleIsolation: 'apply-shared' },
  data: { show: false, title: '', label: '完成', type: '', form: {}, detourOptions: [], memberOptions: [], targetOptions: [], targetIndex: 0 },
  methods: {
    open({ leg, team, progress }) {
      const p = progress || {};
      this.leg = leg; this.team = team; this.saved = p;
      const targets = race.teams.filter((x) => x.id !== team.id);
      this.targets = targets;
      this.setData({
        show: true, title: `修改记录 · ${team.label} · ${legName(leg)}`, label: endLabel(leg.type), type: leg.type,
        form: { arrivedAt: p.arrived_at || '', completedAt: p.completed_at || '', detourChoice: p.detour_choice || '', roadblockBy: p.roadblock_by || '', ffResult: p.ff_result || '', note: p.note || '' },
        detourOptions: ['未选', leg.detour_a || 'A', leg.detour_b || 'B'],
        memberOptions: ['未选'].concat(race.memberOptions(team.id, p.roadblock_by, p.roadblock_by)),
        targetOptions: ['未使用'].concat(targets.map((t) => t.label)),
        targetIndex: p.target_team_id ? targets.findIndex((t) => t.id === p.target_team_id) + 1 : 0,
      });
    },
    setTime(e) { this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value || '' }); },
    pickDetour(e) { const i = Number(e.detail.value); this.setData({ 'form.detourChoice': i ? this.data.detourOptions[i] : '' }); },
    pickMember(e) { const i = Number(e.detail.value); this.setData({ 'form.roadblockBy': i ? this.data.memberOptions[i] : '' }); },
    pickFf(e) { this.setData({ 'form.ffResult': ['', 'success', 'fail'][Number(e.detail.value)] }); },
    pickTarget(e) { this.setData({ targetIndex: Number(e.detail.value) }); },
    onNote(e) { this.setData({ 'form.note': e.detail.value }); },
    close() { this.setData({ show: false }); },
    noop() {},
    async save() {
      const f = this.data.form;
      const target = this.data.targetIndex ? this.targets[this.data.targetIndex - 1].id : '';
      try {
        await api(`/progress/${this.leg.episode_id}/${this.team.id}/${this.leg.id}`, {
          method: 'PUT',
          body: { arrivedAt: f.arrivedAt || null, completedAt: f.completedAt || null, detourChoice: f.detourChoice, roadblockBy: f.roadblockBy, ffResult: f.ffResult, targetTeamId: target, note: f.note },
        });
        await race.loadProgress();
        wx.showToast({ title: '记录已更新', icon: 'none' });
        this.close();
      } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
    },
  },
});
