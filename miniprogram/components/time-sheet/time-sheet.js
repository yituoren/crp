// The record-time dialog (the website's askTime): defaults to the server's current time, editable to the second.
// ask(title, message) resolves with an ISO time, or null when cancelled.
const clock = require('../../utils/clock');

Component({
  options: { styleIsolation: 'apply-shared' },
  data: { show: false, title: '', message: '', value: '' },
  methods: {
    ask(title, message) {
      this.setData({ show: true, title, message, value: new Date(clock.now()).toISOString() });
      return new Promise((resolve) => { this.resolve = resolve; });
    },
    onChange(e) { this.setData({ value: e.detail.value || '' }); },
    close(result) { this.setData({ show: false }); if (this.resolve) { this.resolve(result); this.resolve = null; } },
    cancel() { this.close(null); },
    ok() { this.close(this.data.value || null); },
    noop() {},
  },
});
