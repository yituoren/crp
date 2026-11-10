// Requests to the backend: Bearer token (no cookies in mini programs), event prefix, retries, server clock
const { BASE } = require('./config');
const clock = require('./clock');

const TOKEN_KEY = 'crp.token';
let token = wx.getStorageSync(TOKEN_KEY) || '';
/** Hash of the current event: every path except the global ones gets the /events/<hash> prefix */
let eventHash = '';
const GLOBAL_PREFIXES = ['/auth', '/events', '/users', '/system', '/files', '/health'];

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function setToken(t) {
  token = t || '';
  if (token) wx.setStorageSync(TOKEN_KEY, token); else wx.removeStorageSync(TOKEN_KEY);
}
const hasToken = () => !!token;
function setEventHash(h) { eventHash = h || ''; }
const getEventHash = () => eventHash;

function apiPath(path) {
  if (GLOBAL_PREFIXES.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'))) return '/api' + path;
  if (!eventHash) throw new ApiError('尚未进入比赛', 0);
  return `/api/events/${eventHash}${path}`;
}

/** Signed out (expired or revoked token): the app sends the user to sign in again */
let onUnauthorized = null;
function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

function send(method, url, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url, method, data,
      header: Object.assign({ 'content-type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}),
      success: resolve,
      fail: reject,
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** api('/path', { method, body }): resolves with the JSON body, rejects with an ApiError carrying the server's message */
async function api(path, opts = {}) {
  const method = opts.method || 'GET';
  const retries = opts.retries !== undefined ? opts.retries : method === 'GET' ? 2 : 3;
  const url = BASE + apiPath(path);
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await send(method, url, opts.body);
    } catch (e) {
      // network error: retry
      if (attempt < retries) { await sleep(500 * (attempt + 1)); continue; }
      throw new ApiError('网络连接失败，请检查网络后重试', 0);
    }
    const date = Date.parse((res.header && (res.header.Date || res.header.date)) || '');
    if (!isNaN(date)) clock.correct(date, false);
    if (res.statusCode >= 200 && res.statusCode < 300) return res.data;
    if (res.statusCode === 401 && token) { setToken(''); if (onUnauthorized) onUnauthorized(); }
    throw new ApiError((res.data && res.data.error) || `请求失败（${res.statusCode}）`, res.statusCode);
  }
  throw new ApiError('网络连接失败，请检查网络后重试', 0);
}

module.exports = { api, ApiError, setToken, hasToken, setEventHash, getEventHash, setUnauthorizedHandler };
