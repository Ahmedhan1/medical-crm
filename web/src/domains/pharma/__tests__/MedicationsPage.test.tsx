import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { MedicationsPage } from '../pages/MedicationsPage.js';
import { mockApi, renderWithProviders } from './testUtils.js';

afterEach(() => vi.unstubAllGlobals());

const med = { id: 'm1', genericName: 'Metformin', atcCode: 'A10BA02', therapeuticArea: 'diabetes', verificationStatus: 'verified' };

describe('MedicationsPage', () => {
  it('lists medications with ATC and verification', async () => {
    mockApi(['medication:read'], [{ match: (u, m) => u.includes('/medications') && m === 'GET', body: { results: [med] } }]);
    renderWithProviders(<MedicationsPage />);
    expect(await screen.findByText('Metformin')).toBeInTheDocument();
    expect(screen.getByText('A10BA02')).toBeInTheDocument();
    expect(screen.getByText('verified')).toBeInTheDocument();
  });

  it('shows an empty state when there are no medications', async () => {
    mockApi(['medication:read'], [{ match: (u, m) => u.includes('/medications') && m === 'GET', body: { results: [] } }]);
    renderWithProviders(<MedicationsPage />);
    expect(await screen.findByText(/No medications found/i)).toBeInTheDocument();
  });
});
