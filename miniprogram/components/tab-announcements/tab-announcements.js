// Announcements (the website's AnnouncementsView): hosts post to everyone / all follows / hosts only, other crew to the hosts;
// hosts pin; authors and hosts delete. Viewing marks everything read.
const { api } = require('../../utils/api');
const race = require('../../utils/race');
const auth = require('../../utils/auth');
const { fmtDateMinute } = require('../../utils/time');

const AUDIENCES = [{ value: 'all', label: '全部幕后' }, { value: 'follows', label: '全体跟队' }, { value: 'hosts', label: '仅主办' }];

/** Who a non-public announcement was sent to */
function audienceText(a) {
  if (a === 'hosts') return '发给主办';
  if (a.startsWith('follows')) return '发给当时的全体跟队';
  const m = /^follow:(\d+):(\d+)$/.exec(a);
  if (!m) return '';
  const team = race.teamById.get(Number(m[2]));
  return `发给 ${team ? team.label : '队伍'} 跟队`;
}

Component({
  options: { styleIsolation: 'apply-shared' },
  data: { list: [], isHost: false, content: '', audienceIndex: 0, audiences: AUDIENCES, placeholder: '' },
  lifetimes: {
    attached() { this.off = race.subscribe(() => this.render()); this.render(); },
    detached() { this.off && this.off(); },
  },
  methods: {
    render() {
      const me = auth.user && auth.user.id;
      const isHost = auth.isHost;
      const list = race.announcements.map((a) => ({
        id: a.id, content: a.content, pinned: !!a.pinned_at, audience: audienceText(a.audience), meta: `${a.created_by} · ${fmtDateMinute(a.created_at)}`,
        canDelete: isHost || a.author_id === me,
      }));
      this.setData({ list, isHost, placeholder: this.placeholder(isHost) });
      if (race.unreadAnnouncements()) race.markAnnouncementsRead();
    },
    placeholder(isHost) {
      const aud = isHost ? AUDIENCES[this.data.audienceIndex].value : 'hosts';
      return aud === 'hosts' ? '写点什么，发给主办…' : aud === 'follows' ? '写点什么，发给全体跟队…' : '写点什么，发给所有幕后…';
    },
    onInput(e) { this.setData({ content: e.detail.value }); },
    onAudience(e) { this.setData({ audienceIndex: Number(e.detail.value) }); this.setData({ placeholder: this.placeholder(this.data.isHost) }); },
    async post() {
      const content = this.data.content;
      if (!content.trim()) { wx.showToast({ title: '内容不能为空', icon: 'none' }); return; }
      const audience = this.data.isHost ? AUDIENCES[this.data.audienceIndex].value : 'hosts';
      try {
        await api('/announcements', { method: 'POST', body: { content, audience } });
        this.setData({ content: '' });
        await race.loadAnnouncements();
        wx.showToast({ title: !this.data.isHost || audience === 'hosts' ? '已发给主办' : audience === 'follows' ? '已发给全体跟队' : '公告已发布', icon: 'none' });
      } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
    },
    async pin(e) {
      const { id, pinned } = e.currentTarget.dataset;
      try { await api(`/announcements/${id}/pin`, { method: 'POST', body: { pinned: !pinned } }); await race.loadAnnouncements(); } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
    },
    remove(e) {
      const id = e.currentTarget.dataset.id;
      wx.showModal({
        title: '删除公告', content: '确定删除这条公告？', confirmText: '删除', confirmColor: '#b3261e',
        success: async (r) => {
          if (!r.confirm) return;
          try { await api(`/announcements/${id}`, { method: 'DELETE' }); await race.loadAnnouncements(); } catch (err) { wx.showToast({ title: err.message, icon: 'none' }); }
        },
      });
    },
  },
});
