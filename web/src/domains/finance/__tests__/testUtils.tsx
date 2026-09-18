import { vi } from 'vitest';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { I18nProvider } from '../../../lib/i18n/I18nContext.js';
import { AuthProvider } from '../../../lib/auth/AuthContext.js';
import { ToastProvider } from '../../../components/ui/index.js';
import { TOKEN_STORAGE_KEY } from '../../../lib/config.js';
import { registerFinanceMessages } from '../i18n.js';

registerFinanceMessages();

export interface Handler {
  match: (url: string, method: string) => boolean;
  status?: number;
  body: unknown;
}

export function mockApi(permissions: string[], handlers: Handler[] = []): void {
  const me = { id: 'u1', username: 'tester', clinicId: 'c1', roles: ['ADMIN'], permissions };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/auth/me')) {
        return Promise.resolve(new Response(JSON.stringify(me), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      for (const h of handlers) {
        if (h.match(url, method)) {
          return Promise.resolve(new Response(JSON.stringify(h.body), { status: h.status ?? 200, headers: { 'content-type': 'application/json' } }));
        }
      }
      return Promise.resolve(new Response(JSON.stringify({ error: { code: 'not_found', message: 'nf' } }), { status: 404, headers: { 'content-type': 'application/json' } }));
    }),
  );
}

export function renderWithProviders(ui: ReactElement, opts: { route?: string } = {}): RenderResult {
  try { localStorage.setItem(TOKEN_STORAGE_KEY, 'test-token'); } catch { /* ignore */ }
  return render(
    <I18nProvider>
      <AuthProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[opts.route ?? '/']}>{ui}</MemoryRouter>
        </ToastProvider>
      </AuthProvider>
    </I18nProvider>,
  );
}
