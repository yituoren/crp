// Sign-in: a stored token, else WeChat (wx.login). A WeChat user not bound yet gets a ticket and binds it on the login page.
const { api, setToken, hasToken } = require('./api');

function wxLogin() {
  return new Promise((resolve, reject) => wx.login({ success: (r) => (r.code ? resolve(r.code) : reject(new Error('微信登录失败'))), fail: reject }));
}

/** The signed-in user, kept for all pages */
function setMe(d) {
  const app = getApp();
  app.globalData.user = d.user;
  app.globalData.hostAnywhere = !!d.hostAnywhere;
  return d.user;
}
async function loadMe() { return setMe(await api('/auth/me')); }

/** Resolves { user } when signed in, or { ticket } when this WeChat user still has to bind an account */
async function signIn() {
  if (hasToken()) {
    try { return { user: await loadMe() }; } catch (e) { if (e.status !== 401) throw e; }
  }
  const code = await wxLogin();
  const d = await api('/auth/wx-login', { method: 'POST', body: { code } });
  if (d.ticket) return { ticket: d.ticket };
  setToken(d.token);
  return { user: await loadMe() };
}

/** Bind the ticket's WeChat user to an account (existing ID + password, or register: true for a new one) */
async function bind(ticket, form) {
  const d = await api('/auth/wx-bind', { method: 'POST', body: Object.assign({ ticket }, form) });
  setToken(d.token);
  return loadMe();
}

function signOut() {
  setToken('');
  getApp().globalData.user = null;
}

module.exports = { signIn, bind, loadMe, signOut };
