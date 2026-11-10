// Realtime updates from the server's Socket.IO (Engine.IO v4) over a plain WebSocket: the server only pushes
// "this data changed" (invalidate) and its clock (hello), so a minimal client is enough. Reconnects by itself.
const { WS } = require('./config');
const clock = require('./clock');

let task = null;
let wanted = false;
let retry = 0;
let reconnectTimer = null;
const handlers = {};
let onlineCb = null;

/** on('invalidate', fn), on('hello', fn), ... */
function on(event, fn) { (handlers[event] = handlers[event] || []).push(fn); }
function off(event, fn) { handlers[event] = (handlers[event] || []).filter((f) => f !== fn); }
function emit(event, data) { (handlers[event] || []).forEach((f) => { try { f(data); } catch (e) { console.error(e); } }); }
function onOnline(fn) { onlineCb = fn; }

function connect() {
  wanted = true;
  if (task) return;
  task = wx.connectSocket({ url: `${WS}/socket.io/?EIO=4&transport=websocket`, fail: () => schedule() });
  task.onMessage((m) => handle(String(m.data)));
  task.onClose(() => { task = null; if (onlineCb) onlineCb(false); schedule(); });
  task.onError(() => {});
}

function handle(msg) {
  const type = msg[0];
  if (type === '0') { task && task.send({ data: '40' }); return; } // Engine.IO open → Socket.IO connect
  if (type === '2') { task && task.send({ data: '3' }); return; } // ping → pong
  if (msg.startsWith('40')) { retry = 0; if (onlineCb) onlineCb(true); emit('connect'); return; }
  if (msg.startsWith('42')) {
    try {
      const [event, data] = JSON.parse(msg.slice(2));
      if (event === 'hello' && data && data.serverTime) clock.correct(Date.parse(data.serverTime), true);
      emit(event, data);
    } catch (e) { /* ignore malformed */ }
  }
}

function schedule() {
  if (!wanted || reconnectTimer) return;
  const delay = Math.min(5000, 500 * 2 ** retry++);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; if (wanted) connect(); }, delay);
}

function disconnect() {
  wanted = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (task) { const t = task; task = null; t.close({}); }
}

module.exports = { connect, disconnect, on, off, onOnline };
