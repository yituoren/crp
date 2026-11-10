// Server clock: every on-screen time compares against server time, not the phone's own clock.
// The offset is corrected from each response's Date header (whole seconds) and from the realtime hello (exact).
let offset = 0;

function correct(serverMs, exact) {
  const o = serverMs + (exact ? 0 : 500) - Date.now();
  // the Date header is on average half a second behind: only a real drift moves the offset
  if (exact || Math.abs(o - offset) > 2000) offset = o;
}
const now = () => Date.now() + offset;

module.exports = { correct, now };
