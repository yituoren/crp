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

/** Penalty minutes with a sign, in the duration format: "+5 m", "-1 h 10 m" ("0 m" for none) */
function fmtPenMin(min) { return `${min > 0 ? '+' : min < 0 ? '-' : ''}${fmtDurMs(Math.abs(min) * 60000)}`; }
/** YYYY-MM-DD HH:MM */
function fmtDateTime(iso) { const p = parts(iso); return p ? `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}` : '-'; }

/** Shanghai date ('YYYY-MM-DD') and h / m / s of an ISO time, for the time pickers */
function toDateParts(iso) { const p = parts(iso); return p ? { date: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, h: p.h, mi: p.mi, s: p.s } : null; }
/** Shanghai date + h / m / s back to an ISO time */
function fromDateParts(date, h, mi, s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], h, mi, s) - TZ_MS).toISOString();
}

module.exports = { fmtTime, fmtTimeSec, fmtDate, fmtDateMinute, fmtDateTime, fmtDurMs, fmtPenMin, toDateParts, fromDateParts };
