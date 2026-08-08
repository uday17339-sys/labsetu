import { getAccessToken } from './session';

/**
 * API base URL.
 *
 * API_INTERNAL_URL is read at RUNTIME and wins. NEXT_PUBLIC_* values are inlined
 * by Next at BUILD time, so a public URL baked into the bundle cannot be
 * changed by an environment variable later — and in the production stack the
 * server should reach the API over the internal Docker network anyway, not by
 * going out through the public hostname and back.
 *
 * Every API call in this app is server-side, so the browser never needs it.
 */
const API_URL =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly detail?: unknown,
    public readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Server-side API client.
 *
 * Runs only on the server, so the access token never reaches the browser.
 * Every page and server action goes through here.
 */
export async function apiFetch<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    cache?: RequestCache;
  } = {},
): Promise<T> {
  const token = options.token ?? (await getAccessToken());

  const res = await fetch(`${API_URL}/v1${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    // Clinical data is never cached: a stale worklist is a safety problem, not
    // a performance win.
    cache: options.cache ?? 'no-store',
  });

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const problem = json as {
      title?: string;
      detail?: string;
      errors?: Record<string, string[]>;
    };
    throw new ApiError(
      res.status,
      problem?.detail || problem?.title || `Request failed (${res.status})`,
      json,
      problem?.errors,
    );
  }

  return json as T;
}

/** Login is the one call made without an existing session. */
export async function apiLogin(body: {
  tenantCode: string;
  email: string;
  password: string;
  totpCode?: string;
}): Promise<unknown> {
  const res = await fetch(`${API_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    const problem = json as { detail?: string; title?: string };
    throw new ApiError(res.status, problem?.detail || problem?.title || 'Sign-in failed', json);
  }

  return json;
}
