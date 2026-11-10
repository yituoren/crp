// Entry page: signs in with WeChat at once; a WeChat user seen for the first time binds an account
// (existing crew ID + password, or a new one) and is signed in automatically from then on
const session = require('../../utils/session');

Page({
  data: { stage: 'loading', mode: 'login', username: '', password: '', password2: '', msg: '', busy: false },
  ticket: '',

  onLoad() { this.start(); },

  async start() {
    this.setData({ stage: 'loading', msg: '' });
    try {
      const r = await session.signIn();
      if (r.user) { wx.reLaunch({ url: '/pages/home/home' }); return; }
      this.ticket = r.ticket;
      this.setData({ stage: 'bind' });
    } catch (e) {
      this.setData({ stage: 'error', msg: e.message || '登录失败' });
    }
  },

  setMode(e) { this.setData({ mode: e.currentTarget.dataset.mode, msg: '' }); },
  onInput(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },

  async submit() {
    const { mode, username, password, password2 } = this.data;
    if (!username.trim() || !password) { this.setData({ msg: '请填写幕后ID和密码' }); return; }
    if (mode === 'register' && password !== password2) { this.setData({ msg: '两次输入的密码不一致' }); return; }
    this.setData({ busy: true, msg: '' });
    try {
      await session.bind(this.ticket, { username: username.trim(), password, register: mode === 'register' });
      wx.reLaunch({ url: '/pages/home/home' });
    } catch (e) {
      // an expired ticket: start over with a fresh wx.login
      if (e.status === 401 && /过期/.test(e.message)) { this.start(); return; }
      this.setData({ msg: e.message || '操作失败' });
    } finally {
      this.setData({ busy: false });
    }
  },
});
