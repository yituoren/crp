// Inside an event (the website's phone shell): top bar, bottom navigation, drawer with every section,
// full-screen live board. The sections are filled in batch by batch.
const { api, setEventHash, setUnauthorizedHandler } = require('../../utils/api');
const realtime = require('../../utils/realtime');

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

Page({
  data: {
    loading: true, event: null, isHost: false, online: true,
    nav: NAV, bottom: NAV.filter((n) => BOTTOM.includes(n.name)), current: 'today', currentLabel: '我的',
    drawer: false, live: false, barTop: 20, barRow: 44, drawerWidth: 224,
  },

  onLoad(q) {
    this.hash = q.hash;
    setEventHash(this.hash);
    setUnauthorizedHandler(() => wx.reLaunch({ url: '/pages/login/login' }));
    realtime.onOnline((online) => this.setData({ online }));
    realtime.connect();
    this.enter();
  },
  onUnload() { realtime.disconnect(); setEventHash(''); },

  async enter() {
    try {
      const d = await api('/info');
      getApp().globalData.event = d.event;
      this.setData({ loading: false, event: d.event, isHost: d.event.myRole === 'host' || (getApp().globalData.user || {}).role === 'admin' });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
      setTimeout(() => wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/home/home' }) }), 1200);
    }
  },

  /** The drawer lines up with the top bar: below the status bar, its title in the bar's row */
  onBarMeasure(e) {
    const { top, row, left } = e.detail;
    this.setData({ barTop: top, barRow: row, drawerWidth: Math.min(224, left - 8) });
  },
  go(e) {
    const name = e.currentTarget.dataset.name;
    const item = NAV.find((n) => n.name === name) || { label: '后台' };
    this.setData({ current: name, currentLabel: item.label, drawer: false });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  openDrawer() { this.setData({ drawer: true }); },
  closeDrawer() { this.setData({ drawer: false }); },
  /** Swallows touch moves on the drawer and its scrim so the page behind does not scroll */
  noop() {},
  toggleLive() { this.setData({ live: !this.data.live, drawer: false }); },
  home() { wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/home/home' }) }); },
});
