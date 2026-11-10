// Account (the website's AccountView): my account for everyone (rename, password, WeChat binding); admins also manage
// accounts and read the full audit log. Backup and reset stay on the website (file export / import, irreversible).
const { api } = require('../../utils/api');
const session = require('../../utils/session');
const { fmtDateTime } = require('../../utils/time');
const { confirm, toast } = require('../../utils/dialogs');

/** wx.showModal with a text field; resolves with the text, or null when cancelled */
const prompt = (title, value, placeholder) => new Promise((resolve) => wx.showModal({
  title, editable: true, content: value || '', placeholderText: placeholder || '',
  success: (r) => resolve(r.confirm ? (r.content || '').trim() : null), fail: () => resolve(null),
}));

Page({
  data: {
    isAdmin: false, tab: 'me', me: {}, role: '', initial: '?', renaming: false, newName: '',
    pw: { oldPassword: '', newPassword: '', newPassword2: '' }, pwMsg: '',
    users: [], audit: [], auditTotal: 0,
  },

  async onLoad() {
    const user = getApp().globalData.user;
    const isAdmin = !!user && user.role === 'admin';
    this.setData({ isAdmin, tab: isAdmin ? 'users' : 'me' });
    await this.loadMe();
    if (isAdmin) { this.loadUsers(); this.loadAudit(); }
  },
  onBack() { wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/home/home' }) }); },
  setTab(e) { const tab = e.currentTarget.dataset.tab; this.setData({ tab }); if (tab === 'audit') this.loadAudit(); },

  async loadMe() {
    try {
      const user = await session.loadMe();
      const app = getApp().globalData;
      // admin is global; host means hosting any event
      const role = user.role === 'admin' ? '管理员' : app.hostAnywhere ? '主办' : '幕后';
      this.setData({ me: Object.assign({}, user, { created: fmtDateTime(user.createdAt) }), role, initial: (user.displayName || '?').slice(0, 1).toUpperCase() });
    } catch (e) { toast(e.message); }
  },

  // ---- My account ----
  openRename() { this.setData({ renaming: true, newName: this.data.me.username }); },
  cancelRename() { this.setData({ renaming: false }); },
  onNewName(e) { this.setData({ newName: e.detail.value }); },
  async saveRename() {
    const u = this.data.newName.trim();
    if (!u) { toast('请填写新的ID'); return; }
    try { await api('/auth/profile', { method: 'PUT', body: { username: u } }); this.setData({ renaming: false }); await this.loadMe(); toast('ID 已修改'); } catch (e) { toast(e.message); }
  },
  onPw(e) { this.setData({ [`pw.${e.currentTarget.dataset.field}`]: e.detail.value }); },
  async changePassword() {
    const pw = this.data.pw;
    this.setData({ pwMsg: '' });
    if (pw.newPassword !== pw.newPassword2) { this.setData({ pwMsg: '两次新密码不一致' }); return; }
    try {
      await api('/auth/change-password', { method: 'POST', body: { oldPassword: pw.oldPassword, newPassword: pw.newPassword } });
      this.setData({ pw: { oldPassword: '', newPassword: '', newPassword2: '' } });
      toast('密码修改成功');
    } catch (e) { this.setData({ pwMsg: e.message }); }
  },
  /** The next visit asks for the crew ID and password again */
  async unbind() {
    if (!(await confirm('解除微信绑定', '解除后会退出小程序，下次进入需要重新输入幕后ID和密码绑定。', { danger: true, okText: '解除' }))) return;
    try { await api('/auth/wx-unbind', { method: 'POST' }); } catch (e) { /* signed out anyway */ }
    session.signOut();
    wx.reLaunch({ url: '/pages/login/login' });
  },

  // ---- Accounts (admin) ----
  async loadUsers() {
    try {
      const me = this.data.me.id;
      const users = (await api('/users')).users.map((u) => Object.assign({}, u, { created: fmtDateTime(u.created_at), self: u.id === me }));
      this.setData({ users });
    } catch (e) { toast(e.message); }
  },
  userOf(e) { return this.data.users.find((u) => u.id === e.currentTarget.dataset.id); },
  async renameUser(e) {
    const u = this.userOf(e); if (!u) return;
    const name = await prompt(`为「${u.username}」设置新的ID`, u.username);
    if (!name || name === u.username) return;
    try { await api(`/users/${u.id}`, { method: 'PUT', body: { username: name } }); await this.loadUsers(); toast('ID 已修改'); } catch (err) { toast(err.message); }
  },
  async resetPassword(e) {
    const u = this.userOf(e); if (!u) return;
    const pw = await prompt(`为「${u.username}」设置新密码`, '', '至少 4 位');
    if (!pw) return;
    try { await api(`/users/${u.id}/reset-password`, { method: 'POST', body: { password: pw } }); toast('密码已重置，请告知本人'); } catch (err) { toast(err.message); }
  },
  async toggleDisabled(e) {
    const u = this.userOf(e); if (!u) return;
    try { await api(`/users/${u.id}`, { method: 'PUT', body: { disabled: !u.disabled } }); await this.loadUsers(); } catch (err) { toast(err.message); }
  },
  async deleteUser(e) {
    const u = this.userOf(e); if (!u) return;
    if (!(await confirm('删除账号', `删除「${u.username}」？其排班会一并删除，历史记录保留。`, { danger: true, okText: '删除' }))) return;
    try { await api(`/users/${u.id}`, { method: 'DELETE' }); await this.loadUsers(); } catch (err) { toast(err.message); }
  },

  // ---- Full audit log (admin) ----
  async loadAudit() {
    const short = (s) => (s ? (s.length > 120 ? s.slice(0, 120) + '…' : s) : '');
    try {
      const d = await api('/system/audit?limit=200');
      this.setData({
        auditTotal: d.total,
        audit: d.logs.map((l) => ({ id: l.id, time: fmtDateTime(l.created_at), event: l.event_id || '-', user: l.username, action: l.action, target: `${l.target_type} ${l.target_id}`, before: short(l.before), after: short(l.after) })),
      });
    } catch (e) { toast(e.message); }
  },
});
