import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { Patient360Page } from '../pages/Patient360Page.js';
import { mockApi, renderWithProviders, type Handler } from './testUtils.js';

afterEach(() => vi.restoreAllMocks());

function view(body: unknown): Handler {
  return {
    match: (url, method) => method === 'GET' && /\/patients\/[^/]+\/360$/.test(url),
    body,
  };
}

function renderAt(id: string): void {
  renderWithProviders(
    <Routes>
      <Route path="/clinical/patients/:id" element={<Patient360Page />} />
    </Routes>,
    { route: `/clinical/patients/${id}` },
  );
}

describe('Patient360Page', () => {
  it('renders only the sections the backend returned (omitted = not shown)', async () => {
    mockApi(
      ['patient:read'],
      [
        view({
          patient: {
            id: 'p1',
            mrn: 'MRN-9',
            fullName: 'Omar Ali',
            sex: 'male',
            birthDate: '1980-01-01',
            status: 'active',
            preferredLanguage: null,
            phone: '+201',
            email: null,
            mergedIntoId: null,
          },
          allergies: [{ id: 'a1', substance: 'Penicillin', severity: 'severe', status: 'active' }],
          activePrescriptions: [
            { id: 'rx1', status: 'active', items: [{ medicationName: 'Paracetamol', dose: '1g', route: 'oral', frequency: 'qds' }] },
          ],
          // NOTE: procedures/carePlans intentionally omitted (no permission) →
          // must NOT appear at all.
        }),
      ],
    );
    renderAt('p1');

    await waitFor(() => expect(screen.getByText('Omar Ali')).toBeInTheDocument());
    expect(screen.getByText(/Allergies/)).toBeInTheDocument();
    expect(screen.getByText(/Penicillin/)).toBeInTheDocument();
    expect(screen.getByText(/Active prescriptions/)).toBeInTheDocument();
    expect(screen.getByText(/Paracetamol/)).toBeInTheDocument();
    // Omitted sections are absent, never shown as empty.
    expect(screen.queryByText(/Procedures/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Care plans/)).not.toBeInTheDocument();
  });

  it('flags a merged record and links to the survivor', async () => {
    mockApi(
      ['patient:read'],
      [
        view({
          patient: {
            id: 'dup',
            mrn: 'MRN-D',
            fullName: 'Dup Record',
            sex: 'female',
            birthDate: null,
            status: 'merged',
            preferredLanguage: null,
            phone: null,
            email: null,
            mergedIntoId: 'survivor-1',
          },
        }),
      ],
    );
    renderAt('dup');
    await waitFor(() => expect(screen.getByText('Dup Record')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/merged/i);
    const link = screen.getByRole('link', { name: /open/i });
    expect(link).toHaveAttribute('href', '/clinical/patients/survivor-1');
  });

  it('shows a forbidden message when the backend denies the 360 (403)', async () => {
    mockApi(
      ['patient:read'],
      [
        {
          match: (url, method) => method === 'GET' && /\/patients\/[^/]+\/360$/.test(url),
          status: 403,
          body: { error: { code: 'forbidden', message: 'no' } },
        },
      ],
    );
    renderAt('p1');
    await waitFor(() =>
      expect(screen.getByText(/do not have permission/i)).toBeInTheDocument(),
    );
  });
});
