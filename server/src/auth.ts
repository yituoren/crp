import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, get } from './db.js';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: 'admin' | 'host' | 'crew';
}
export const isHostRole = (r: string) => r === 'host' || r === 'admin';

export type Env = { Variables: { user: AuthUser } };

const COOKIE = 'crp_token';
const TTL_SEC = 60 * 60 * 24 * 30; // 30 天

function loadSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const p = path.join(DATA_DIR, 'jwt-secret.txt');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  const s = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  fs.writeFileSync(p, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

export async function issueToken(c: Context, user: AuthUser) {
  const token = await sign({ sub: user.id, exp: Math.floor(Date.now() / 1000) + TTL_SEC }, SECRET);
  setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: TTL_SEC });
}
export function clearToken(c: Context) {
  deleteCookie(c, COOKIE, { path: '/' });
}

export function loadUser(id: number): AuthUser | null {
  const row = get('SELECT id, username, display_name, role, disabled FROM users WHERE id = ?', id);
  if (!row || row.disabled) return null;
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}

export const authRequired: MiddlewareHandler<Env> = async (c, next) => {
  const token = getCookie(c, COOKIE);
  if (!token) return c.json({ error: '未登录' }, 401);
  try {
    const payload = await verify(token, SECRET, "HS256");
    const user = loadUser(Number(payload.sub));
    if (!user) return c.json({ error: '账号不存在或已停用' }, 401);
    c.set('user', user);
    await next();
  } catch {
    return c.json({ error: '登录已过期，请重新登录' }, 401);
  }
};

export const hostOnly: MiddlewareHandler<Env> = async (c, next) => {
  if (!isHostRole(c.get('user').role)) return c.json({ error: '仅主办可操作' }, 403);
  await next();
};
export const adminOnly: MiddlewareHandler<Env> = async (c, next) => {
  if (c.get('user').role !== 'admin') return c.json({ error: '仅管理员可操作' }, 403);
  await next();
};

/** 当前用户在某赛段的排班 */
export function getAssignment(episodeId: number, userId: number) {
  return get<{ role: 'follow' | 'station'; team_id: number | null; leg_id: number | null }>(
    'SELECT role, team_id, leg_id FROM assignments WHERE episode_id = ? AND user_id = ?',
    episodeId,
    userId,
  );
}

export function canRecordProgress(user: AuthUser, episodeId: number, teamId: number, legId: number) {
  if (isHostRole(user.role)) return true;
  const a = getAssignment(episodeId, user.id);
  if (!a) return false;
  if (a.role === 'follow') return a.team_id === teamId;
  if (a.role === 'station') return a.leg_id === legId;
  return false;
}

/** 货币：主办任意；站点本赛段任意队伍；跟队仅本赛段所跟的队伍（排班按赛段生效，换队伍自动跟着变） */
export function canAdjustCurrency(user: AuthUser, episodeId: number, teamId?: number) {
  if (isHostRole(user.role)) return true;
  const a = getAssignment(episodeId, user.id);
  if (!a) return false;
  if (a.role === 'station') return true;
  if (a.role === 'follow') return teamId !== undefined && a.team_id === teamId;
  return false;
}

export function canUploadToLeg(user: AuthUser, episodeId: number, legId: number) {
  if (isHostRole(user.role)) return true;
  const a = getAssignment(episodeId, user.id);
  return a?.role === 'station' && a.leg_id === legId;
}
