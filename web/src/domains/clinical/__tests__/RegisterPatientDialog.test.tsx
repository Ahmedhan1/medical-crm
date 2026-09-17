import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegisterPatientDialog } from '../components/RegisterPatientDialog.js';
import { mockApi, renderWithProviders, type Handler } from './testUtils.js';

afterEach(() => vi.restoreAllMocks());

function renderDialog(onRegistered = vi.fn()): { onRegistered: ReturnType<typeof vi.fn> } {
  renderWithProviders(
    <RegisterPatientDialog open onClose={() => {}} onRegistered={onRegistered} />,
    { route: '/clinical/patients' },
  );
  return { onRegistered };
}

describe('RegisterPatientDialog', () => {
  it('validates the name client-side before calling the API', async () => {
    const created: Handler = {
      match: (url, method) => method === 'POST' && url.endsWith('/patients'),
      status: 201,
      body: {},
    };
    mockApi(['patient:register'], [created]);
    const { onRegistered } = renderDialog();
    await screen.findByLabelText('Full name');
    // Submit with an empty name → inline error, no success callback.
    await userEvent.click(screen.getByRole('button', { name: 'Register' }));
    expect(await screen.findByText(/at least 2 characters/i)).toBeInTheDocument();
    expect(onRegistered).not.toHaveBeenCalled();
  });

  it('registers a valid patient and calls back', async () => {
    const patient = { id: 'p1', mrn: 'MRN-1', fullName: 'New One', sex: 'female', birthDate: null, phone: null, status: 'active' };
    mockApi(['patient:register'], [
      { match: (url, method) => method === 'POST' && url.endsWith('/patients'), status: 201, body: patient },
    ]);
    const { onRegistered } = renderDialog();
    await userEvent.type(screen.getByLabelText('Full name'), 'New One');
    await userEvent.click(screen.getByRole('button', { name: 'Register' }));
    await waitFor(() => expect(onRegistered).toHaveBeenCalledWith(patient));
  });

  it('surfaces a soft-duplicate (409) as a confirm-to-override warning, not a silent create', async () => {
    const dup: Handler = {
      match: (url, method) => method === 'POST' && url.endsWith('/patients'),
      status: 409,
      body: { error: { code: 'conflict', message: 'exists', details: { existingPatientId: 'x' } } },
    };
    mockApi(['patient:register'], [dup]);
    const { onRegistered } = renderDialog();
    await userEvent.type(screen.getByLabelText('Full name'), 'Dup Person');
    await userEvent.click(screen.getByRole('button', { name: 'Register' }));
    // Duplicate warning appears; the record is never created without confirmation.
    expect(await screen.findByText(/matching patient already exists/i)).toBeInTheDocument();
    expect(onRegistered).not.toHaveBeenCalled();
  });
});
