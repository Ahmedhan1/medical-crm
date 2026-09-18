import { expect, test, type Page } from '@playwright/test';

/**
 * Agent-3 domain E2E — real browser against the built SPA, with the backend
 * mocked in-page via route interception (this environment has no live backend).
 * Proves the automation, AI and WhatsApp-setup routes mount, render their data,
 * and surface their safety assurances. Full-stack E2E against a seeded backend is
 * opt-in via MEDCORE_E2E_BACKEND (see playwright.config.ts).
 */

const PERMS = ['automation:read', 'automation:manage', 'messaging:read', 'messaging:manage', 'ai:draft-review', 'ai:eval-run', 'ai:receptionist', 'inventory:read', 'inventory:manage', 'stock:receive', 'hcp:read', 'hco:read', 'visit:read', 'medication:read', 'content:read'];

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

async function mockBackend(page: Page, routes: Record<string, unknown>): Promise<void> {
  await page.addInitScript(() => {
    try { localStorage.setItem('medcore.session.token', 'e2e-token'); } catch { /* ignore */ }
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, '');
    if (path === '/auth/me') {
      return route.fulfill(json({ id: 'u1', username: 'tester', clinicId: 'c1', roles: ['ADMIN'], permissions: PERMS }));
    }
    for (const [key, body] of Object.entries(routes)) {
      if (path === key || path.startsWith(key)) return route.fulfill(json(body));
    }
    return route.fulfill(json({ error: { code: 'not_found', message: 'not found' } }, 404));
  });
}

test('automation rules page lists rules from the API', async ({ page }) => {
  await mockBackend(page, {
    '/automations': { rules: [{ id: 'r1', name: 'Check-in reminder', description: null, triggerType: 'event', eventType: 'PATIENT_CHECKED_IN', scheduleCron: null, conditions: [], actions: [{ type: 'send_message', params: {} }], isEnabled: true, priority: 100, version: 2, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] },
  });
  await page.goto('/automation/rules');
  await expect(page.getByText('Check-in reminder')).toBeVisible();
  await expect(page.getByText('PATIENT_CHECKED_IN')).toBeVisible();
});

test('AI drafts page shows the review-first assurance', async ({ page }) => {
  await mockBackend(page, { '/ai/drafts': { drafts: [] } });
  await page.goto('/ai/drafts');
  await expect(page.getByText(/review-first/i)).toBeVisible();
});

test('WhatsApp setup shows a not-configured state offline', async ({ page }) => {
  await mockBackend(page, {
    '/whatsapp/status': { provider: 'gowa', configured: false, status: 'disconnected', phoneMasked: null, lastErrorCode: null, pairedAt: null, lastStatusAt: '2026-01-01T00:00:00Z' },
  });
  await page.goto('/messaging/whatsapp');
  await expect(page.getByText(/WhatsApp is not configured/i)).toBeVisible();
});

test('inventory products page lists a product from the API', async ({ page }) => {
  await mockBackend(page, {
    '/inventory/products': { products: [{ id: 'p1', sku: 'GLOVE-M', name: 'Gloves M', category: 'supplies', unitOfMeasure: 'unit', medicationProductId: null, isBatchTracked: false, isExpiryTracked: false, blockExpiredIssue: true, allowNegativeStock: false, reorderThreshold: 20, reorderQuantity: null, isBillable: false, billingCode: null, unitPrice: null, unitCost: null, isActive: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] },
  });
  await page.goto('/inventory/products');
  await expect(page.getByText('Gloves M')).toBeVisible();
  await expect(page.getByText('GLOVE-M')).toBeVisible();
});

test('CRM professionals page lists an HCP from the API', async ({ page }) => {
  await mockBackend(page, {
    '/hcps': { results: [{ id: 'h1', fullName: 'Sara Ali', title: 'Dr', professionalCategory: 'physician', primarySpecialtyId: null, professionalEmail: 'sara@example.com', professionalPhone: null, status: 'active' }] },
  });
  await page.goto('/crm/hcps');
  await expect(page.getByText('Dr Sara Ali')).toBeVisible();
});

test('pharma medications page lists the drug master', async ({ page }) => {
  await mockBackend(page, {
    '/medications': { results: [{ id: 'm1', genericName: 'Metformin', atcCode: 'A10BA02', therapeuticArea: 'diabetes', verificationStatus: 'verified' }] },
  });
  await page.goto('/pharma/medications');
  await expect(page.getByText('Metformin')).toBeVisible();
  await expect(page.getByText('A10BA02')).toBeVisible();
});
