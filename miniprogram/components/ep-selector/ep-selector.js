// Episode tabs (the website's EpSelector): running episodes get a green dot, finished ones turn grey
const race = require('../../utils/race');

Component({
  options: { styleIsolation: 'apply-shared' },
  data: { episodes: [], current: 0 },
  lifetimes: {
    attached() { this.off = race.subscribe(() => this.render()); this.render(); },
    detached() { this.off && this.off(); },
  },
  methods: {
    render() {
      const cur = race.currentEpisode();
      this.setData({ episodes: race.episodes.map((e) => ({ id: e.id, code: e.code, status: e.status })), current: cur ? cur.id : 0 });
    },
    select(e) { race.selectEpisode(e.currentTarget.dataset.id); },
  },
});
