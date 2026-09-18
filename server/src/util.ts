import type { Context } from 'hono';
import { run, now, toCents } from './db.js';
import { currentEvent, type AuthUser } from './auth.js';
import { io } from './realtime.js';

export class HttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409, message: string) {
    super(message);
  }
}
export const bad = (msg: string) => new HttpError(400, msg);
export const notFound = (msg = '不存在') => new HttpError(404, msg);
export const forbidden = (msg = '无权操作') => new HttpError(403, msg);

export function audit(user: AuthUser, action: string, targetType: string, targetId: string | number = '', before?: unknown, after?: unknown) {
  run(
    'INSERT INTO audit_logs(user_id, username, action, target_type, target_id, before, after, created_at, event_id) VALUES (?,?,?,?,?,?,?,?,?)',
    user.id,
    user.username,
    action,
    targetType,
    String(targetId),
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    now(),
    currentEvent()?.id ?? null,
  );
}

export type Scope = 'episodes' | 'teams' | 'assignments' | 'progress' | 'ledger' | 'announcements' | 'admin' | 'pitstop';
export function notify(scope: Scope, episodeId?: number | null) {
  io?.emit('invalidate', { scope, episodeId: episodeId ?? null });
}

export function intParam(c: Context, name: string): number {
  const v = Number(c.req.param(name));
  if (!Number.isInteger(v)) throw bad(`参数 ${name} 无效`);
  return v;
}

export async function body<T = any>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw bad('请求体不是合法 JSON');
  }
}

export const str = (v: unknown, max = 5000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const int = (v: unknown, fallback = 0) => (Number.isInteger(Number(v)) ? Number(v) : fallback);
export const isoOrNull = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw bad(`时间格式无效：${v}`);
  return d.toISOString();
};
export const currencyMode = (): 'yuan' | 'coin' => (currentEvent()?.currency_mode === 'coin' ? 'coin' : 'yuan');
/** 金额格式化（服务端提示用）：经费两位小数，货币整数 */
export function fmtMoneyServer(cents: number): string {
  const v = cents / 100;
  return currencyMode() === 'coin' ? `${Math.round(v)} 币` : `${v.toFixed(2)} 元`;
}
export function money(v: unknown, label = '金额'): number {
  let cents: number;
  try { cents = toCents(v, label); } catch (e) { throw bad((e as Error).message); }
  if (currencyMode() === 'coin' && cents % 100 !== 0) throw bad(`${label}必须是整数（当前为货币模式，以币计）`);
  return cents;
}
