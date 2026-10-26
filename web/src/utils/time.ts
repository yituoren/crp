const TZ = 'Asia/Shanghai';

const timeFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateMinuteFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

const dateOnlyFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeMinFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' });
/** Time of day to the minute (default) */
export function fmtTime(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return timeMinFmt.format(d).replace(/^24:/, '00:');
}
/** Time of day to the second (pit-stop check-ins and final times only) */
export function fmtTimeSec(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return timeFmt.format(d).replace(/^24:/, '00:');
}
/** Date and time to the minute */
/** Date only: 2026-10-24 */
export function fmtDate(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return dateOnlyFmt.format(d).replace(/\//g, '-');
}
export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return dateMinuteFmt.format(d).replace(/\//g, '-');
}
/** Date and time to the second */
export function fmtDateTimeSec(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return dateTimeFmt.format(d).replace(/\//g, '-');
}
/** To the minute: MM-DD HH:mm */
export function fmtDateMinute(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return dateMinuteFmt.format(d).replace(/\//g, '-');
}
/** ISO → value for a datetime-local input (Shanghai time) */
export function toLocalInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour').replace('24', '00')}:${g('minute')}:${g('second')}`;
}
/** datetime-local value (read as Shanghai time) → ISO */
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v.length === 16 ? `${v}:00+08:00` : `${v}+08:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
export function minutesBetween(a?: string | null, b?: string | null): number | null {
  if (!a || !b) return null;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}
/** Duration: "x m" under an hour, otherwise "x h x m" */
export function fmtDurMs(ms: number): string {
  if (ms < 0) ms = 0;
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} m` : `${m} m`;
}
export function fmtDuration(a?: string | null, b?: string | null): string {
  if (!a || !b) return '-';
  return fmtDurMs(new Date(b).getTime() - new Date(a).getTime());
}
export function fmtAgo(min?: number | null): string {
  if (min === null || min === undefined) return '';
  if (min < 60) return `${min} 分钟前`;
  if (min < 1440) return `${Math.floor(min / 60)} 小时 ${min % 60} 分前`;
  return `${Math.floor(min / 1440)} 天 ${Math.floor((min % 1440) / 60)} 小时前`;
}
