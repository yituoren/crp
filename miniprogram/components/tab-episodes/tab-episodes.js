// Episodes (the website's EpisodesView): the episode's summary and, for hosts, start / finish / edit / reset / delete;
// then its legs (tap to open; hosts add legs, delete them, and long-press to move them — the Starting Line and the pit stop stay put).
const { api } = require('../../utils/api');
const race = require('../../utils/race');
const auth = require('../../utils/auth');
const { legName, endLabel } = require('../../utils/types');
const { fmtDateTime } = require('../../utils/time');
const { fmtMoney, moneyUnit, moneyLabel, moneyMode } = require('../../utils/money');
const { confirm, toast } = require('../../utils/dialogs');

const STATUS = { pending: '未开始', running: '进行中', finished: '已结束' };
const STATUS_OPTIONS = [{ value: 'pending', label: '未开始' }, { value: 'running', label: '进行中' }, { value: 'finished', label: '已结束' }];
const isFixed = (l) => l.type === 'SL' || l.type === 'PS';

Component({
  options: { styleIsolation: 'apply-shared' },
  data: { ep: null, legs: [], isHost: false, editable: false, editing: false, form: {}, statusLabels: STATUS_OPTIONS.map((s) => s.label), label: '经费', unit: '元' },
  lifetimes: {
    attached() { this.off = race.subscribe(() => this.render()); this.render(); },
    detached() { this.off && this.off(); },
  },
  methods: {
    isFirst(ep) { return !!race.episodes[0] && race.episodes[0].id === ep.id; },
    render() {
      const ep = race.currentEpisode();
      if (!ep) { this.setData({ ep: null, legs: [], isHost: auth.isHost }); return; }
      const alive = race.aliveTeams();
      const staffOf = (id) => race.assignments.filter((a) => a.role === 'station' && (a.leg_ids || []).includes(id)).map((a) => a.display_name);
      const legs = ep.legs.map((l) => {
        const done = alive.filter((t) => (race.progressOf(t.id, l.id) || {}).completed_at).length;
        const running = alive.filter((t) => { const p = race.progressOf(t.id, l.id); return p && p.arrived_at && !p.completed_at; }).length;
        const extras = [`${done} 已${endLabel(l.type)}`, `${running} 进行中`, `${l.attachments.length} 附件`];
        if (l.shop_open && moneyMode() === 'coin') extras.push('开放商店');
        if (l.can_eliminate) extras.push(`淘汰 ${l.eliminate_count} 队`);
        if (l.cutoffs.length) extras.push(`熔断 ${l.cutoffs.length} 种`);
        return { id: l.id, type: l.type, name: legName(l), staff: l.needs_staff ? staffOf(l.id).join('、') || '未分配' : '无需站点', address: l.address || '无', extras: extras.join(' · '), fixed: isFixed(l) };
      });
      // summary line (as on the website)
      const parts = [`补充${moneyLabel()}：${ep.budget ? `${fmtMoney(ep.budget)} ${moneyUnit()}/队` : '本赛段不发'}`];
      if (ep.started_at) parts.push(`开始于 ${fmtDateTime(ep.started_at)}${ep.budget ? (ep.continuous_wait_min !== null ? '（各队发车时补充到余额）' : '（已补充到各队余额）') : ''}`);
      const auto = this.autoStart(ep);
      if (auto && (!ep.started_at || ep.continuous_wait_min !== null)) parts.push(auto);
      if (ep.finished_at) parts.push(`结束于 ${fmtDateTime(ep.finished_at)}`);
      if (ep.eliminate_count) parts.push(`赛段淘汰 ${ep.eliminate_count} 队（所有队伍签到后，按签到加本赛段净罚时，最后 ${ep.eliminate_count} 队淘汰${ep.status === 'finished' ? '，已锁定' : ''}）`);
      this.setData({
        ep: { id: ep.id, code: ep.code, name: ep.name, status: ep.status, statusText: STATUS[ep.status], notes: ep.notes, summary: parts.join(' · '), legCount: ep.legs.length },
        legs, isHost: auth.isHost, editable: auth.isHost && (auth.isAdmin || ep.status === 'pending'), label: moneyLabel(), unit: moneyUnit(),
      });
    },
    autoStart(e) {
      if (e.continuous_wait_min !== null) return `连续赛段：各队在上一赛段中继站签到 ${e.continuous_wait_min} m 后发车（罚时本队多等，补时其他队多等），第一支队伍发车时自动开始`;
      if (!e.start_at) return '';
      const stagger = e.inherit_rank && !this.isFirst(e) && e.start_gap_min > 0;
      return `${fmtDateTime(e.start_at)} 自动开始${stagger ? `，按上一赛段名次每隔 ${e.start_gap_min} m 发车` : '，各队同时出发'}`;
    },
    openLeg(e) { wx.navigateTo({ url: `/pages/leg/leg?episodeId=${this.data.ep.id}&legId=${e.currentTarget.dataset.id}` }); },

    // ---- episode actions (hosts) ----
    async startEpisode() {
      const ep = race.currentEpisode(); if (!ep) return;
      const alive = race.aliveTeams().length;
      const msg = ep.started_at ? `${ep.code} 之前已经开始过，经费不会重复发放，只把状态改回「进行中」。确定？`
        : ep.budget > 0 ? `将 ${ep.code} 标记为进行中，并给 ${alive} 支存活队伍各补充 ${fmtMoney(ep.budget)} ${moneyUnit()}（加到现有余额上，写入流水）。确定？`
          : `${ep.code} 未设置补充${moneyLabel()}，只把状态标记为进行中。确定？`;
      const continuous = ep.continuous_wait_min !== null;
      const intro = continuous
        ? `手动开始只供测试使用，连续赛段会在第一支队伍发车时自动开始。手动开始后各队仍按上一赛段签到时间加 ${ep.continuous_wait_min} m 发车（罚时本队多等，补时其他队多等），补充${moneyLabel()}在各队发车时发放。`
        : '手动开始只供测试使用，正式比赛请在「编辑赛段」里设置自动开始时间。手动开始后同样按发车规则自动记录各队出发（以点击时刻为基准）。';
      if (!(await confirm('开始赛段（仅供测试）', continuous ? intro : `${intro}\n\n${msg}`))) return;
      try {
        const d = await api(`/episodes/${ep.id}/start`, { method: 'POST' });
        await Promise.all([race.loadEpisodes(), race.loadTeams(), race.loadLedger()]);
        toast(d.issuedBudgetTo.length ? `赛段已开始，已给 ${d.issuedBudgetTo.length} 支队伍补充经费` : '赛段已开始');
      } catch (err) { toast(err.message); }
    },
    async finishEpisode() {
      const ep = race.currentEpisode(); if (!ep) return;
      if (!(await confirm('结束赛段', `将 ${ep.code} 标记为已结束？不影响任何记录，之后仍可修改。`))) return;
      try { await api(`/episodes/${ep.id}/finish`, { method: 'POST' }); await race.loadEpisodes(); toast('赛段已结束'); } catch (err) { toast(err.message); }
    },
    async resetEpisode() {
      const ep = race.currentEpisode(); if (!ep) return;
      const i = race.episodes.indexOf(ep);
      const later = race.episodes.slice(i).map((x) => x.code).join('、');
      if (!(await confirm('重置赛段（仅供测试）', `只供测试使用。将清空 ${later} 的全部记录数据（时间记录、罚时补时、签到、熔断使用、经费流水），这些赛段回到未开始；环节设置、排班、附件保持不变。确定？`, { danger: true, okText: '重置' }))) return;
      try {
        const d = await api(`/episodes/${ep.id}/reset`, { method: 'POST' });
        await Promise.all([race.loadEpisodes(), race.loadTeams(), race.loadLedger(), race.loadProgress()]);
        toast(`已重置 ${d.episodes.join('、')}`);
      } catch (err) { toast(err.message); }
    },
    async addEpisode() {
      try { await api('/episodes', { method: 'POST', body: {} }); await race.loadEpisodes(); toast('已新增赛段'); } catch (err) { toast(err.message); }
    },
    async deleteEpisode() {
      const ep = race.currentEpisode(); if (!ep) return;
      if (!(await confirm('删除赛段', `删除 ${ep.code}？该赛段的环节、记录、排班、货币日志都会被删除。`, { danger: true, okText: '删除' }))) return;
      try { await api(`/episodes/${ep.id}`, { method: 'DELETE' }); await race.loadEpisodes(); toast('已删除'); } catch (err) { toast(err.message); }
    },

    // ---- episode editing ----
    openEdit() {
      const ep = race.currentEpisode(); if (!ep) return;
      this.setData({
        editing: true,
        form: {
          name: ep.name, budget: String(ep.budget || 0), statusIndex: STATUS_OPTIONS.findIndex((s) => s.value === ep.status), notes: ep.notes,
          startAt: ep.start_at || '', inheritRank: !!ep.inherit_rank, startGapMin: String(ep.start_gap_min || 0),
          continuous: ep.continuous_wait_min !== null, waitMin: String(ep.continuous_wait_min || 0),
          eliminate: ep.eliminate_count > 0, eliminateCount: ep.eliminate_count ? String(ep.eliminate_count) : '',
          first: this.isFirst(ep), elimEditable: auth.isAdmin || ep.status === 'pending',
        },
      });
    },
    closeEdit() { this.setData({ editing: false }); },
    noop() {},
    onField(e) { this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value }); },
    onCheck(e) { this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.checked }); },
    onStartAt(e) { this.setData({ 'form.startAt': e.detail.value || '' }); },
    pickStatus(e) { this.setData({ 'form.statusIndex': Number(e.detail.value) }); },
    async saveEp() {
      const f = this.data.form; const ep = race.currentEpisode();
      const continuous = !f.first && f.continuous;
      if (f.eliminate && !(Number.isInteger(Number(f.eliminateCount)) && Number(f.eliminateCount) >= 1)) { toast('勾选了赛段淘汰，请填写淘汰队数'); return; }
      // a continuous episode starts by itself when its first team is due, so the scheduled start and rank stagger do not apply
      const body = {
        name: f.name, budget: Number(f.budget) || 0, status: STATUS_OPTIONS[f.statusIndex].value, notes: f.notes,
        startAt: !continuous && f.startAt ? f.startAt : null, inheritRank: !continuous && !f.first && f.inheritRank, startGapMin: Math.max(0, Math.round(Number(f.startGapMin) || 0)),
        continuousWaitMin: continuous ? Math.max(0, Math.round(Number(f.waitMin) || 0)) : null, eliminateCount: f.eliminate ? Number(f.eliminateCount) : 0,
      };
      try { await api(`/episodes/${ep.id}`, { method: 'PUT', body }); await race.loadEpisodes(); this.closeEdit(); toast('赛段已保存'); } catch (err) { toast(err.message); }
    },

    // ---- legs (hosts, while the structure is editable) ----
    async addLeg() {
      const ep = race.currentEpisode(); if (!ep) return;
      try {
        await api(`/episodes/${ep.id}/legs`, { method: 'POST', body: { type: 'TI', name: `新环节 ${ep.legs.length + 1}` } });
        await race.loadEpisodes();
        toast('已在中继站前添加环节，点进卡片完善信息');
      } catch (err) { toast(err.message); }
    },
    async deleteLeg(e) {
      const leg = race.legById.get(e.currentTarget.dataset.id); if (!leg) return;
      if (!(await confirm('删除环节', `删除「${legName(leg)}」？相关记录和附件也将丢失。`, { danger: true, okText: '删除' }))) return;
      try { await api(`/legs/${leg.id}`, { method: 'DELETE' }); await race.loadEpisodes(); toast('已删除'); } catch (err) { toast(err.message); }
    },
    /** Long press: move a leg among the movable ones (the Starting Line and the pit stop stay put) */
    moveLeg(e) {
      if (!this.data.editable) return;
      const ep = race.currentEpisode();
      const id = e.currentTarget.dataset.id;
      const ids = ep.legs.map((l) => l.id);
      const i = ids.indexOf(id);
      if (isFixed(ep.legs[i])) return;
      const movable = (k) => k >= 0 && k < ids.length && !isFixed(ep.legs[k]);
      wx.showActionSheet({
        itemList: ['上移', '下移'],
        success: async (r) => {
          const to = r.tapIndex === 0 ? i - 1 : i + 1;
          if (!movable(to)) { toast('起跑线和中继站的位置固定'); return; }
          ids.splice(i, 1); ids.splice(to, 0, id);
          try { await api(`/episodes/${ep.id}/legs/order`, { method: 'PUT', body: { ids } }); await race.loadEpisodes(); } catch (err) { toast(err.message); }
        },
      });
    },
  },
});
