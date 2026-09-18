import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { InvoiceListPage } from '../pages/InvoiceListPage.js';
import { BillingDashboardPage } from '../pages/BillingDashboardPage.js';
import { mockApi, renderWithProviders, type Handler } from './testUtils.js';

afterEach(() => vi.restoreAllMocks());

const invoice = {
  id: 'inv1', patientId: 'p1', invoiceNumber: 'INV-000001', status: 'issued', currency: 'EGP',
  subtotalMinor: 20000, discountMinor: 0, taxMinor: 0, totalMinor: 20000, amountPaidMinor: 0,
  balanceDueMinor: 20000, notes: null, dueDate: null, issuedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z',
};
const listHandler: Handler = {
  match: (url, method) => method === 'GET' && url.includes('/invoices') && !url.match(/\/invoices\/[^/?]+$/),
  body: { invoices: [invoice], total: 1 },
};

function renderList(): void {
  renderWithProviders(
    <Routes>
      <Route path="/finance/invoices" element={<InvoiceListPage />} />
      <Route path="/finance/invoices/:id" element={<div>detail</div>} />
      <Route path="/finance/invoices/new" element={<div>create</div>} />
    </Routes>,
    { route: '/finance/invoices' },
  );
}

describe('InvoiceListPage', () => {
  it('lists invoices with money formatted from minor units', async () => {
    mockApi(['billing:read', 'invoice:create'], [listHandler]);
    renderList();
    await waitFor(() => expect(screen.getByText('INV-000001')).toBeInTheDocument());
    // 20000 minor → 200.00
    expect(screen.getAllByText(/200[.,]00/).length).toBeGreaterThan(0);
    // "Issued" appears both as a filter option and the row badge.
    expect(screen.getAllByText('Issued').length).toBeGreaterThanOrEqual(2);
  });

  it('shows the New invoice action only with invoice:create', async () => {
    mockApi(['billing:read'], [listHandler]);
    renderList();
    await waitFor(() => expect(screen.getByText('INV-000001')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'New invoice' })).not.toBeInTheDocument();
  });
});

describe('BillingDashboardPage', () => {
  it('renders KPIs from the summary API', async () => {
    mockApi(['billing:report', 'invoice:create'], [
      {
        match: (url, method) => method === 'GET' && url.includes('/billing/reports/summary'),
        body: {
          from: '2026-01-01', to: '2026-01-31', currency: 'EGP', revenueMinor: 500000, paymentCount: 3,
          issuedInvoiceCount: 4, paidInvoiceCount: 2, outstandingMinor: 120000, outstandingInvoiceCount: 2,
          byMethod: [{ method: 'cash', amountMinor: 500000, count: 3 }],
        },
      },
    ]);
    renderWithProviders(
      <Routes><Route path="/finance" element={<BillingDashboardPage />} /></Routes>,
      { route: '/finance' },
    );
    // 500000 minor → 5,000.00 revenue
    await waitFor(() => expect(screen.getAllByText(/5,?000[.,]00/).length).toBeGreaterThan(0));
    expect(screen.getByText(/1,?200[.,]00/)).toBeInTheDocument(); // outstanding 120000 → 1,200.00
  });
});
