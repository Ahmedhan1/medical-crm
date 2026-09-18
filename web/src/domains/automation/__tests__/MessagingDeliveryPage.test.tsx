import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessagingDeliveryPage } from '../pages/MessagingDeliveryPage.js';
import { mockApi, renderWithProviders } from './testUtils.js';

const FAILED = {
  id: 'm1', patientId: 'p1', channel: 'whatsapp', provider: 'gowa', templateKey: 'appointment_reminder',
  recipientMasked: '+20******3334', status: 'failed', suppressedReason: null, attempts: 1, maxAttempts: 5,
  nextAttemptAt: null, lastError: 'provider_unavailable', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

afterEach(() => vi.restoreAllMocks());

describe('MessagingDeliveryPage', () => {
  it('shows masked recipient, status, and a retry action for failed messages', async () => {
    mockApi(['messaging:read', 'messaging:manage'], [
      { match: (u, m) => (u.split('?')[0] ?? u).endsWith('/messages') && m === 'GET', body: { messages: [FAILED] } },
      { match: (u, m) => u.includes('/messaging-policy') && m === 'GET', body: { policies: [] } },
    ]);
    renderWithProviders(<MessagingDeliveryPage />);
    expect(await screen.findByText('+20******3334')).toBeInTheDocument();
    expect(screen.getByText(/failed/)).toBeInTheDocument();
    // The consent assurance is always shown.
    expect(screen.getByText(/Consent is always re-checked/i)).toBeInTheDocument();
  });

  it('retries a failed message via POST /messages/:id/retry', async () => {
    let retried = false;
    mockApi(['messaging:read', 'messaging:manage'], [
      { match: (u, m) => (u.split('?')[0] ?? u).endsWith('/messages') && m === 'GET', body: { messages: [FAILED] } },
      { match: (u, m) => u.includes('/messaging-policy') && m === 'GET', body: { policies: [] } },
      { match: (u, m) => u.includes('/messages/m1/retry') && m === 'POST', body: { messageId: 'm1', status: 'sent' } },
    ]);
    const origFetch = globalThis.fetch as unknown as typeof fetch;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/retry')) retried = true;
      return origFetch(input, init);
    }));
    renderWithProviders(<MessagingDeliveryPage />);
    const row = (await screen.findByText('+20******3334')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(retried).toBe(true));
  });

  it('hides retry without messaging:manage', async () => {
    mockApi(['messaging:read'], [
      { match: (u, m) => (u.split('?')[0] ?? u).endsWith('/messages') && m === 'GET', body: { messages: [FAILED] } },
      { match: (u, m) => u.includes('/messaging-policy') && m === 'GET', body: { policies: [] } },
    ]);
    renderWithProviders(<MessagingDeliveryPage />);
    await screen.findByText('+20******3334');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});
