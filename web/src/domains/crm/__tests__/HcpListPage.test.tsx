import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { HcpListPage } from '../pages/HcpListPage.js';
import { mockApi, renderWithProviders } from './testUtils.js';

afterEach(() => vi.unstubAllGlobals());

const hcp = { id: 'h1', fullName: 'Sara Ali', title: 'Dr', professionalCategory: 'physician', primarySpecialtyId: null, professionalEmail: 'sara@example.com', professionalPhone: null, status: 'active' };

describe('HcpListPage', () => {
  it('lists healthcare professionals with status and contact', async () => {
    mockApi(['hcp:read'], [{ match: (u, m) => u.includes('/hcps') && m === 'GET', body: { results: [hcp] } }]);
    renderWithProviders(<HcpListPage />);
    expect(await screen.findByText('Dr Sara Ali')).toBeInTheDocument();
    expect(screen.getByText('sara@example.com')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows an empty state when there are no professionals', async () => {
    mockApi(['hcp:read'], [{ match: (u, m) => u.includes('/hcps') && m === 'GET', body: { results: [] } }]);
    renderWithProviders(<HcpListPage />);
    expect(await screen.findByText(/No professionals found/i)).toBeInTheDocument();
  });
});
