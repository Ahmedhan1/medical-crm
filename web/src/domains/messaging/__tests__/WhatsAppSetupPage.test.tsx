import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WhatsAppSetupPage } from '../pages/WhatsAppSetupPage.js';
import { ConsentPage } from '../pages/ConsentPage.js';
import { mockApi, renderWithProviders } from './testUtils.js';

const disconnected = { provider: 'gowa', configured: true, status: 'disconnected', phoneMasked: null, lastErrorCode: null, pairedAt: null, lastStatusAt: '2026-01-01T00:00:00Z' };

afterEach(() => vi.restoreAllMocks());

describe('WhatsAppSetupPage', () => {
  it('shows a not-configured state when no provider is set up', async () => {
    mockApi(['messaging:read', 'messaging:manage'], [
      { match: (u, m) => u.includes('/whatsapp/status') && m === 'GET', body: { ...disconnected, configured: false } },
    ]);
    renderWithProviders(<WhatsAppSetupPage />);
    expect(await screen.findByText(/WhatsApp is not configured/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start pairing' })).not.toBeInTheDocument();
  });

  it('pairs and displays the transient QR to scan', async () => {
    mockApi(['messaging:read', 'messaging:manage'], [
      { match: (u, m) => u.includes('/whatsapp/status') && m === 'GET', body: disconnected },
      { match: (u, m) => u.includes('/whatsapp/pair') && m === 'POST', body: { qr: 'QRDATA123', expiresInSeconds: 30, status: { ...disconnected, status: 'pairing' } } },
    ]);
    renderWithProviders(<WhatsAppSetupPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Start pairing' }));
    expect(await screen.findByLabelText('whatsapp-qr')).toHaveTextContent('QRDATA123');
    expect(screen.getByText(/Scan to pair/i)).toBeInTheDocument();
  });

  it('hides pairing controls without messaging:manage', async () => {
    mockApi(['messaging:read'], [{ match: (u, m) => u.includes('/whatsapp/status') && m === 'GET', body: disconnected }]);
    renderWithProviders(<WhatsAppSetupPage />);
    await screen.findByText('Status');
    expect(screen.queryByRole('button', { name: 'Start pairing' })).not.toBeInTheDocument();
  });
});

describe('ConsentPage', () => {
  it('looks up and shows per-channel consent', async () => {
    mockApi(['messaging:read'], [
      { match: (u, m) => u.includes('/consent/00000000-0000-0000-0000-000000000001') && m === 'GET', body: { consents: [
        { patientId: 'p', channel: 'whatsapp', status: 'opted_out', updatedAt: '2026-01-01T00:00:00Z' },
      ] } },
    ]);
    renderWithProviders(<ConsentPage />);
    await userEvent.type(screen.getByLabelText('Patient id'), '00000000-0000-0000-0000-000000000001');
    await userEvent.click(screen.getByRole('button', { name: 'Look up' }));
    await waitFor(() => expect(screen.getByText('Opted out')).toBeInTheDocument());
  });
});
