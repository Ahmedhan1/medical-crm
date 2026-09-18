import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, apiRequest, configureApiClient } from './client.js';
import { ApiError } from './types.js';

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return vi.fn().mockResolvedValue(
    new Response(text, { status, headers: { 'content-type': 'application/json', ...headers } }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  configureApiClient({ tokenProvider: () => null, onUnauthorized: () => {} });
});

describe('api client', () => {
  it('attaches the bearer token from the provider', async () => {
    const fetchMock = mockFetch(200, { ok: true });
    vi.stubGlobal('fetch', fetchMock);
    configureApiClient({ tokenProvider: () => 'tok-123', onUnauthorized: () => {} });
    await api.get('/thing');
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-123');
  });

  it('normalizes an error envelope into ApiError with request_id', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(400, { error: { code: 'validation_error', message: 'bad', request_id: 'req-9' } }),
    );
    await expect(apiRequest('/x', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 400,
      code: 'validation_error',
      requestId: 'req-9',
    });
  });

  it('calls onUnauthorized and throws on 401 (fail closed)', async () => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal('fetch', mockFetch(401, { error: { code: 'unauthorized', message: 'no' } }));
    configureApiClient({ tokenProvider: () => 'x', onUnauthorized });
    await expect(api.get('/secure')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('maps an aborted request to a cancelled ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')),
    );
    const err = await api.get('/slow').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isCancelled).toBe(true);
  });

  it('maps a network failure to a network_error (offline BOX state)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed')));
    const err = await api.get('/thing').catch((e) => e);
    expect((err as ApiError).code).toBe('network_error');
  });

  it('never puts identifiers in a query unless caller opts in (path-first contract)', async () => {
    const fetchMock = mockFetch(200, {});
    vi.stubGlobal('fetch', fetchMock);
    await api.get('/patients/abc'); // id in path, not query
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/patients/abc');
  });
});
