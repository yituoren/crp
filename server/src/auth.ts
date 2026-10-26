import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DATA_DIR, get, run, now } from './db.js';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: 'admin' | 'host' | 'crew';
}
export const isHostRole = (r: string) => r === 'host' || r === 'admin';
/** Admin: may change data regardless of episode status */
export const isAdminRole = (r: string) => r === 'admin';

export interface EventRow {
  id: number;
  hash: string;
  name: string;
  invite_code: string;
  hosts: string;
  team_size: number;
  currency_mode: 'yuan' | 'coin';
  rb_gap: number;
  owner_id: number | null;
  created_at: string;
}
export type Env = { Variables: { user: AuthUser; event: EventRow } };

// ---------- Event context ----------
/** Event of the current request, kept in AsyncLocalStorage so money formatting, audit logging etc. need no parameter threading */
const eventStore = new AsyncLocalStorage<EventRow>();
export const currentEvent = () => eventStore.getStore() ?? null;
/** Run a function inside an event context (for the scheduler and other request-less code) */
export const withEvent = <T>(ev: EventRow, fn: () => T): T => eventStore.run(ev, fn);
/** A user's role within an event: admins are always admin; the creator is host; members flagged host are host; everyone else is crew */
export function roleIn(user: { id: number; username: string; role: string }, ev: EventRow): 'admin' | 'host' | 'crew' {
  if (user.role === 'admin') return 'admin';
  if (ev.owner_id && ev.owner_id === user.id) return 'host';
  const m = get<{ role: string }>('SELECT role FROM event_members WHERE event_id = ? AND user_id = ?', ev.id, user.id);
  return m?.role === 'host' ? 'host' : 'crew';
}
/** Membership check: only admins and the creator are in by default, everyone else joins with the invite code */
export function isMember(user: { id: number; username: string; role: string }, ev: EventRow) {
  if (user.role === 'admin') return true;
  if (ev.owner_id && ev.owner_id === user.id) return true;
  return !!get('SELECT 1 FROM event_members WHERE event_id = ? AND user_id = ?', ev.id, user.id);
}
/** Join with the invite code: crew by default */
export function joinEvent(userId: number, eventId: number, role: 'host' | 'crew' = 'crew') {
  run('INSERT OR IGNORE INTO event_members(event_id, user_id, joined_at, role) VALUES (?,?,?,?)', eventId, userId, now(), role);
}
export const loadEvent = (hash: string) => get<EventRow>('SELECT * FROM events WHERE hash = ?', hash);
/** Every route under /events/:hash: resolve the event, check membership, swap the user's role for the per-event role */
export const eventContext: MiddlewareHandler<Env> = async (c, next) => {
  const ev = loadEvent(c.req.param('hash') ?? '');
  if (!ev) return c.json({ error: '比赛不存在' }, 404);
  const base = c.get('user');
  if (!isMember(base, ev)) return c.json({ error: '你还没有加入这个比赛，请先凭邀请码申请并等待主办审核' }, 403);
  c.set('event', ev);
  c.set('user', { ...base, role: roleIn(base, ev) });
  await eventStore.run(ev, next);
};

const COOKIE = 'crp_token';
const TTL_SEC = 60 * 60 * 24 * 30; // 30 days

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

/** Whether the user hosts or created any event (controls the account-management entry) */
export function hostAnywhere(userId: number): boolean {
  if (get('SELECT 1 FROM events WHERE owner_id = ?', userId)) return true;
  return !!get("SELECT 1 FROM event_members WHERE user_id = ? AND role = 'host'", userId);
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

/** Parse the list of legs a station is assigned to (compatible with old rows that only have leg_id) */
export function parseLegIds(row: { leg_id: number | null; leg_ids?: string | null }): number[] {
  if (row.leg_ids) { try { const arr = JSON.parse(row.leg_ids); if (Array.isArray(arr)) return arr.map(Number).filter(Boolean); } catch { /* ignore */ } }
  return row.leg_id ? [row.leg_id] : [];
}
/** The current user's assignment in an episode */
export function getAssignment(episodeId: number, userId: number) {
  const row = get<{ role: 'follow' | 'station' | 'live'; team_id: number | null; leg_id: number | null; leg_ids: string | null }>(
    'SELECT role, team_id, leg_id, leg_ids FROM assignments WHERE episode_id = ? AND user_id = ?',
    episodeId,
    userId,
  );
  return row ? { ...row, legIds: parseLegIds(row) } : undefined;
}

/** Time records are made only by follows (for their own team) and hosts; stations do not record time, they handle penalties, money and attachments */
export function canRecordProgress(user: AuthUser, episodeId: number, teamId: number, _legId: number) {
  if (isHostRole(user.role)) return true;
  const a = getAssignment(episodeId, user.id);
  if (!a) return false;
  return a.role === 'follow' && a.team_id === teamId;
}

/** Money: hosts any team; follows only the team they follow in this episode (assignments are per episode); stations have no money rights */
export function canAdjustCurrency(user: AuthUser, episodeId: number, teamId?: number, legId?: number | null) {
  if (isHostRole(user.role)) return true;
  const a = getAssignment(episodeId, user.id);
  if (!a) return false;
  if (a.role === 'follow') return teamId !== undefined && a.team_id === teamId;
  // Station: any team in this episode, but only on the legs it is assigned to (cannot pick "other")
  if (a.role === 'station') return legId !== undefined && legId !== null && a.legIds.includes(legId);
  return false;
}
/** Penalties / time credits: hosts any team; stations any team in this episode; follows only their own team */
export function canManagePenalty(user: AuthUser, episodeId: number, teamId?: number) {
  if (isHostRole(user.role)) return true;
  const a = getAssignment(episodeId, user.id);
  if (!a) return false;
  if (a.role === 'station') return true;
  return a.role === 'follow' && teamId !== undefined && a.team_id === teamId;
}

export function canUploadToLeg(user: AuthUser, episodeId: number, legId: number) {
  if (isHostRole(user.role)) return true;
  const a = getAssignment(episodeId, user.id);
  return a?.role === 'station' && a.legIds.includes(legId);
}

/** Station crew at the pit stop: may eliminate in the current episode */
export function isPitstopStation(user: AuthUser, episodeId: number) {
  if (isHostRole(user.role)) return true;
  const a = getAssignment(episodeId, user.id);
  if (!a || a.role !== 'station' || !a.legIds.length) return false;
  return a.legIds.some((id) => !!get("SELECT 1 FROM legs WHERE id = ? AND episode_id = ? AND type = 'PS'", id, episodeId));
}
