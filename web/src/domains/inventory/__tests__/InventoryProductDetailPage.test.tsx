import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { InventoryProductDetailPage } from '../pages/InventoryProductDetailPage.js';
import { mockApi, product, renderWithProviders } from './testUtils.js';

afterEach(() => vi.unstubAllGlobals());

function handlers(): { match: (u: string, m: string) => boolean; body: unknown }[] {
  return [
    { match: (u) => /\/inventory\/products\/p1$/.test(u.split('?')[0] ?? u), body: { product: product({ name: 'Syringe' }), balances: [{ productId: 'p1', productName: 'Syringe', sku: 'SKU1', locationId: 'l1', locationName: 'Main', batchId: null, lotNumber: null, expiryDate: null, onHand: 42 }], batches: [] } },
    { match: (u) => u.includes('/inventory/locations'), body: { locations: [{ id: 'l1', code: 'MAIN', name: 'Main', kind: 'store', isActive: true, createdAt: '', updatedAt: '' }] } },
    { match: (u) => u.includes('/inventory/movements'), body: { movements: [] } },
  ];
}
const page = <Routes><Route path="/inventory/products/:id" element={<InventoryProductDetailPage />} /></Routes>;

describe('InventoryProductDetailPage', () => {
  it('shows on-hand balance and the stock actions the user is allowed', async () => {
    mockApi(['inventory:read', 'stock:receive', 'stock:issue'], handlers());
    renderWithProviders(page, { route: '/inventory/products/p1' });
    expect((await screen.findAllByText(/42 unit/)).length).toBeGreaterThan(0);
    expect(screen.getByText('Main')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Receive$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Issue$/ })).toBeInTheDocument();
    // No transfer/adjust perms → those actions are hidden.
    expect(screen.queryByRole('button', { name: /^Transfer$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Adjust$/ })).not.toBeInTheDocument();
  });

  it('hides every stock action for a read-only user', async () => {
    mockApi(['inventory:read'], handlers());
    renderWithProviders(page, { route: '/inventory/products/p1' });
    await waitFor(() => expect(screen.getByText('Main')).toBeInTheDocument());
    for (const name of [/^Receive$/, /^Issue$/, /^Transfer$/, /^Adjust$/]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });
});
