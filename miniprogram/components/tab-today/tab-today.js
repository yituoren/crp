// "Mine" (the website's TodayView): what this crew member does in the episode.
// Follow: the team's balance, current leg, its records and penalties. Station: each leg it covers. Live: read-only links.
const race = require('../../utils/race');
const auth = require('../../utils/auth');
const { legName, stockText } = require('../../utils/types');
const { fmtMoney, moneyUnit, moneyMode } = require('../../utils/money');

Component({
  options: { styleIsolation: 'apply-shared' },
  data: { role: '', team: null, legs: [], epCode: '', pending: false, finished: false, hint: null, isHost: false },
  lifetimes: {
    attached() { this.off = race.subscribe(() => this.render()); this.render(); },
    detached() { this.off && this.off(); },
  },
  methods: {
    render() {
      const ep = race.currentEpisode();
      if (!ep) return;
      const my = race.myAssignment();
      const t = my && my.team_id ? race.teamById.get(my.team_id) : null;
      const team = t ? { id: t.id, label: t.label, balance: `${fmtMoney(t.currency)} ${moneyUnit()}` } : null;
      // a station may cover several legs: in leg order
      const legs = my && my.role === 'station' ? ep.legs.filter((l) => (my.leg_ids || []).includes(l.id)).map((l) => ({
        id: l.id, type: l.type, name: legName(l), address: l.address, mapUrl: l.map_url,
        open: l.open_time || l.close_time ? `${l.open_time || '-'} ~ ${l.close_time || '-'}` : '',
        shop: moneyMode() === 'coin' && l.shop.length ? l.shop.map((s) => `${s.name} ${stockText(s)}`).join('；') : '',
        judge: l.judge_criteria || '',
      })) : [];
      this.setData({
        role: my ? my.role : '', team, legs, epCode: ep.code, isHost: auth.isHost,
        legNames: legs.map((l) => l.name).join('、'),
        pending: race.episodePending(), finished: race.episodeFinished(), hint: this.hint(ep, t),
      });
    },
    /**
     * Continuous episodes overlap their predecessor: point the follow at the episode the team is actually in. Viewing the
     * earlier one after the team checked in there → the later one; viewing the later one before the team departed → the earlier one.
     */
    hint(e, t) {
      if (!t || e.status !== 'running') return null;
      const i = race.episodes.findIndex((x) => x.id === e.id);
      const next = race.episodes[i + 1], prev = race.episodes[i - 1];
      const ps = e.legs.slice().reverse().find((l) => l.type === 'PS');
      if (next && next.status === 'running' && ps && (race.progressOf(t.id, ps.id) || {}).completed_at) return { text: `本队已在 ${e.code} 中继站签到，${next.code} 已经开始`, epId: next.id, code: next.code };
      if (e.continuous_wait_min !== null && prev && prev.status === 'running' && !e.legs.some((l) => (race.progressOf(t.id, l.id) || {}).arrived_at)) return { text: `本队还没有出发进入 ${e.code}，${prev.code} 仍在进行`, epId: prev.id, code: prev.code };
      return null;
    },
    switchEp() { if (this.data.hint) race.selectEpisode(this.data.hint.epId); },
    openShop(e) { const c = this.selectComponent('#shop'); if (c && this.data.team) c.open({ teamId: this.data.team.id, legId: e.detail.legId }); },
    openMap(e) { const url = e.currentTarget.dataset.url; if (url) wx.setClipboardData({ data: url, success: () => wx.showToast({ title: '地图链接已复制', icon: 'none' }) }); },
    go(e) { this.triggerEvent('go', { name: e.currentTarget.dataset.name }); },
  },
});
