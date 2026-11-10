// WeChat content security for what mini program users submit (required for a mini program with user-generated content):
//  - text: every JSON write from the mini program goes through msg_sec_check first; risky text is refused
//  - images: an uploaded image is sent to media_check_async; WeChat pushes the verdict to /api/wx/push and a risky
//    image is deleted
// Only requests the mini program marks with "X-Client: mp" are checked, under the user's openid. When WeChat cannot be
// reached the request goes through (a race must not stall on a third-party outage); the failure is logged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { get, run, now, UPLOAD_DIR } from './db.js';
import { signMediaTicket, readMediaTicket, type Env } from './auth.js';
import { bad, notify } from './util.js';

const APPID = process.env.WX_APPID ?? '';
const SECRET = process.env.WX_SECRET ?? '';
/** The Token entered for message push in the mini program's admin console (Development settings → Message push) */
const PUSH_TOKEN = process.env.WX_PUSH_TOKEN ?? '';
const enabled = () => !!(APPID && SECRET);

/** msg_sec_check scenes: 1 profile, 3 forum (everything else in an event) */
export const SCENE_PROFILE = 1;
const SCENE_FORUM = 3;
/** msg_sec_check takes at most 2500 characters per call */
const CHUNK = 2500;
const RISKY_TEXT = '内容含有违规信息，请修改后再提交';

export const fromMiniProgram = (c: Context) => c.req.header('x-client') === 'mp';
const openidOfUser = (userId: number) => get<{ wx_openid: string | null }>('SELECT wx_openid FROM users WHERE id = ?', userId)?.wx_openid ?? null;

// ---------- access token ----------
// stable_token: fetching it does not invalidate the token other callers hold
let cached: { token: string; until: number } | null = null;
async function accessToken(force = false): Promise<string> {
  if (!force && cached && cached.until > Date.now()) return cached.token;
  const r = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credential', appid: APPID, secret: SECRET, force_refresh: force }),
    signal: AbortSignal.timeout(5000),
  });
  const d = await r.json() as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
  if (!d.access_token) throw new Error(`stable_token ${d.errcode}: ${d.errmsg}`);
  cached = { token: d.access_token, until: Date.now() + Math.max(60, (d.expires_in ?? 7200) - 300) * 1000 };
  return cached.token;
}

/** POST to a WeChat API with the access token; an expired or revoked token is refreshed once */
async function wxPost<T extends { errcode?: number; errmsg?: string }>(api: string, payload: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(attempt > 0);
    const r = await fetch(`https://api.weixin.qq.com${api}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    const d = await r.json() as T;
    if (attempt === 0 && [40001, 40014, 42001].includes(d.errcode ?? 0)) continue;
    return d;
  }
}

// ---------- text ----------
/** Verdicts of recent texts, so repeated short texts (a transport reason, a team name) are not sent again */
const verdicts = new Map<string, boolean>();
function remember(key: string, risky: boolean) {
  verdicts.set(key, risky);
  if (verdicts.size > 2000) verdicts.delete(verdicts.keys().next().value as string);
}

async function chunkRisky(content: string, openid: string, scene: number): Promise<boolean> {
  const key = `${scene}\n${content}`;
  const known = verdicts.get(key);
  if (known !== undefined) return known;
  const d = await wxPost<{ errcode?: number; errmsg?: string; result?: { suggest?: string; label?: number } }>(
    '/wxa/msg_sec_check', { content, version: 2, scene, openid },
  );
  if (d.errcode) throw new Error(`msg_sec_check ${d.errcode}: ${d.errmsg}`);
  const risky = d.result?.suggest === 'risky';
  if (risky) console.warn(`[wxsec] risky text refused (label ${d.result?.label})`);
  remember(key, risky);
  return risky;
}

/** Throws a 400 when WeChat judges any of the texts risky; passes when the check itself fails */
export async function assertTextOk(texts: string[], openid: string | null, scene = SCENE_FORUM) {
  if (!enabled() || !openid) return;
  const list = [...new Set(texts.map((t) => t.trim()).filter(Boolean))];
  if (!list.length) return;
  // pack the texts into as few calls as possible
  const chunks: string[] = [];
  let cur = '';
  for (const t of list) {
    for (let i = 0; i < t.length; i += CHUNK) {
      const piece = t.slice(i, i + CHUNK);
      if (cur && cur.length + 1 + piece.length > CHUNK) { chunks.push(cur); cur = ''; }
      cur = cur ? `${cur}\n${piece}` : piece;
    }
  }
  if (cur) chunks.push(cur);
  let results: boolean[];
  try {
    results = await Promise.all(chunks.map((ch) => chunkRisky(ch, openid, scene)));
  } catch (e) {
    console.warn('[wxsec] text check skipped:', (e as Error).message);
    return;
  }
  if (results.some(Boolean)) throw bad(RISKY_TEXT);
}

/** Field names whose values are not content: credentials, codes, hashes */
const SKIP_KEY = /password|ticket|token|^code$|hash/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T/;
/** Enum values like "coin", "shield", "RI" */
const IDENT = /^[A-Za-z_]{1,24}$/;
/** The user-written strings in a JSON body: anything with a letter, minus credentials, times and enum values */
function textsIn(v: unknown, key = '', out: string[] = []): string[] {
  if (typeof v === 'string') {
    const s = v.trim();
    if (s && !SKIP_KEY.test(key) && !ISO_TIME.test(s) && !IDENT.test(s) && /\p{L}/u.test(s)) out.push(s);
  } else if (Array.isArray(v)) {
    for (const x of v) textsIn(x, key, out);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) textsIn(x, k, out);
  }
  return out;
}

/** Middleware after authRequired: checks the text of every JSON write the mini program sends */
export const contentCheck: MiddlewareHandler<Env> = async (c, next) => {
  if (!enabled() || !fromMiniProgram(c) || !['POST', 'PUT', 'PATCH'].includes(c.req.method)) return next();
  if (!(c.req.header('content-type') ?? '').includes('application/json')) return next();
  const user = c.get('user');
  if (!user) return next();
  let data: unknown;
  try { data = await c.req.json(); } catch { return next(); } // the route reports the bad body (the parse is cached)
  await assertTextOk(textsIn(data), openidOfUser(user.id));
  return next();
};

// ---------- images ----------
/** After an image upload from the mini program: start WeChat's asynchronous check; the verdict arrives at /api/wx/push */
export function checkImageLater(c: Context, attachmentId: number, userId: number) {
  const openid = openidOfUser(userId);
  if (!enabled() || !openid) return;
  const origin = `${c.req.header('x-forwarded-proto') ?? 'http'}://${c.req.header('host')}`;
  void (async () => {
    try {
      const url = `${origin}/api/wx/media/${await signMediaTicket(attachmentId)}`;
      const d = await wxPost<{ errcode?: number; errmsg?: string; trace_id?: string }>(
        '/wxa/media_check_async', { media_url: url, media_type: 2, version: 2, scene: SCENE_FORUM, openid },
      );
      if (d.errcode || !d.trace_id) throw new Error(`media_check_async ${d.errcode}: ${d.errmsg}`);
      run('UPDATE attachments SET wx_trace = ? WHERE id = ?', d.trace_id, attachmentId);
    } catch (e) {
      console.warn(`[wxsec] image check for attachment ${attachmentId} skipped:`, (e as Error).message);
    }
  })();
}

/** Delete an image WeChat judged risky; the audit log keeps a record */
function removeRisky(traceId: string, label: unknown) {
  const att = get('SELECT a.*, l.episode_id, e.event_id FROM attachments a JOIN legs l ON l.id = a.leg_id JOIN episodes e ON e.id = l.episode_id WHERE a.wx_trace = ?', traceId);
  if (!att) return;
  try { fs.unlinkSync(path.join(UPLOAD_DIR, att.path)); } catch { /* already gone */ }
  run('DELETE FROM attachments WHERE id = ?', att.id);
  run(
    'INSERT INTO audit_logs(user_id, username, action, target_type, target_id, before, after, created_at, event_id) VALUES (?,?,?,?,?,?,?,?,?)',
    null, '微信内容安全', 'delete', 'attachment', String(att.id),
    JSON.stringify({ legId: att.leg_id, filename: att.filename, uploadedBy: att.uploaded_by }), JSON.stringify({ reason: 'risky', label }), now(), att.event_id,
  );
  console.warn(`[wxsec] risky image removed: attachment ${att.id} (label ${label})`);
  notify('episodes', att.episode_id);
}

/** Message push requests are signed with the Token: sha1 of the sorted token, timestamp and nonce */
function signedByWeChat(c: Context): boolean {
  const { signature = '', timestamp = '', nonce = '' } = c.req.query();
  const expected = crypto.createHash('sha1').update([PUSH_TOKEN, timestamp, nonce].sort().join('')).digest('hex');
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export const wxRoutes = new Hono<Env>();

/** Public, short-lived link to an uploaded image, for WeChat to download it */
wxRoutes.get('/media/:ticket', async (c) => {
  const id = await readMediaTicket(c.req.param('ticket'));
  const att = id === null ? null : get('SELECT * FROM attachments WHERE id = ?', id);
  if (!att || !String(att.mime).startsWith('image/')) return c.json({ error: '链接无效或已过期' }, 404);
  const full = path.join(UPLOAD_DIR, att.path);
  if (!fs.existsSync(full)) return c.json({ error: '文件已丢失' }, 404);
  return c.body(fs.readFileSync(full), 200, { 'Content-Type': att.mime, 'Cache-Control': 'no-store' });
});

/** Message push: the URL check (GET echoes echostr) and the image verdicts (POST, plaintext JSON) */
wxRoutes.get('/push', (c) => {
  if (!PUSH_TOKEN || !signedByWeChat(c)) return c.text('forbidden', 403);
  return c.text(c.req.query('echostr') ?? '');
});
wxRoutes.post('/push', async (c) => {
  if (!PUSH_TOKEN || !signedByWeChat(c)) return c.text('forbidden', 403);
  let d: { Event?: string; trace_id?: string; result?: { suggest?: string; label?: unknown }; Encrypt?: string } = {};
  try { d = JSON.parse(await c.req.text()); } catch { /* not JSON */ }
  if (d.Encrypt) console.warn('[wxsec] message push is encrypted; set it to plaintext mode (明文模式) with JSON');
  if (d.Event === 'wxa_media_check' && d.trace_id && d.result?.suggest === 'risky') removeRisky(d.trace_id, d.result.label);
  return c.text('success');
});
