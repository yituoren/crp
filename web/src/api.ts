export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  form?: FormData;
  retries?: number; // retries on network failure
}

let onUnauthorized: (() => void) | null = null;
/** Hash of the current event. Every path except the global ones (/auth /events /users /system /files /health) gets the /events/<hash> prefix */
let eventHash = '';
export function setEventHash(h: string) { eventHash = h; }
export function getEventHash() { return eventHash; }
const GLOBAL_PREFIXES = ['/auth', '/events', '/users', '/system', '/files', '/health'];
export function apiPath(path: string): string {
  if (GLOBAL_PREFIXES.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'))) return '/api' + path;
  if (!eventHash) throw new ApiError('尚未进入比赛', 0);
  return `/api/events/${eventHash}${path}`;
}
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function api<T = any>(path: string, opts: Options = {}): Promise<T> {
  const { method = 'GET', body, form } = opts;
  const retries = opts.retries ?? (method === 'GET' ? 2 : 3);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(apiPath(path), {
        method,
        credentials: 'same-origin',
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
      });
      const isJson = res.headers.get('content-type')?.includes('application/json');
      const data = isJson ? await res.json().catch(() => ({})) : await res.text();
      if (!res.ok) {
        if (res.status === 401) onUnauthorized?.();
        throw new ApiError((data && data.error) || `请求失败（${res.status}）`, res.status);
      }
      return data as T;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      lastErr = e; // network error: retry
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw new ApiError('网络连接失败，请检查网络后重试', 0);
}
