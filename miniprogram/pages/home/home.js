// Event list (the website's home page): my events / all events, search; tapping a joined event opens it,
// any other event asks for its invite code (membership after the host approves)
const { api } = require('../../utils/api');
const session = require('../../utils/session');
const { fmtDate } = require('../../utils/time');

const STATUS_TEXT = { pending: '未开始', running: '进行中', finished: '已结束' };
const roleText = (e) => (!e.joined ? (e.pending ? '待审核' : '未加入') : e.role === 'admin' ? '管理员' : e.role === 'host' ? '主办' : '幕后');
const snippet = (e) => [e.ownerName ? `主办 ${e.ownerName}` : '', `${e.memberCount} 名幕后`].filter(Boolean).join(' · ');

Page({
  data: { loading: true, tab: 'mine', q: '', rows: [], mineCount: 0, allCount: 0, emptyText: '', joining: null, code: '', note: '' },
  events: [],

  onShow() { this.load(); },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  async load() {
    try {
      const d = await api('/events');
      this.events = d.all.map((e) => Object.assign({}, e, {
        roleText: roleText(e), roleCls: e.joined ? e.role : 'none', statusText: STATUS_TEXT[e.status], snippet: snippet(e), date: fmtDate(e.createdAt),
      }));
      this.filter();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  filter() {
    const { tab, q } = this.data;
    const kw = q.trim().toLowerCase();
    const rows = this.events.filter((e) => (tab === 'all' || e.joined) && (!kw || e.name.toLowerCase().includes(kw) || e.ownerName.toLowerCase().includes(kw)));
    const noneJoined = !this.events.some((e) => e.joined);
    this.setData({
      rows,
      mineCount: this.events.filter((e) => e.joined).length,
      allCount: this.events.length,
      emptyText: tab === 'mine' && noneJoined ? '还没有加入任何比赛，到「全部比赛」里凭邀请码加入' : '没有符合条件的比赛',
    });
  },
  setTab(e) { this.setData({ tab: e.currentTarget.dataset.tab }); this.filter(); },
  onSearch(e) { this.setData({ q: e.detail.value }); this.filter(); },
  clearSearch() { this.setData({ q: '' }); this.filter(); },

  openRow(e) {
    const ev = this.events.find((x) => x.hash === e.currentTarget.dataset.hash);
    if (!ev) return;
    if (ev.joined) { wx.navigateTo({ url: `/pages/event/event?hash=${ev.hash}` }); return; }
    if (ev.pending) { wx.showToast({ title: '已提交申请，等待主办审核', icon: 'none' }); return; }
    this.setData({ joining: { hash: ev.hash, name: ev.name }, code: '', note: '' });
  },
  onInput(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  closeJoin() { this.setData({ joining: null }); },
  async join() {
    const code = this.data.code.trim();
    if (!code) { wx.showToast({ title: '请输入邀请码', icon: 'none' }); return; }
    try {
      await api('/events/join', { method: 'POST', body: { code, note: this.data.note.trim(), hash: this.data.joining.hash } });
      this.setData({ joining: null });
      wx.showToast({ title: '已提交申请，等待主办审核', icon: 'none' });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  /** Account menu: account management, or removing this WeChat binding (the next visit asks for ID + password again) */
  account() {
    const user = getApp().globalData.user;
    wx.showActionSheet({
      alertText: user ? `当前账号：${user.displayName}` : '',
      itemList: ['账号管理', '解除微信绑定并退出'],
      success: async (r) => {
        if (r.tapIndex === 0) { wx.navigateTo({ url: '/pages/account/account' }); return; }
        try { await api('/auth/wx-unbind', { method: 'POST' }); } catch (e) { /* signed out anyway */ }
        session.signOut();
        wx.reLaunch({ url: '/pages/login/login' });
      },
    });
  },
});
