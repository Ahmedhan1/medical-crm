import { API_BASE } from '../config.js';
import { ApiError, type ApiErrorEnvelope } from './types.js';

/**
 * MEDCORE API client — the single boundary between the frontend and the backend.
 *
 * Responsibilities: attach the bearer token, normalize every failure into an
 * `ApiError` (no raw Response leaks to product code), surface `request_id` for
 * support correlation, support cancellation via `AbortSignal`, and route 401
 * (session invalid) to a central handler so the app fails closed to the login
 * screen. Authorization is NEVER decided here — the backend remains authoritative;
 * the client only reflects what the backend allows.
 *
 * PHI safety: callers must pass identifiers in the path or JSON body, never in a
 * query string that could carry a name/phone (the backend also strips query
 * strings from logs, but the client keeps the contract on the sending side).
 */
export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON body; serialized automatically. */
  body?: unknown;
  /** Query params. Use only for non-PHI filters (ids, page, status). */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Cancellation. */
  signal?: AbortSignal;
  /** Per-call header overrides. */
  headers?: Record<string, string>;
}

type TokenProvider = () => string | null;
type UnauthorizedHandler = () => void;

let getToken: TokenProvider = () => null;
let onUnauthorized: UnauthorizedHandler = () => {};

/** Wire the client to the auth layer (called once at startup). */
export function configureApiClient(opts: {
  tokenProvider: TokenProvider;
  onUnauthorized: UnauthorizedHandler;
}): void {
  getToken = opts.tokenProvider;
  onUnauthorized = opts.onUnauthorized;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) params.append(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...opts.headers,
  };

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
      credentials: 'same-origin',
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError({ status: 0, code: 'cancelled', message: 'Request cancelled' });
    }
    // Network / offline — a first-class state for a local-first BOX.
    throw new ApiError({
      status: 0,
      code: 'network_error',
      message: 'Cannot reach the MEDCORE server',
    });
  }

  if (res.status === 204) return undefined as T;

  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (res.ok) return payload as T;

  const envelope = (payload ?? {}) as Partial<ApiErrorEnvelope>;
  const apiErr = new ApiError({
    status: res.status,
    code: envelope.error?.code ?? `http_${res.status}`,
    message: envelope.error?.message ?? res.statusText ?? 'Request failed',
    details: envelope.error?.details,
    requestId: envelope.error?.request_id ?? res.headers.get('x-request-id') ?? undefined,
  });

  // 401 = session invalid/expired → fail closed to login. 403 is surfaced to the
  // caller (the UI shows a Forbidden state) but never silently swallowed.
  if (apiErr.status === 401) onUnauthorized();
  throw apiErr;
}

/** Convenience verbs. */
export const api = {
  get: <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...opts, method: 'GET' }),
  post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method'>) =>
    apiRequest<T>(path, { ...opts, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method'>) =>
    apiRequest<T>(path, { ...opts, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method'>) =>
    apiRequest<T>(path, { ...opts, method: 'PATCH', body }),
  del: <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...opts, method: 'DELETE' }),
};
