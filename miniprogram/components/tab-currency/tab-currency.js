// Money (the website's CurrencyView): each team's balance (and bag in coin mode, tap to use items), item log,
// the money form (follows pinned to their team), and the ledger; both logs filter by team.
const race = require('../../utils/race');
const auth = require('../../utils/auth');
const { fmtMoney, moneyUnit, moneyLabel, moneyMode } = require('../../utils/money');

Component({
  options: { styleIsolation: 'apply-shared' },
  data: { teams: [], isCoin: false, label: '经费', unit: '元', fixedTeam: 0, filterLabels: ['全部队伍'], filterIndex: 0, filterTeam: 0, bagTeam: 0, bagTitle: '' },
  lifetimes: {
    attached() { this.off = race.subscribe(() => this.render()); this.render(); },
    detached() { this.off && this.off(); },
  },
  methods: {
    render() {
      const my = race.myAssignment();
      this.filterIds = [0].concat(race.teams.map((t) => t.id));
      this.setData({
        isCoin: moneyMode() === 'coin', label: moneyLabel(), unit: moneyUnit(),
        // follows may only operate on their own team: pin it in the form
        fixedTeam: !auth.isHost && my && my.role === 'follow' ? my.team_id || 0 : 0,
        filterLabels: ['全部队伍'].concat(race.teams.map((t) => t.label)),
        teams: race.teams.map((t) => ({
          id: t.id, label: t.label, status: t.status, statusText: t.status === 'eliminated' ? '已淘汰' : t.status === 'withdrawn' ? '已退赛' : '',
          balance: fmtMoney(t.currency), items: t.inventory.map((i) => ({ name: i.name, count: i.count })),
        })),
      });
    },
    pickFilter(e) { const i = Number(e.detail.value); this.setData({ filterIndex: i, filterTeam: this.filterIds[i] }); },
    /** Coin mode: a team's bag opens in a sheet to use its items */
    openBag(e) {
      if (!this.data.isCoin) return;
      const t = race.teamById.get(e.currentTarget.dataset.id);
      this.setData({ bagTeam: t.id, bagTitle: `${t.label} 的背包` });
    },
    closeBag() { this.setData({ bagTeam: 0 }); },
    noop() {},
  },
});
