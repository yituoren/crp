// Shop (the website's ShopModal): pick items stocked on this leg with a quantity; buying charges the price per unit,
// one ledger row each. Quantities stop at what is left, sold-out items cannot be picked.
const { api } = require('../../utils/api');
const race = require('../../utils/race');
const { stockText } = require('../../utils/types');
const { fmtMoney, moneyUnit } = require('../../utils/money');
const { confirm, toast } = require('../../utils/dialogs');

Component({
  options: { styleIsolation: 'apply-shared' },
  data: { show: false, head: '', items: [], totalText: '点选商品', canBuy: false, busy: false },
  methods: {
    open({ teamId, legId }) {
      this.teamId = teamId; this.legId = legId; this.qty = {};
      this.show();
    },
    show() {
      const team = race.teamById.get(this.teamId);
      const leg = race.legById.get(this.legId);
      // keyed by the event item id, which is what a purchase sends
      this.stock = ((leg && leg.shop) || []).map((s) => Object.assign({}, s, { id: s.item_id }));
      const picked = this.stock.filter((i) => (this.qty[i.id] || 0) > 0);
      const total = picked.reduce((s, i) => s + i.price * this.qty[i.id], 0);
      this.setData({
        show: true, head: `${team ? team.label : ''} · 余额 ${fmtMoney(team ? team.currency : 0)} ${moneyUnit()}`,
        items: this.stock.map((i) => ({ id: i.id, name: i.name, info: `${fmtMoney(i.price)} ${moneyUnit()} · ${stockText(i)}`, qty: this.qty[i.id] || 0, soldOut: i.remaining === 0, atMax: (this.qty[i.id] || 0) >= (i.remaining === null ? Infinity : i.remaining) })),
        totalText: picked.length ? `共 ${fmtMoney(total)} ${moneyUnit()}` : '点选商品', canBuy: picked.length > 0,
      });
    },
    maxOf(id) { const i = this.stock.find((x) => x.id === id); return i && i.remaining !== null ? i.remaining : Infinity; },
    toggle(e) { const id = e.currentTarget.dataset.id; if (this.qty[id]) delete this.qty[id]; else if (this.maxOf(id) > 0) this.qty[id] = 1; this.show(); },
    step(e) {
      const { id, d } = e.currentTarget.dataset;
      const n = Math.min((this.qty[id] || 0) + Number(d), this.maxOf(id));
      if (n <= 0) delete this.qty[id]; else this.qty[id] = n;
      this.show();
    },
    close() { this.setData({ show: false }); },
    noop() {},
    async buy() {
      const team = race.teamById.get(this.teamId);
      const picked = this.stock.filter((i) => (this.qty[i.id] || 0) > 0);
      if (!team || !picked.length) return;
      const total = picked.reduce((s, i) => s + i.price * this.qty[i.id], 0);
      const lines = picked.map((i) => `${i.name} × ${this.qty[i.id]}`).join('、');
      if (!(await confirm('商店购买', `「${team.label}」购买 ${lines}，共扣除 ${fmtMoney(total)} ${moneyUnit()}（每件一条记录）\n当前余额 ${fmtMoney(team.currency)} → ${fmtMoney(team.currency - total)}`))) return;
      this.setData({ busy: true });
      const ep = race.currentEpisode();
      let done = 0;
      try {
        for (const it of picked) for (let k = 0; k < this.qty[it.id]; k++) { await api('/ledger', { method: 'POST', body: { episodeId: ep.id, teamId: this.teamId, kind: 'shop', itemId: it.id, legId: this.legId } }); done++; }
        toast(`已购买 ${done} 件`);
        this.close();
      } catch (err) {
        toast(done ? `已购买 ${done} 件，之后的失败：${err.message}` : err.message);
      } finally {
        this.setData({ busy: false });
        await Promise.all([race.loadTeams(), race.loadLedger(), race.loadEpisodes()]);
      }
    },
  },
});
