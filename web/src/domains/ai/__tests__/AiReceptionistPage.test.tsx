import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiReceptionistPage } from '../pages/AiReceptionistPage.js';
import { AiHealthPage } from '../pages/AiHealthPage.js';
import { mockApi, renderWithProviders } from './testUtils.js';

afterEach(() => vi.restoreAllMocks());

describe('AiReceptionistPage — clinical escalation is surfaced', () => {
  it('shows the clinical-escalation notice for a clinical question', async () => {
    mockApi(['ai:receptionist'], [
      {
        match: (u, m) => u.includes('/ai/receptionist') && m === 'POST',
        body: { requestId: 'r', intent: 'clinical_question', category: 'clinical', escalate: true, escalateTo: 'clinical_staff', action: 'escalate_clinical', reply: 'I will connect you with our clinical team.', mutating: false },
      },
    ]);
    renderWithProviders(<AiReceptionistPage />);
    await userEvent.type(screen.getByLabelText('Message'), 'what medication should I take for my fever?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByText(/detected as a clinical question and escalated/i)).toBeInTheDocument();
    // Non-mutating assurance always shown.
    expect(screen.getByText(/never books, sends or changes anything/i)).toBeInTheDocument();
  });
});

describe('AiHealthPage', () => {
  it('renders eval runs with pass counts and gates the run button', async () => {
    mockApi(['ai:eval-run'], [
      { match: (u, m) => u.includes('/ai/eval/runs') && m === 'GET', body: { runs: [
        { id: 'e1', suite: 'intake', provider: 'local', model: null, total: 3, passed: 3, failed: 0, avgLatencyMs: 12, createdAt: '2026-01-01T00:00:00Z' },
      ] } },
    ]);
    renderWithProviders(<AiHealthPage />);
    expect(await screen.findByText('3/3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run evaluation' })).toBeInTheDocument();
  });

  it('hides the run button without ai:eval-run', async () => {
    mockApi([], [{ match: (u, m) => u.includes('/ai/eval/runs') && m === 'GET', body: { runs: [] } }]);
    renderWithProviders(<AiHealthPage />);
    await screen.findByText('No evaluation runs yet');
    expect(screen.queryByRole('button', { name: 'Run evaluation' })).not.toBeInTheDocument();
  });
});
