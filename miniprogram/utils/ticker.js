// The app's one-second tick (server time from clock.js): running durations, waits and cutoff countdowns re-render on it.
// Runs only while something listens.
const listeners = new Set();
let timer = null;

function onTick(fn) {
  listeners.add(fn);
  if (!timer) timer = setInterval(() => listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } }), 1000);
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) { clearInterval(timer); timer = null; }
  };
}

module.exports = { onTick };
