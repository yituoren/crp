export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  form?: FormData;
  retries?: number; // 网络层失败时的重试次数
}

let onUnauthorized: (() => void) | null = null;
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
      const res = await fetch('/api' + path, {
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
      lastErr = e; // 网络错误：重试
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw new ApiError('网络连接失败，请检查网络后重试', 0);
}
