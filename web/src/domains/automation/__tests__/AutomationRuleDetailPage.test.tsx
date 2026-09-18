import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AutomationRuleDetailPage } from '../pages/AutomationRuleDetailPage.js';
import { mockApi, renderWithProviders } from './testUtils.js';

const RULE = {
  id: 'r1', name: 'Reminder', description: null, triggerType: 'event', eventType: 'PATIENT_CHECKED_IN',
  scheduleCron: null, conditions: [], actions: [{ type: 'send_message', params: { channel: 'whatsapp' } }],
  isEnabled: true, priority: 100, version: 2, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const SIM = {
  ruleId: 'r1', ruleName: 'Reminder', isEnabled: true, triggerMatched: true, triggerReason: 'match',
  conditionsPassed: true, conditions: [],
  actions: [{ index: 0, type: 'send_message', wouldExecute: true, reason: 'would_send' }],
};

afterEach(() => vi.restoreAllMocks());

describe('AutomationRuleDetailPage — dry-run', () => {
  it('runs a simulation and shows the verdict with a no-side-effects assurance', async () => {
    let simulateCalled = false;
    mockApi(['automation:read', 'automation:manage'], [
      { match: (u, m) => /\/automations\/r1$/.test((u.split('?')[0] ?? u)) && m === 'GET', body: RULE },
      { match: (u, m) => u.includes('/automations/r1/runs') && m === 'GET', body: { runs: [] } },
      { match: (u, m) => u.includes('/scheduled-actions') && m === 'GET', body: { actions: [] } },
      { match: (u, m) => u.includes('/automations/r1/simulate') && m === 'POST', body: SIM },
    ]);
    const origFetch = globalThis.fetch as unknown as typeof fetch;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/simulate')) simulateCalled = true;
      return origFetch(input, init);
    }));

    renderWithProviders(<AutomationRuleDetailPage />, { route: '/automation/rules/r1', path: '/automation/rules/:id' });
    await screen.findByText(/Reminder/);

    await userEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    await waitFor(() => expect(simulateCalled).toBe(true));
    // The "nothing was sent or scheduled" assurance must be shown.
    expect(await screen.findByText(/Simulation only/i)).toBeInTheDocument();
  });

  it('renders the failed / dead-letter section', async () => {
    mockApi(['automation:read'], [
      { match: (u, m) => /\/automations\/r1$/.test((u.split('?')[0] ?? u)) && m === 'GET', body: RULE },
      { match: (u, m) => u.includes('/automations/r1/runs') && m === 'GET', body: { runs: [] } },
      { match: (u, m) => u.includes('/scheduled-actions') && m === 'GET', body: { actions: [
        { id: 's1', ruleId: 'r1', actionType: 'send_message', status: 'failed', scheduledFor: '2026-01-01T00:00:00Z', expiresAt: null, attempts: 5, maxAttempts: 5, lastError: 'provider_unavailable', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      ] } },
    ]);
    renderWithProviders(<AutomationRuleDetailPage />, { route: '/automation/rules/r1', path: '/automation/rules/:id' });
    expect(await screen.findByText('Failed / dead-letter actions')).toBeInTheDocument();
    expect(await screen.findByText('provider_unavailable')).toBeInTheDocument();
  });
});
