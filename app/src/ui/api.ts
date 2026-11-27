const KEY = 'localtube-token';

/** The per-launch token arrives in the URL hash once; keep it in sessionStorage and remove it from the address bar. */
function token(): string {
  const m = location.hash.match(/token=([A-Za-z0-9]+)/);
  if (m) {
    sessionStorage.setItem(KEY, m[1]);
    history.replaceState(null, '', location.pathname + '#/');
  }
  return sessionStorage.getItem(KEY) ?? '';
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request(method: string, url: string, body?: unknown): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: { 'x-localtube-token': token(), 'x-localtube-client': 'ui', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.status === 401
      ? 'Not signed in to LocalTube. Open it with the link printed when the app starts (or run npm start again).'
      : `Request failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error && res.status !== 401) msg = j.error;
    } catch {
      /* keep default */
    }
    throw new ApiError(res.status, msg);
  }
  return res;
}

async function json<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await request(method, url, body);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  get: <T>(url: string) => json<T>('GET', url),
  post: <T>(url: string, body?: unknown) => json<T>('POST', url, body ?? {}),
  put: <T>(url: string, body: unknown) => json<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => json<T>('PATCH', url, body),
  del: <T>(url: string) => json<T>('DELETE', url),
  blob: async (url: string) => (await request('GET', url)).blob(),
};

export async function download(url: string, filename: string): Promise<void> {
  const blob = await api.blob(url);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
