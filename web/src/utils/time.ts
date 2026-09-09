const TZ = 'Asia/Shanghai';

const timeFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: TZ, hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function fmtTime(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return timeFmt.format(d).replace(/^24:/, '00:');
}
export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return dateTimeFmt.format(d).replace(/\//g, '-');
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
