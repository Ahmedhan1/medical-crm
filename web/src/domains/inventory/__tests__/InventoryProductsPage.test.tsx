import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { InventoryProductsPage } from '../pages/InventoryProductsPage.js';
import { mockApi, product, renderWithProviders } from './testUtils.js';

afterEach(() => vi.unstubAllGlobals());

describe('InventoryProductsPage', () => {
  it('lists products from the API', async () => {
    mockApi(['inventory:read'], [
      { match: (u, m) => u.includes('/inventory/products') && m === 'GET', body: { products: [product({ name: 'Gloves M', sku: 'GLOVE-M' })] } },
    ]);
    renderWithProviders(<InventoryProductsPage />);
    expect(await screen.findByText('Gloves M')).toBeInTheDocument();
    expect(screen.getByText('GLOVE-M')).toBeInTheDocument();
  });

  it('hides "New product" without inventory:manage', async () => {
    mockApi(['inventory:read'], [
      { match: (u, m) => u.includes('/inventory/products') && m === 'GET', body: { products: [] } },
    ]);
    renderWithProviders(<InventoryProductsPage />);
    await waitFor(() => expect(screen.getByText(/No products yet/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /New product/i })).not.toBeInTheDocument();
  });

  it('shows "New product" with inventory:manage', async () => {
    mockApi(['inventory:read', 'inventory:manage'], [
      { match: (u, m) => u.includes('/inventory/products') && m === 'GET', body: { products: [] } },
    ]);
    renderWithProviders(<InventoryProductsPage />);
    expect(await screen.findByRole('button', { name: /New product/i })).toBeInTheDocument();
  });
});
