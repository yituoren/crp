// Money operation form (the website's CurrencyOps), shared by "Mine" and the money page.
//  - teamId pins the team (follow); otherwise a team select lists the teams the user may operate on
//  - legId pins the leg (a station's leg on "Mine"); stations otherwise pick one of their own legs, hosts may pick "other"
//  - coin mode adds "shop purchase": a shop-open leg, then one of its items; the price is deducted
// The default slot holds the ledger shown under the form.
const { api } = require('../../utils/api');
const race = require('../../utils/race');
const auth = require('../../utils/auth');
const { legName, stockText } = require('../../utils/types');
const { fmtMoney, parseMoney, moneyUnit, moneyLabel, moneyMode } = require('../../utils/money');
const { confirm, toast } = require('../../utils/dialogs');

Component({
  options: { styleIsolation: 'apply-shared', multipleSlots: true },
  properties: { teamId: { type: Number, value: 0 }, legId: { type: Number, value: 0 }, flat: { type: Boolean, value: false }, title: { type: String, value: '' } },
  data: {
    heading: '', subtitle: '', state: '', lockText: '', label: '经费', unit: '元',
    teamLabels: [], teamIndex: -1, kindLabels: [], kindIndex: 0, kind: 'other', legLabels: [], legIndex: -1, itemLabels: [], itemIndex: -1, price: '', amount: '', reason: '',
  },
  observers: { 'teamId, legId': function () { this.render(); } },
  lifetimes: {
    attached() { this.off = race.subscribe(() => this.render()); this.render(); },
    detached() { this.off && this.off(); },
  },
  methods: {
    team() { const id = this.data.teamId || (this.teams && this.teams[this.data.teamIndex] || {}).id; return id ? race.teamById.get(id) : null; },
    render() {
      const ep = race.currentEpisode(); if (!ep) return;
      const { teamId, legId, kind } = this.data;
      const isCoin = moneyMode() === 'coin';
      // eliminated / withdrawn teams stay in the list; only admins may operate on them (canAdjustCurrencyFor covers this)
      this.teams = race.teams.filter((t) => race.canAdjustCurrencyFor(t.id));
      const kinds = [{ value: 'other', label: '其他（非熔断）' }];
      if (isCoin && ep.legs.some((l) => l.shop.length)) kinds.push({ value: 'shop', label: '商店购买' });
      this.kinds = kinds;
      let legs = kind === 'shop' ? ep.legs.filter((l) => l.shop_open) : ep.legs;
      const allowed = race.currencyLegIds();
      if (allowed) legs = legs.filter((l) => allowed.includes(l.id));
      this.legs = legs.map((l) => ({ id: l.id, label: `${l.type} · ${legName(l)}` }));
      // "other" is hosts only; purchases need a concrete leg
      if (kind !== 'shop' && auth.isHost) this.legs.push({ id: 0, label: '其他' });
      const pickedLeg = legId || (this.legs[this.data.legIndex] || {}).id;
      this.stock = kind === 'shop' && pickedLeg ? ((race.legById.get(pickedLeg) || {}).shop || []) : [];
      const team = this.team();
      const canOperate = !race.episodePending() && (team ? race.canAdjustCurrencyFor(team.id) : race.canAdjustCurrency());
      let state = 'form';
      let lockText = '';
      if (race.episodePending()) state = 'pending';
      else if (race.episodeFinished()) state = 'finished';
      else if (teamId && race.teamLocked(teamId)) { state = 'locked'; lockText = race.lockReason(teamId); }
      else if (!canOperate) state = 'none';
      const item = this.stock[this.data.itemIndex];
      this.setData({
        heading: teamId ? `本队${moneyLabel()}` : `${moneyLabel()}操作`, label: moneyLabel(), unit: moneyUnit(), state, lockText,
        subtitle: this.data.title || (teamId && team ? `当前余额 ${fmtMoney(team.currency)} ${moneyUnit()}` : ''),
        showTeamPick: !teamId && canOperate, teamLabels: this.teams.map((t) => (t.status === 'alive' ? t.label : `${t.label}（${t.status === 'withdrawn' ? '已退赛' : '已淘汰'}）`)),
        showKind: !teamId, kindLabels: kinds.map((k) => k.label), showLeg: !legId, legLabels: this.legs.map((l) => l.label),
        legPlaceholder: kind === 'shop' ? '开放商店的环节' : '选择环节',
        itemLabels: this.stock.map((i) => `${i.name}（${fmtMoney(i.price)} ${moneyUnit()} · ${stockText(i)}）`),
        price: item ? fmtMoney(item.price) : '', canAdd: kind === 'other', canDeduct: kind !== 'shop' || !!item,
      });
    },
    pickTeam(e) { this.setData({ teamIndex: Number(e.detail.value) }); this.render(); },
    pickKind(e) { const i = Number(e.detail.value); this.setData({ kindIndex: i, kind: this.kinds[i].value, legIndex: -1, itemIndex: -1, amount: '', reason: '' }); this.render(); },
    pickLeg(e) { this.setData({ legIndex: Number(e.detail.value), itemIndex: -1 }); this.render(); },
    pickItem(e) {
      const i = Number(e.detail.value);
      if (this.stock[i] && this.stock[i].remaining === 0) { toast('该商品已售罄'); return; }
      this.setData({ itemIndex: i }); this.render();
    },
    onInput(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
    add() { this.apply(1); },
    deduct() { this.apply(-1); },
    async apply(sign) {
      const t = this.team();
      if (!t) { toast('请选择队伍'); return; }
      const ep = race.currentEpisode();
      const legId = this.data.legId || (this.legs[this.data.legIndex] ? this.legs[this.data.legIndex].id : '');
      if (this.data.kind === 'shop') {
        const it = this.stock[this.data.itemIndex];
        if (!legId) { toast('请选择开放商店的环节'); return; }
        if (!it) { toast('请选择商品'); return; }
        if (!(await confirm('商店购买', `「${t.label}」购买「${it.name}」，扣除 ${fmtMoney(it.price)} ${moneyUnit()}\n当前余额 ${fmtMoney(t.currency)} → ${fmtMoney(t.currency - it.price)}`))) return;
        try {
          await api('/ledger', { method: 'POST', body: { episodeId: ep.id, teamId: t.id, kind: 'shop', itemId: it.item_id, legId } });
          this.setData({ itemIndex: -1 });
          await Promise.all([race.loadTeams(), race.loadLedger(), race.loadEpisodes()]);
          toast(`已购买 ${it.name}`);
        } catch (err) { toast(err.message); }
        return;
      }
      if (legId === '') { toast(race.currencyLegIds() ? '请选择你驻守的环节' : '请选择环节'); return; }
      const amount = parseMoney(this.data.amount);
      if (amount === null) { toast(moneyMode() === 'coin' ? '数量必须是正整数；扣除请用「扣除」按钮' : '金额必须是正数，最多两位小数；扣除请用「扣除」按钮'); return; }
      const delta = amount * sign;
      const reason = this.data.reason.trim() || (sign > 0 ? '任务奖励' : '手动扣除');
      if (!(await confirm(sign > 0 ? `增加${moneyLabel()}` : `扣除${moneyLabel()}`, `「${t.label}」${sign > 0 ? '增加' : '扣除'} ${fmtMoney(amount)} ${moneyUnit()}，原因：${reason}\n当前余额 ${fmtMoney(t.currency)} → ${fmtMoney(t.currency + delta)}`))) return;
      try {
        await api('/ledger', { method: 'POST', body: { episodeId: ep.id, teamId: t.id, delta, reason, kind: 'other', legId: legId === 0 ? null : legId } });
        this.setData({ amount: '', reason: '' });
        await Promise.all([race.loadTeams(), race.loadLedger()]);
        toast(`已${sign > 0 ? '增加' : '扣除'} ${fmtMoney(amount)} ${moneyUnit()}`);
      } catch (err) { toast(err.message); }
    },
  },
});
