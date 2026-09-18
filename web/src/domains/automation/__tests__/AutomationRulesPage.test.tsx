import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AutomationRulesPage } from '../pages/AutomationRulesPage.js';
import { mockApi, renderWithProviders } from './testUtils.js';

const RULE = {
  id: 'r1', name: 'Check-in reminder', description: null, triggerType: 'event', eventType: 'PATIENT_CHECKED_IN',
  scheduleCron: null, conditions: [], actions: [{ type: 'send_message', params: {} }], isEnabled: true, priority: 100,
  version: 3, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

afterEach(() => vi.restoreAllMocks());

describe('AutomationRulesPage', () => {
  it('lists rules with trigger, action count and version', async () => {
    mockApi(['automation:read', 'automation:manage'], [
      { match: (u, m) => u.includes('/automations') && m === 'GET', body: { rules: [RULE] } },
    ]);
    renderWithProviders(<AutomationRulesPage />);
    expect(await screen.findByText('Check-in reminder')).toBeInTheDocument();
    expect(screen.getByText('PATIENT_CHECKED_IN')).toBeInTheDocument();
    expect(screen.getByText('v3')).toBeInTheDocument();
  });

  it('shows an empty state when there are no rules', async () => {
    mockApi(['automation:read'], [{ match: (u, m) => u.includes('/automations') && m === 'GET', body: { rules: [] } }]);
    renderWithProviders(<AutomationRulesPage />);
    expect(await screen.findByText('No automation rules yet')).toBeInTheDocument();
  });

  it('hides create/enable controls without automation:manage (UX filter)', async () => {
    mockApi(['automation:read'], [{ match: (u, m) => u.includes('/automations') && m === 'GET', body: { rules: [RULE] } }]);
    renderWithProviders(<AutomationRulesPage />);
    await screen.findByText('Check-in reminder');
    expect(screen.queryByRole('button', { name: 'New rule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
  });

  it('toggles a rule enabled state via PATCH', async () => {
    let patched = false;
    mockApi(['automation:read', 'automation:manage'], [
      { match: (u, m) => u.includes('/automations') && m === 'GET', body: { rules: [RULE] } },
      { match: (u, m) => /\/automations\/r1$/.test((u.split('?')[0] ?? u)) && m === 'PATCH', body: { ...RULE, isEnabled: false } },
    ]);
    // Track the PATCH happened.
    const origFetch = globalThis.fetch as unknown as typeof fetch;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'PATCH') patched = true;
      return origFetch(input, init);
    }));
    renderWithProviders(<AutomationRulesPage />);
    const row = (await screen.findByText('Check-in reminder')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(patched).toBe(true));
  });
});
