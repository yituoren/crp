// Times are shown in Shanghai time whatever the phone's time zone (UTC+8, no daylight saving)
const TZ_MS = 8 * 3600 * 1000;
const pad = (n) => String(n).padStart(2, '0');
function parts(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  const d = new Date(t + TZ_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}
/** HH:MM */
function fmtTime(iso) { const p = parts(iso); return p ? `${pad(p.h)}:${pad(p.mi)}` : '-'; }
/** HH:MM:SS */
function fmtTimeSec(iso) { const p = parts(iso); return p ? `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}` : '-'; }
/** YYYY-MM-DD */
function fmtDate(iso) { const p = parts(iso); return p ? `${p.y}-${pad(p.mo)}-${pad(p.d)}` : '-'; }
/** MM-DD HH:MM */
function fmtDateMinute(iso) { const p = parts(iso); return p ? `${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}` : '-'; }
/** Duration: "x m" under an hour, otherwise "x h x m" */
function fmtDurMs(ms) {
  if (ms < 0) ms = 0;
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} m` : `${m} m`;
}

module.exports = { fmtTime, fmtTimeSec, fmtDate, fmtDateMinute, fmtDurMs };
