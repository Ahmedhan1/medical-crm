import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../../lib/auth/AuthContext.js';
import { TOKEN_STORAGE_KEY } from '../../lib/config.js';
import { PermissionGate, ProtectedRoute } from './guards.js';

function seedSession(permissions: string[]) {
  localStorage.setItem(TOKEN_STORAGE_KEY, 'test-token');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'u1',
          username: 'doc',
          clinicId: 'c1',
          roles: ['DOCTOR'],
          permissions,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ),
  );
}

afterEach(() => vi.restoreAllMocks());

describe('PermissionGate (UX control, backend authoritative)', () => {
  it('shows content when the permission is held, hides otherwise', async () => {
    seedSession(['patient:read']);
    render(
      <AuthProvider>
        <PermissionGate permission="patient:read">
          <div>allowed</div>
        </PermissionGate>
        <PermissionGate permission="billing:admin" fallback={<div>blocked</div>}>
          <div>secret</div>
        </PermissionGate>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText('allowed')).toBeInTheDocument());
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    expect(screen.getByText('blocked')).toBeInTheDocument();
  });
});

describe('ProtectedRoute (fail closed)', () => {
  it('redirects an anonymous user to /login', async () => {
    render(
      <MemoryRouter initialEntries={['/secure']}>
        <AuthProvider>
          <Routes>
            <Route element={<ProtectedRoute />}>
              <Route path="/secure" element={<div>secure area</div>} />
            </Route>
            <Route path="/login" element={<div>login screen</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('login screen')).toBeInTheDocument());
    expect(screen.queryByText('secure area')).not.toBeInTheDocument();
  });
});
