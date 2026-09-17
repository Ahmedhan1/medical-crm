import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import { PatientsPage } from '../pages/PatientsPage.js';
import { mockApi, renderWithProviders, type Handler } from './testUtils.js';

afterEach(() => vi.restoreAllMocks());

const patient = {
  id: 'p1',
  mrn: 'MRN-001',
  fullName: 'Fatima Hassan',
  sex: 'female',
  birthDate: '1990-05-01',
  phone: '+201000000001',
  status: 'active',
};

const searchHandler: Handler = {
  match: (url, method) => method === 'GET' && url.includes('/patients/search'),
  body: { results: [patient] },
};

function renderPage(): void {
  renderWithProviders(
    <Routes>
      <Route path="/clinical/patients" element={<PatientsPage />} />
      <Route path="/clinical/patients/:id" element={<div>patient-360</div>} />
    </Routes>,
    { route: '/clinical/patients' },
  );
}

describe('PatientsPage', () => {
  it('searches on submit and lists matching patients', async () => {
    mockApi(['patient:search', 'patient:read'], [searchHandler]);
    renderPage();

    const box = await screen.findByLabelText('Search');
    await userEvent.type(box, 'fat');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(screen.getByText('Fatima Hassan')).toBeInTheDocument());
    expect(screen.getByText('MRN-001')).toBeInTheDocument();
  });

  it('does not search for a term shorter than 2 characters', async () => {
    mockApi(['patient:search'], [searchHandler]);
    renderPage();
    await screen.findByLabelText('Search');
    // Search button disabled below the 2-char minimum.
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
  });

  it('shows the Register action only with patient:register (RBAC UX filter)', async () => {
    mockApi(['patient:search'], [searchHandler]);
    renderPage();
    await screen.findByLabelText('Search');
    expect(screen.queryByRole('button', { name: 'Register patient' })).not.toBeInTheDocument();
  });

  it('shows the Register action when the permission is held', async () => {
    mockApi(['patient:search', 'patient:register'], [searchHandler]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Register patient' })).toBeInTheDocument(),
    );
  });

  it('offers Check in only with encounter:checkin', async () => {
    mockApi(['patient:search', 'patient:read'], [searchHandler]);
    renderPage();
    const box = await screen.findByLabelText('Search');
    await userEvent.type(box, 'fat');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.getByText('Fatima Hassan')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Check in' })).not.toBeInTheDocument();
  });
});
