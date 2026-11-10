// Date + time to the second (Shanghai time): a date picker and an hour / minute / second wheel. value: ISO or ''.
// clearable: an × empties it (e.g. "not started"). Emits change with { value: ISO | null }.
const { toDateParts, fromDateParts } = require('../../utils/time');
const clock = require('../../utils/clock');

const range = (n) => Array.from({ length: n }, (_, i) => String(i).padStart(2, '0'));
const HMS = [range(24), range(60), range(60)];

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { value: { type: String, value: '' }, clearable: { type: Boolean, value: false } },
  data: { date: '', hms: [0, 0, 0], text: '', empty: true, columns: HMS },
  observers: {
    value(v) {
      const p = toDateParts(v);
      if (!p) { this.setData({ empty: true, date: '', hms: [0, 0, 0], text: '' }); return; }
      this.setData({ empty: false, date: p.date, hms: [p.h, p.mi, p.s], text: `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}:${String(p.s).padStart(2, '0')}` });
    },
  },
  methods: {
    emit(date, hms) { this.triggerEvent('change', { value: fromDateParts(date, hms[0], hms[1], hms[2]) }); },
    /** An empty field starts from now when the user picks either part */
    base() {
      if (!this.data.empty) return { date: this.data.date, hms: this.data.hms };
      const p = toDateParts(new Date(clock.now()).toISOString());
      return { date: p.date, hms: [p.h, p.mi, p.s] };
    },
    onDate(e) { this.emit(e.detail.value, this.base().hms); },
    onTime(e) { this.emit(this.base().date, e.detail.value.map(Number)); },
    clear() { this.triggerEvent('change', { value: null }); },
  },
});
