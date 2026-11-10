// "Current leg" card on the follow's page (the website's CurrentLegCard): the actions for the leg the team is on.
//  - header: the leg; a shop button on a shop-open leg in coin mode
//  - a 回转 that sent the team back, or a wait on the spot (twist card, then the settlement), with the shield / reflect choice
//  - transport (Route Info / pit stop): bike / taxi / subway / bus; in coin mode bike and taxi use the matching card,
//    subway and bus cost a fixed fare; in cash mode the actual fare is entered
//  - cutoffs with their countdowns
const { api } = require('../../utils/api');
const race = require('../../utils/race');
const auth = require('../../utils/auth');
const { onTick } = require('../../utils/ticker');
const { legName } = require('../../utils/types');
const { fmtTime } = require('../../utils/time');
const { moneyMode, moneyUnit, fmtMoney, parseMoney } = require('../../utils/money');
const { confirm, toast } = require('../../utils/dialogs');

const TRANSPORT = ['单车', '打车', '地铁', '公交'];
const FIXED_FARE = { 地铁: 3, 公交: 2 };
const countdown = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? `${h}:` : '') + `${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; };

Component({
  options: { styleIsolation: 'apply-shared' },
  // flat: no bottom margin (inside a stack that spaces its own items)
  properties: { teamId: { type: Number, value: 0 }, flat: { type: Boolean, value: false } },
  data: { leg: null, canUse: false, showShop: false, nothing: true, uturn: null, wait: null, transport: null, cutoffs: [], unit: '元' },
  lifetimes: {
    attached() {
      this.off = race.subscribe(() => this.render());
      this.offTick = onTick(() => this.render(true));
      this.choice = ''; this.fare = '';
      this.render();
    },
    detached() { this.off && this.off(); this.offTick && this.offTick(); },
  },
  methods: {
    team() { return race.teamById.get(this.data.teamId); },
    /** The furthest leg with a start and no end (a running side quest counts); none once the team is out of the race */
    currentLeg() {
      const ep = race.currentEpisode();
      if (!ep || race.statusIn(this.data.teamId, ep.id) !== 'alive') return null;
      let cur = null;
      for (const l of ep.legs) { const p = race.progressOf(this.data.teamId, l.id); if (p && p.arrived_at && !p.completed_at) cur = l; }
      return cur;
    },
    cardFor(t) { const tm = this.team(); return moneyMode() === 'coin' && (t === '单车' || t === '打车') ? ((tm && tm.inventory) || []).find((i) => i.name.includes(t)) || null : null; },
    needsCard(t) { return moneyMode() === 'coin' && (t === '单车' || t === '打车'); },

    render(tickOnly) {
      const teamId = this.data.teamId;
      const leg = this.currentLeg();
      if (!leg || (this.legId && this.legId !== leg.id)) { this.choice = ''; this.fare = ''; }
      this.legId = leg ? leg.id : 0;
      const isCoin = moneyMode() === 'coin';
      const canUse = race.canAdjustCurrencyFor(teamId) && !race.episodePending();
      const until = leg ? race.waitingUntil(teamId, leg.id) : null;
      let wait = null;
      if (until) {
        const e = race.effectOn(teamId, leg.id);
        const twist = e && e.wait_until === until ? e : null;
        wait = twist
          ? { text: `被${twist.source_name}的「${twist.item_name}」作用，原地等待到 ${fmtTime(until)}，之前不能记录`, id: twist.id, shield: !!(twist.options && twist.options.shield), reflect: !!(twist.options && twist.options.reflect) }
          : { text: `结算前面环节的补时罚时 ${(race.progressOf(teamId, leg.id) || {}).settle_min || 0} 分钟，原地等待到 ${fmtTime(until)} 再开始任务，之前不能记录` };
      }
      const ut = leg ? race.uturnOn(teamId, leg.id) : null;
      const uturn = ut && !(race.progressOf(teamId, leg.id) || {}).completed_at ? `被${ut.source_name}的「${ut.item_name}」作用：完成绕道的另一个分支（${ut.note}）后，在本环节重新记录完成` : null;
      // route info legs and the way to the pit stop are both travel
      let transport = null;
      if (leg && ['RI', 'PS'].includes(leg.type)) {
        const t = this.choice;
        const fixed = isCoin && t ? (FIXED_FARE[t] === undefined ? null : FIXED_FARE[t]) : null;
        transport = {
          tiles: TRANSPORT.map((x) => ({ name: x, on: x === t, off: !canUse || (this.needsCard(x) && !this.cardFor(x)) })),
          fareOff: !t || this.needsCard(t) || fixed !== null,
          fare: fixed !== null ? String(fixed) : this.needsCard(t) ? '' : this.fare,
          placeholder: t && this.needsCard(t) ? '用卡片' : `消费（${moneyUnit()}）`,
          canConfirm: !!t && canUse,
        };
      }
      // cutoffs on every leg the team is running (a side quest and its main leg)
      const ep = race.currentEpisode();
      const cutoffUsable = !race.episodePending() && !race.episodeFinished() && !race.teamLocked(teamId) && race.canRecord(teamId);
      const cutoffs = [];
      if (leg) {
        ((ep && ep.legs) || []).forEach((l) => {
          const p = race.progressOf(teamId, l.id);
          if (!p || !p.arrived_at || p.completed_at || !l.cutoffs.length) return;
          l.cutoffs.forEach((cf) => {
            const ready = race.cutoffReadyAt(teamId, l, cf);
            const remain = ready === null ? 0 : ready - auth.nowMs;
            const cost = isCoin && cf.cost > 0 ? cf.cost : 0;
            cutoffs.push({ id: cf.id, legId: l.id, legType: l.type, legName: legName(l), name: cf.name, used: race.cutoffUseCount(teamId, cf.id), interval: cf.interval_min, ready: remain <= 0, countdown: countdown(remain), cost, costText: cost ? ` · ${fmtMoney(cost)} ${moneyUnit()}` : '', usable: cutoffUsable });
          });
        });
      }
      const data = {
        leg: leg ? { id: leg.id, type: leg.type, name: legName(leg) } : null, canUse, unit: moneyUnit(),
        showShop: isCoin && !!leg && leg.shop.length > 0, uturn, wait, transport, cutoffs,
        nothing: !transport && !cutoffs.length && !wait && !uturn,
      };
      if (tickOnly) {
        // each second only the countdowns and the wait can change
        const patch = {};
        if (JSON.stringify(data.cutoffs) !== JSON.stringify(this.data.cutoffs)) patch.cutoffs = data.cutoffs;
        if (JSON.stringify(data.wait) !== JSON.stringify(this.data.wait)) { patch.wait = data.wait; patch.nothing = data.nothing; }
        if (Object.keys(patch).length) this.setData(patch);
        return;
      }
      this.setData(data);
    },

    pickTransport(e) {
      const t = e.currentTarget.dataset.name;
      const tile = this.data.transport.tiles.find((x) => x.name === t);
      if (!tile || tile.off) { if (tile && this.needsCard(t)) toast('背包里没有对应卡片'); return; }
      this.choice = t; this.render();
    },
    onFare(e) { this.fare = e.detail.value; },
    async confirmTransport() {
      const t = this.choice; const tm = this.team(); const legId = this.legId;
      if (!t || !tm || !legId) return;
      const ep = race.currentEpisode();
      if (this.needsCard(t)) {
        const card = this.cardFor(t); if (!card) return;
        if (!(await confirm('使用卡片', `「${tm.label}」${t}，使用背包里的「${card.name}」。`))) return;
        try {
          await api('/items/use', { method: 'POST', body: { episodeId: ep.id, teamId: tm.id, itemName: card.name, legId } });
          this.choice = '';
          await Promise.all([race.loadTeams(), race.loadLedger()]);
          toast(`已使用 ${card.name}`);
        } catch (err) { toast(err.message); }
        return;
      }
      const fixed = moneyMode() === 'coin' && FIXED_FARE[t] !== undefined ? FIXED_FARE[t] : null;
      const amount = fixed !== null ? fixed : parseMoney(this.fare);
      if (amount === null) { toast(moneyMode() === 'coin' ? '消费必须是正整数' : '消费必须是正数，最多两位小数'); return; }
      if (!(await confirm('交通消费', `「${tm.label}」${t}，扣除 ${fmtMoney(amount)} ${moneyUnit()}\n当前余额 ${fmtMoney(tm.currency)} → ${fmtMoney(tm.currency - amount)}`))) return;
      try {
        await api('/ledger', { method: 'POST', body: { episodeId: ep.id, teamId: tm.id, delta: -amount, reason: `交通：${t}`, kind: 'other', legId } });
        this.choice = ''; this.fare = '';
        await Promise.all([race.loadTeams(), race.loadLedger()]);
        toast(`已扣除 ${fmtMoney(amount)} ${moneyUnit()}`);
      } catch (err) { toast(err.message); }
    },

    async useCutoff(e) {
      const r = this.data.cutoffs.find((x) => x.id === e.currentTarget.dataset.id); if (!r || !r.usable) return;
      const tm = this.team(); if (!tm) return;
      // a cutoff may be used in debt: the coins short become penalty at once (5 minutes each)
      const bal = tm.currency;
      const lack = Math.max(0, r.cost - bal);
      const money = r.cost ? `，消耗 ${fmtMoney(r.cost)} ${moneyUnit()}\n当前余额 ${fmtMoney(bal)} → ${fmtMoney(lack ? 0 : bal - r.cost)}${lack ? `（欠 ${fmtMoney(lack)} ${moneyUnit()}，换成罚时 ${Math.ceil(lack) * 5} 分钟）` : ''}\n` : '。';
      if (!(await confirm('使用熔断', `「${tm.label}」在「${r.legName}」使用熔断「${r.name}」${money}使用后立即开始下一次倒计时。`))) return;
      try {
        await api(`/cutoffs/${r.id}/use`, { method: 'POST', body: { teamId: tm.id } });
        await Promise.all([race.loadProgress(), race.loadTeams(), race.loadLedger()]);
        toast(`已使用熔断：${r.name}`);
      } catch (err) { toast(err.message); }
    },

    async answer(e) {
      const { id, answer } = e.currentTarget.dataset;
      const text = { shield: '使用护盾挡下这次作用', reflect: '使用反弹，把作用转给使用者', accept: '不使用护盾或反弹，原地等待' }[answer];
      if (!(await confirm('确认', `${text}？`))) return;
      try { await race.answerTwist(id, answer); } catch (err) { toast(err.message); }
    },
    openShop() { if (this.data.canUse && this.legId) this.triggerEvent('shop', { legId: this.legId }); },
  },
});
