import { expect, test } from '@playwright/test';

/**
 * Full-stack authenticated E2E template for the domain teams. Skipped unless a
 * real backend is wired (MEDCORE_E2E_BACKEND=1) with a seeded clinic whose
 * credentials are provided via env. Agents 2/3/4 copy this pattern for their
 * domain journeys (patient check-in, AI draft review, HCP verification, …).
 */
const hasBackend = process.env.MEDCORE_E2E_BACKEND === '1';

test.describe('authenticated session (requires backend + seed)', () => {
  test.skip(!hasBackend, 'set MEDCORE_E2E_BACKEND=1 with a seeded clinic to run');

  test('logs in and lands on the dashboard, then RBAC-filtered nav shows', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/clinic id/i).fill(process.env.MEDCORE_E2E_CLINIC_ID ?? '');
    await page.getByLabel(/username/i).fill(process.env.MEDCORE_E2E_USERNAME ?? '');
    await page.getByLabel(/password/i).fill(process.env.MEDCORE_E2E_PASSWORD ?? '');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('navigation', { name: /primary/i })).toBeVisible();
  });
});
