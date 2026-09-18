import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiDraftDetailPage } from '../pages/AiDraftDetailPage.js';
import { AiDraftsPage } from '../pages/AiDraftsPage.js';
import { mockApi, renderWithProviders } from './testUtils.js';

const DRAFT = {
  id: 'd1', kind: 'intake', subjectType: 'patient', subjectId: '00000000-0000-0000-0000-000000000001',
  status: 'pending', content: { fields: [{ name: 'chiefComplaint', value: 'fever' }] },
  citations: [{ ref: 'input-text', kind: 'transcript' }], provider: 'local', model: null,
  reviewedBy: null, reviewedAt: null, reviewNote: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

afterEach(() => vi.restoreAllMocks());

describe('AiDraftsPage', () => {
  it('shows the review-first assurance and lists drafts', async () => {
    mockApi(['ai:draft-review'], [{ match: (u, m) => u.includes('/ai/drafts') && m === 'GET', body: { drafts: [DRAFT] } }]);
    renderWithProviders(<AiDraftsPage />);
    expect(await screen.findByText(/review-first/i)).toBeInTheDocument();
    expect(await screen.findByText('Intake')).toBeInTheDocument();
  });
});

describe('AiDraftDetailPage — human review', () => {
  it('confirms a pending draft and shows the not-clinical-write notice', async () => {
    let confirmed = false;
    mockApi(['ai:draft-review'], [
      { match: (u, m) => /\/ai\/drafts\/d1$/.test((u.split('?')[0] ?? u)) && m === 'GET', body: DRAFT },
      { match: (u, m) => u.includes('/ai/drafts/d1/confirm') && m === 'POST', body: { ...DRAFT, status: 'confirmed' } },
    ]);
    const origFetch = globalThis.fetch as unknown as typeof fetch;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/confirm')) confirmed = true;
      return origFetch(input, init);
    }));
    renderWithProviders(<AiDraftDetailPage />, { route: '/ai/drafts/d1', path: '/ai/drafts/:id' });
    // The safety notice (does NOT write to the clinical record) is visible.
    expect(await screen.findByText(/does NOT write to the clinical record/i)).toBeInTheDocument();
    expect(screen.getByText(/Validated against the versioned schema/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm draft' }));
    await waitFor(() => expect(confirmed).toBe(true));
  });

  it('hides confirm/reject without ai:draft-review', async () => {
    mockApi([], [{ match: (u, m) => /\/ai\/drafts\/d1$/.test((u.split('?')[0] ?? u)) && m === 'GET', body: DRAFT }]);
    renderWithProviders(<AiDraftDetailPage />, { route: '/ai/drafts/d1', path: '/ai/drafts/:id' });
    await screen.findByText(/Review draft/i);
    expect(screen.queryByRole('button', { name: 'Confirm draft' })).not.toBeInTheDocument();
  });
});
