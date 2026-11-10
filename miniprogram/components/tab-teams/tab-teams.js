// Teams (the website's TeamsView): team cards; hosts add, edit (members, short name), withdraw / restore, delete, reset.
// Order: long-press a card to move it (numbers follow the order); the website drags instead.
const { api } = require('../../utils/api');
const race = require('../../utils/race');
const auth = require('../../utils/auth');
const { legName } = require('../../utils/types');
const { confirm, toast } = require('../../utils/dialogs');

Component({
  options: { styleIsolation: 'apply-shared' },
  data: { teams: [], total: 0, alive: 0, isHost: false, editing: null, members: [], shortName: '' },
  lifetimes: {
    attached() { this.off = race.subscribe(() => this.render()); this.render(); },
    detached() { this.off && this.off(); },
  },
  methods: {
    render() {
      const teams = race.teams.map((t) => {
        let info;
        if (t.status === 'eliminated' && t.eliminated_leg_id) { const l = race.legById.get(t.eliminated_leg_id); info = `在「${l ? legName(l) : '-'}」被淘汰`; }
        else if (t.status === 'withdrawn') info = '已退赛，之后的环节不再记录';
        else info = t.members.length ? t.members.join('、') : '未登记成员';
        return { id: t.id, label: t.label, status: t.status, statusText: { alive: '存活', eliminated: '已淘汰', withdrawn: '已退赛' }[t.status], info };
      });
      this.setData({ teams, total: race.teams.length, alive: race.aliveTeams().length, isHost: auth.isHost });
    },
    open(e) {
      const id = e.currentTarget.dataset.id;
      const t = id ? race.teamById.get(id) : null;
      const size = Math.max(1, auth.event.teamSize || 1);
      const members = t ? t.members.slice() : [];
      while (members.length < size) members.push('');
      this.setData({ editing: t ? { id: t.id, title: '编辑队伍' } : { id: 0, title: '新增队伍' }, members, shortName: t ? t.short_name : '' });
    },
    close() { this.setData({ editing: null }); },
    noop() {},
    onMember(e) { this.setData({ [`members[${Number(e.currentTarget.dataset.i)}]`]: e.detail.value }); },
    onShort(e) { this.setData({ shortName: e.detail.value }); },
    async save() {
      const body = { members: this.data.members, short_name: this.data.shortName };
      try {
        if (this.data.editing.id) await api(`/teams/${this.data.editing.id}`, { method: 'PUT', body });
        else await api('/teams', { method: 'POST', body });
        await race.loadTeams();
        this.close();
        toast('已保存');
      } catch (e) { toast(e.message); }
    },
    async setStatus(e) {
      const t = race.teamById.get(e.currentTarget.dataset.id); const status = e.currentTarget.dataset.status;
      const label = { alive: '恢复', withdrawn: '退赛' }[status];
      const msg = status === 'withdrawn' ? `确定将「${t.label}」标记为退赛？之前的记录保留，之后的环节不能再记录。` : `取消「${t.label}」的退赛状态？`;
      if (!(await confirm(`${label}队伍`, msg, { danger: status !== 'alive' }))) return;
      try { await api(`/teams/${t.id}`, { method: 'PUT', body: { status } }); await race.loadTeams(); toast(`已${label}`); } catch (err) { toast(err.message); }
    },
    async remove(e) {
      const t = race.teamById.get(e.currentTarget.dataset.id);
      if (!(await confirm('删除队伍', `删除「${t.label}」？其所有记录和货币日志也会被删除。`, { danger: true, okText: '删除' }))) return;
      try { await api(`/teams/${t.id}`, { method: 'DELETE' }); await race.loadTeams(); toast('已删除'); } catch (err) { toast(err.message); }
    },
    async resetAll() {
      if (!(await confirm('重置队伍数据', '所有队伍恢复为存活、余额清零（队名保留）。确定？', { danger: true }))) return;
      try { await api('/teams/reset', { method: 'POST' }); await race.loadTeams(); toast('已重置'); } catch (err) { toast(err.message); }
    },
    /** Long press: move the team; the server renumbers by the new order */
    move(e) {
      if (!this.data.isHost) return;
      const id = e.currentTarget.dataset.id;
      const ids = race.teams.map((t) => t.id);
      const i = ids.indexOf(id);
      wx.showActionSheet({
        itemList: ['上移', '下移', '移到最前', '移到最后'],
        success: async (r) => {
          const to = [i - 1, i + 1, 0, ids.length - 1][r.tapIndex];
          if (to < 0 || to >= ids.length || to === i) return;
          ids.splice(i, 1); ids.splice(to, 0, id);
          try { await api('/teams/order', { method: 'PUT', body: { ids } }); await race.loadTeams(); } catch (err) { toast(err.message); }
        },
      });
    },
  },
});
