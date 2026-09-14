const TZ = 'Asia/Shanghai';

const timeFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateMinuteFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

const timeMinFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' });
/** 时刻，精确到分钟（默认） */
export function fmtTime(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return timeMinFmt.format(d).replace(/^24:/, '00:');
}
/** 时刻，精确到秒（只用于中继站签到与最终成绩） */
export function fmtTimeSec(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return timeFmt.format(d).replace(/^24:/, '00:');
}
/** 日期时刻，精确到分钟 */
export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return dateMinuteFmt.format(d).replace(/\//g, '-');
}
/** 日期时刻，精确到秒 */
export function fmtDateTimeSec(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return dateTimeFmt.format(d).replace(/\//g, '-');
}
/** 精确到分钟：MM-DD HH:mm */
export function fmtDateMinute(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return dateMinuteFmt.format(d).replace(/\//g, '-');
}
/** ISO → datetime-local 输入框的值（上海时间） */
export function toLocalInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour').replace('24', '00')}:${g('minute')}:${g('second')}`;
}
/** datetime-local 的值（按上海时间理解）→ ISO */
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v.length === 16 ? `${v}:00+08:00` : `${v}+08:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
export function minutesBetween(a?: string | null, b?: string | null): number | null {
  if (!a || !b) return null;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}
export function fmtDuration(a?: string | null, b?: string | null): string {
  const m = minutesBetween(a, b);
  if (m === null) return '-';
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
export function fmtAgo(min?: number | null): string {
  if (min === null || min === undefined) return '';
  if (min < 60) return `${min} 分钟前`;
  if (min < 1440) return `${Math.floor(min / 60)} 小时 ${min % 60} 分前`;
  return `${Math.floor(min / 1440)} 天 ${Math.floor((min % 1440) / 60)} 小时前`;
}
