// Inside an event (the website's phone shell): top bar, bottom navigation, drawer with every section, full-screen live
// board, and the system notices that pop up for a team's follows. Sections are components that read the shared race data.
const { api, setEventHash, setUnauthorizedHandler } = require('../../utils/api');
const realtime = require('../../utils/realtime');
const race = require('../../utils/race');
const auth = require('../../utils/auth');
const { setMoneyMode } = require('../../utils/money');
const { fmtDateMinute } = require('../../utils/time');

const NAV = [
  { name: 'today', label: '我的', icon: 'person' },
  { name: 'announcements', label: '公告', icon: 'campaign' },
  { name: 'episodes', label: '赛段', icon: 'flag' },
  { name: 'schedule', label: '排班', icon: 'schedule' },
  { name: 'teams', label: '队伍', icon: 'group' },
  { name: 'currency', label: '经费', icon: 'payments' },
  { name: 'progress', label: '进度', icon: 'leaderboard' },
];
const BOTTOM = ['today', 'announcements', 'episodes', 'currency', 'progress'];
const PORTED = ['announcements', 'progress'];

Page({
  data: {
    loading: true, event: null, isHost: false, online: true, unread: 0,
    nav: NAV, bottom: NAV.filter((n) => BOTTOM.includes(n.name)), current: 'today', currentLabel: '我的', ported: true,
    drawer: false, live: false, barTop: 20, barRow: 44, drawerWidth: 224,
    popups: [], undecided: false, answering: false,
  },

  onLoad(q) {
    this.hash = q.hash;
    setEventHash(this.hash);
    setUnauthorizedHandler(() => wx.reLaunch({ url: '/pages/login/login' }));
    this.off = race.subscribe(() => this.render());
    this.onInvalidate = (m) => { if (race.loaded) race.invalidate(m.scope, m.episodeId).catch(() => {}); };
    this.onReconnect = () => { if (race.loaded) race.loadAll().catch(() => {}); };
    realtime.on('invalidate', this.onInvalidate);
    realtime.on('connect', this.onReconnect);
    realtime.onOnline((online) => this.setData({ online }));
    realtime.connect();
    if (q.tab) this.setTab(q.tab);
    this.enter();
  },
  onUnload() {
    this.off && this.off();
    realtime.off('invalidate', this.onInvalidate);
    realtime.off('connect', this.onReconnect);
    realtime.disconnect();
    setEventHash('');
  },

  async enter() {
    try {
      const d = await api('/info');
      getApp().globalData.event = d.event;
      setMoneyMode(d.event.currencyMode);
      race.reset();
      this.setData({ event: d.event, isHost: auth.isHost });
      await race.loadAll();
      this.setData({ loading: false });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
      setTimeout(() => wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/home/home' }) }), 1200);
    }
  },

  render() {
    const popups = race.popupAnnouncements().map((a) => ({
      id: a.id, content: a.content, time: fmtDateMinute(a.created_at), effectId: a.effect_id, warning: !!a.effect_id,
      shield: !!(a.effect_id && a.options && a.options.shield), reflect: !!(a.effect_id && a.options && a.options.reflect),
    }));
    // a hit notice whose team can still shield or reflect has to be answered before it can be closed
    const undecided = popups.some((p) => p.shield || p.reflect);
    this.setData({ unread: race.unreadAnnouncements(), popups, undecided });
  },

  /** The drawer lines up with the top bar: below the status bar, its title in the bar's row */
  onBarMeasure(e) {
    const { top, row, left } = e.detail;
    this.setData({ barTop: top, barRow: row, drawerWidth: Math.min(224, left - 8) });
  },
  setTab(name) {
    const item = NAV.find((n) => n.name === name) || { label: '后台' };
    this.setData({ current: name, currentLabel: item.label, ported: PORTED.includes(name), drawer: false, live: false });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  go(e) { this.setTab(e.currentTarget.dataset.name); },
  openDrawer() { this.setData({ drawer: true }); },
  closeDrawer() { this.setData({ drawer: false }); },
  /** Swallows touch moves on the drawer and its scrim so the page behind does not scroll */
  noop() {},
  toggleLive() { this.setData({ live: !this.data.live, drawer: false }); },
  home() { wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/home/home' }) }); },

  async answer(e) {
    const { id, answer } = e.currentTarget.dataset;
    const text = { shield: '使用护盾挡下这次作用', reflect: '使用反弹，把作用转给使用者', accept: '不使用护盾或反弹，原地等待' }[answer];
    const ok = await new Promise((r) => wx.showModal({ title: '确认', content: `${text}？`, success: (x) => r(x.confirm) }));
    if (!ok) return;
    this.setData({ answering: true });
    try { await race.answerTwist(id, answer); } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
    this.setData({ answering: false });
  },
  dismiss() { if (!this.data.undecided) race.dismissPopup(); },
});
