import { expect, test } from '@playwright/test';

/**
 * Shell-level E2E — runs without a backend. Proves the platform foundation:
 * protected routing fails closed, the login screen renders, RTL is structural,
 * and API failure surfaces as a handled error rather than a blank page.
 */

test('protected route fails closed → redirects anonymous user to /login', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
});

test('login page renders the auth form (auth smoke)', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByLabel(/clinic id/i)).toBeVisible();
  await expect(page.getByLabel(/username/i)).toBeVisible();
  await expect(page.getByLabel(/password/i)).toBeVisible();
});

test('Arabic toggle flips document direction to RTL (structural)', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
});

test('failed login surfaces a handled error, not a crash (API error handling)', async ({
  page,
}) => {
  // No backend behind /api in this project → the client maps it to a handled
  // error and the app stays on the login screen with a message.
  await page.goto('/login');
  await page.getByLabel(/clinic id/i).fill('00000000-0000-0000-0000-000000000000');
  await page.getByLabel(/username/i).fill('nobody');
  await page.getByLabel(/password/i).fill('wrong');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});
