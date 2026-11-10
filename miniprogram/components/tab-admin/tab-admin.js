// Backstage (the website's AdminView): event settings with the shop items, members and hosts with join requests, and
// data management (this event's audit log for admins, deleting the event). Exporting a .crp file stays on the website.
const { api } = require('../../utils/api');
const race = require('../../utils/race');
const auth = require('../../utils/auth');
const { fmtDateTime } = require('../../utils/time');
const { confirm, toast } = require('../../utils/dialogs');

const MODES = [{ value: 'yuan', label: '经费（元）' }, { value: 'coin', label: '货币（币）' }];
const roleText = (r) => (r === 'admin' ? '管理员' : r === 'host' ? '主办' : '幕后');
const short = (s) => (s ? (s.length > 120 ? s.slice(0, 120) + '…' : s) : '');
/** wx.showModal with a text field; resolves with the text, or null when cancelled */
const prompt = (title, placeholder) => new Promise((resolve) => wx.showModal({
  title, editable: true, placeholderText: placeholder || '', confirmText: '永久删除', confirmColor: '#b3261e',
  success: (r) => resolve(r.confirm ? (r.content || '').trim() : null), fail: () => resolve(null),
}));

Component({
  options: { styleIsolation: 'apply-shared' },
  data: {
    tab: 'settings', isHost: false, isAdmin: false,
    settings: {}, modeLabels: MODES.map((m) => m.label), modeIndex: 0, items: [],
    members: [], requests: [], audit: [], auditTotal: 0,
  },
  lifetimes: {
    attached() {
      this.off = race.subscribe(() => this.renderMembers());
      this.setData({ isHost: auth.isHost, isAdmin: auth.isAdmin });
      this.fill();
      this.renderMembers();
    },
    detached() { this.off && this.off(); },
  },
  methods: {
    setTab(e) {
      const tab = e.currentTarget.dataset.tab;
      this.setData({ tab });
      if (tab === 'members') { race.loadUsers().catch(() => {}); this.loadRequests(); }
      if (tab === 'data' && auth.isAdmin) this.loadAudit();
    },

    // ---- settings ----
    fill() {
      const e = auth.event;
      this.setData({
        settings: { name: e.name, inviteCode: e.inviteCode || '', teamSize: String(e.teamSize), currencyMode: e.currencyMode, rbGap: String(e.rbGap) },
        modeIndex: Math.max(0, MODES.findIndex((m) => m.value === e.currencyMode)),
        items: race.shopItems.map((i) => ({ id: i.id, name: i.name, price: String(i.price), needsTarget: !!i.needs_target })),
      });
    },
    onField(e) { this.setData({ [`settings.${e.currentTarget.dataset.field}`]: e.detail.value }); },
    pickMode(e) { const i = Number(e.detail.value); this.setData({ modeIndex: i, 'settings.currencyMode': MODES[i].value }); },
    addItem() { this.setData({ items: this.data.items.concat([{ id: 0, name: '', price: '', needsTarget: false }]) }); },
    removeItem(e) { const items = this.data.items.slice(); items.splice(Number(e.currentTarget.dataset.i), 1); this.setData({ items }); },
    onItem(e) { const { i, field } = e.currentTarget.dataset; this.setData({ [`items[${i}].${field}`]: e.detail.value }); },
    onTarget(e) { this.setData({ [`items[${e.currentTarget.dataset.i}].needsTarget`]: e.detail.checked }); },
    /** Save everything: event settings first, then the shop items (coin mode) */
    async save() {
      const s = this.data.settings;
      const body = { name: s.name, inviteCode: s.inviteCode, teamSize: Number(s.teamSize), currencyMode: s.currencyMode, rbGap: Number(s.rbGap) };
      try {
        await api('/info', { method: 'PUT', body });
        // the shell keeps the event (name in the bar, money mode) in sync
        const d = await api('/info');
        this.triggerEvent('event', { event: d.event });
        if (s.currencyMode === 'coin') {
          await api('/shop/items', { method: 'PUT', body: { items: this.data.items.map((i) => ({ id: i.id || undefined, name: i.name.trim(), price: i.price, needsTarget: i.needsTarget })) } });
          await race.loadShopItems();
        }
        await Promise.all([race.loadTeams(), race.loadEpisodes(), race.loadLedger(), race.loadUsers()]);
        this.fill();
        toast('设置已保存');
      } catch (err) { toast(err.message); }
    },

    // ---- members and hosts: the creator is a fixed host, admin is global and not managed here ----
    renderMembers() {
      const me = auth.user && auth.user.id;
      const owner = auth.event.ownerId;
      this.setData({
        members: race.users.map((u) => {
          const fixed = u.role === 'admin' || u.id === me || u.id === owner;
          return { id: u.id, username: u.username, self: u.id === me, role: u.role, roleText: roleText(u.role), badge: u.role === 'crew' ? '' : 'badge-info', fixed, note: u.role === 'admin' ? '管理员' : u.id === owner ? '创建者' : '' };
        }),
      });
    },
    async setRole(e) {
      const u = this.data.members.find((x) => x.id === e.currentTarget.dataset.id); if (!u) return;
      const role = u.role === 'crew' ? 'host' : 'crew';
      const what = role === 'host' ? `把「${u.username}」设为本比赛主办？主办可以编辑赛段、排班、经费、罚时和设置。` : `取消「${u.username}」的主办身份？`;
      if (!(await confirm(role === 'host' ? '设为主办' : '取消主办', what, { danger: role === 'crew' }))) return;
      try { await api(`/members/${u.id}`, { method: 'PUT', body: { role } }); await race.loadUsers(); toast('已更新'); } catch (err) { toast(err.message); }
    },
    // join requests submitted with the invite code; approved users become crew
    async loadRequests() {
      try {
        const rows = (await api('/join-requests')).requests;
        this.setData({ requests: rows.map((r) => ({ id: r.id, username: r.username, note: r.note || '-', time: fmtDateTime(r.created_at) })) });
      } catch (e) { this.setData({ requests: [] }); }
    },
    async decide(e) {
      const { id, action } = e.currentTarget.dataset;
      const r = this.data.requests.find((x) => x.id === id); if (!r) return;
      if (action === 'reject' && !(await confirm('拒绝申请', `拒绝「${r.username}」的加入申请？对方可以再次申请。`, { danger: true, okText: '拒绝' }))) return;
      try {
        await api(`/join-requests/${id}/${action}`, { method: 'POST' });
        await Promise.all([this.loadRequests(), race.loadUsers()]);
        toast(action === 'approve' ? '已通过' : '已拒绝');
      } catch (err) { toast(err.message); }
    },

    // ---- data management ----
    async loadAudit() {
      try {
        const d = await api('/audit?limit=200');
        this.setData({
          auditTotal: d.total,
          audit: d.logs.map((l) => ({ id: l.id, time: fmtDateTime(l.created_at), user: l.username, action: l.action, target: `${l.target_type} ${l.target_id || ''}`.trim(), before: short(l.before), after: short(l.after) })),
        });
      } catch (err) { toast(err.message); }
    },
    /** The event name has to be typed again */
    async deleteEvent() {
      const name = auth.event.name;
      const typed = await prompt(`输入「${name}」确认删除`, name);
      if (typed === null) return;
      if (typed !== name) { toast('比赛名称不一致，未删除'); return; }
      this.triggerEvent('deleting');
      try {
        await api('', { method: 'DELETE', body: { name } });
        toast(`已删除比赛「${name}」`);
        setTimeout(() => wx.reLaunch({ url: '/pages/home/home' }), 800);
      } catch (err) { toast(err.message); }
    },
  },
});
