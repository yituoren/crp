// Live board (the website's TeamPositions): where every team is now, its latest record and its balance.
// Shows the running episode; otherwise the next pending one; when all are finished, the last one. While a continuous
// episode overlaps its predecessor both are running: a team shows the later episode once it has departed there.
// Refreshed every 30 seconds and whenever the race data changes.
const { api } = require('../../utils/api');
const race = require('../../utils/race');
const { legName } = require('../../utils/types');
const { fmtTime } = require('../../utils/time');
const { fmtMoney, moneyUnit } = require('../../utils/money');

const STATUS = { eliminated: '已淘汰', withdrawn: '已退赛' };

function liveEpisodes() {
  const eps = race.episodes;
  const running = eps.filter((e) => e.status === 'running');
  if (running.length) return running;
  const one = eps.find((e) => e.status === 'pending') || eps[eps.length - 1];
  return one ? [one] : [];
}

Component({
  options: { styleIsolation: 'apply-shared' },
  data: { loading: true, empty: '', title: '-', statusText: '', unit: '元', teams: [] },
  lifetimes: {
    attached() {
      // race notices come in bursts (several loads per change): refresh once they settle
      this.off = race.subscribe(() => { clearTimeout(this.debounce); this.debounce = setTimeout(() => this.load(), 400); });
      this.timer = setInterval(() => this.load(), 30000);
      this.load();
    },
    detached() { this.off && this.off(); clearInterval(this.timer); clearTimeout(this.debounce); },
  },
  methods: {
    async load() {
      const eps = liveEpisodes();
      const last = eps[eps.length - 1];
      const head = {
        title: eps.map((e) => e.code).join(' / ') || '-', unit: moneyUnit(),
        statusText: !last ? '暂无赛段' : last.status === 'running' ? '进行中' : last.status === 'pending' ? '即将开始' : '已结束',
      };
      if (!eps.length) { this.setData(Object.assign(head, { loading: false, empty: '暂无赛段', teams: [] })); return; }
      try {
        const all = await Promise.all(eps.map((e) => api(`/dashboard/${e.id}`)));
        // later episodes win for teams that have started there; with two episodes each row names its episode
        const tag = (d) => d.teams.map((t) => Object.assign({}, t, { epCode: all.length > 1 ? d.episode.code : '' }));
        let teams = tag(all[0]);
        all.slice(1).forEach((d) => {
          const later = new Map(tag(d).map((t) => [t.id, t]));
          teams = teams.map((t) => { const l = later.get(t.id); return l && l.currentLeg ? l : t; });
        });
        this.setData(Object.assign(head, {
          loading: false, empty: teams.length ? '' : '暂无队伍',
          teams: teams.map((t) => ({
            id: t.id, label: t.label, status: t.status, statusText: STATUS[t.status] || '', epCode: t.epCode, finished: t.finished,
            leg: t.currentLeg ? { type: t.currentLeg.type, name: legName(t.currentLeg) } : null,
            time: fmtTime(t.lastActivity), money: fmtMoney(t.currency),
          })),
        }));
      } catch (e) {
        // keep the last board
        this.setData({ loading: false });
      }
    },
  },
});
