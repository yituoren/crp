// Schedule (the website's ScheduleView): every crew member's role in the episode. Hosts edit: role, the team a follow
// follows, the legs a station covers (several), then save; or copy the previous episode's follows.
const { api } = require('../../utils/api');
const race = require('../../utils/race');
const auth = require('../../utils/auth');
const { legName } = require('../../utils/types');
const { confirm, toast } = require('../../utils/dialogs');

const ROLES = [{ value: 'crew', label: '机动' }, { value: 'follow', label: '跟队' }, { value: 'station', label: '站点' }, { value: 'live', label: '直播员' }];
const BADGE = { admin: ['管理员', 'badge-warning'], host: ['主办', 'badge-warning'], follow: ['跟队', 'badge-info'], station: ['站点', 'badge-success'], live: ['直播员', 'badge-live'], crew: ['机动', ''] };

Component({
  options: { styleIsolation: 'apply-shared' },
  data: { rows: [], isHost: false, roleLabels: ROLES.map((r) => r.label), teamLabels: [], conflicts: '', unassigned: '', picking: null, pickLegs: [] },
  lifetimes: {
    attached() { this.form = null; this.epId = 0; this.off = race.subscribe(() => this.render()); this.render(); },
    detached() { this.off && this.off(); },
  },
  methods: {
    /** The editable rows follow the saved assignments, rebuilt when they or the episode change */
    rebuild() {
      this.form = race.users.filter((u) => !u.disabled).map((u) => {
        const a = race.assignments.find((x) => x.user_id === u.id);
        return { userId: u.id, role: a ? a.role : 'crew', teamId: a && a.team_id ? a.team_id : '', legIds: a && a.leg_ids ? a.leg_ids.slice() : [] };
      });
    },
    render(keepForm) {
      const ep = race.currentEpisode(); if (!ep) return;
      const key = JSON.stringify([ep.id, race.assignments, race.users.map((u) => u.id)]);
      if (!keepForm && key !== this.key) { this.key = key; this.rebuild(); }
      const users = new Map(race.users.map((u) => [u.id, u]));
      this.teams = race.teams;
      this.legs = ep.legs.filter((l) => l.needs_staff);
      const rows = this.form.map((r, i) => {
        const a = race.assignments.find((x) => x.user_id === r.userId);
        const u = users.get(r.userId);
        const badge = a ? BADGE[a.role] : BADGE[u && u.role === 'admin' ? 'admin' : u && u.role === 'host' ? 'host' : 'crew'];
        const legs = a && a.role === 'station' ? (a.leg_ids || []).map((id) => race.legById.get(id)).filter(Boolean).map((l) => ({ id: l.id, type: l.type, name: legName(l) })) : [];
        const detail = !a ? '-' : a.role === 'follow' ? a.team_name || '?' : a.role === 'live' ? '全赛段（只读）' : legs.length ? '' : '?';
        const team = r.teamId ? race.teamById.get(Number(r.teamId)) : null;
        return {
          i, userId: r.userId, name: u ? u.displayName : '?', badge: badge[0], badgeCls: badge[1], detail, legs,
          roleIndex: ROLES.findIndex((x) => x.value === r.role), role: r.role,
          teamText: team ? team.label : '选择队伍', teamSet: !!team,
          legText: r.legIds.length ? `${r.legIds.length} 个环节` : '选择环节（可多选）', legSet: r.legIds.length > 0,
        };
      });
      // a team with several follows; alive teams nobody follows
      const count = new Map();
      this.form.forEach((r) => { if (r.role === 'follow' && r.teamId) count.set(Number(r.teamId), (count.get(Number(r.teamId)) || 0) + 1); });
      const conflicts = Array.from(count).filter(([, n]) => n > 1).map(([id]) => (race.teamById.get(id) || {}).label || id).join('、');
      const unassigned = race.aliveTeams().filter((t) => !this.form.some((r) => r.role === 'follow' && Number(r.teamId) === t.id)).map((t) => t.label).join('、');
      this.setData({
        rows, isHost: auth.isHost, conflicts, unassigned,
        teamLabels: race.teams.map((t) => `${t.label}${t.status !== 'alive' ? '（已淘汰）' : ''}`),
      });
    },
    pickRole(e) { const i = Number(e.currentTarget.dataset.i); this.form[i].role = ROLES[Number(e.detail.value)].value; this.render(true); },
    pickTeam(e) { const i = Number(e.currentTarget.dataset.i); this.form[i].teamId = this.teams[Number(e.detail.value)].id; this.render(true); },
    /** Station legs: a sheet with a checkbox per staffed leg */
    openLegs(e) {
      const i = Number(e.currentTarget.dataset.i);
      const sel = this.form[i].legIds;
      this.setData({ picking: { i, name: this.data.rows[i].name }, pickLegs: this.legs.map((l) => ({ id: l.id, type: l.type, name: legName(l), on: sel.includes(l.id) })) });
    },
    toggleLeg(e) { const k = Number(e.currentTarget.dataset.k); this.setData({ [`pickLegs[${k}].on`]: !this.data.pickLegs[k].on }); },
    closeLegs() { this.setData({ picking: null }); },
    doneLegs() {
      this.form[this.data.picking.i].legIds = this.data.pickLegs.filter((l) => l.on).map((l) => l.id);
      this.setData({ picking: null });
      this.render(true);
    },
    noop() {},
    async save() {
      const ep = race.currentEpisode(); if (!ep) return;
      const users = new Map(race.users.map((u) => [u.id, u]));
      for (const r of this.form) {
        const name = (users.get(r.userId) || {}).displayName;
        if (r.role === 'follow' && !r.teamId) { toast(`${name} 是跟队但没选队伍`); return; }
        if (r.role === 'station' && !r.legIds.length) { toast(`${name} 是站点但没选环节，至少选一个`); return; }
      }
      try {
        await api(`/episodes/${ep.id}/assignments`, { method: 'PUT', body: { items: this.form } });
        this.key = '';
        await race.loadAssignments();
        toast('排班已保存并同步');
      } catch (err) { toast(err.message); }
    },
    async copyPrev() {
      const ep = race.currentEpisode(); if (!ep) return;
      const idx = race.episodes.findIndex((x) => x.id === ep.id);
      const prev = race.episodes[idx - 1];
      if (!prev) { toast('没有上一赛段'); return; }
      if (!(await confirm('复制排班', `用 ${prev.code} 的跟队安排覆盖 ${ep.code} 当前排班？（站点需重新指定）`))) return;
      try { await api(`/episodes/${ep.id}/assignments/copy-from/${prev.id}`, { method: 'POST' }); this.key = ''; await race.loadAssignments(); toast('已复制'); } catch (err) { toast(err.message); }
    },
  },
});
