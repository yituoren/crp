// The signed-in user and the event being viewed (web/src/stores/auth.ts)
const clock = require('./clock');

const auth = {
  get user() { return getApp().globalData.user; },
  get event() { return getApp().globalData.event || { name: '', teamSize: 2, rbGap: 2, myRole: 'crew' }; },
  get isAdmin() { return !!this.user && this.user.role === 'admin'; },
  /** Host rights in the current event; admin is global and includes host */
  get isHost() { return this.isAdmin || this.event.myRole === 'host'; },
  get nowMs() { return clock.now(); },
};

module.exports = auth;
