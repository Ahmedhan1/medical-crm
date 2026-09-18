import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * The environment provides Chromium (PLAYWRIGHT_BROWSERS_PATH) which may not match
 * the build @playwright/test bundles. Prefer an explicit binary so CI/BOX never
 * try to download one. Override with MEDCORE_CHROMIUM.
 */
const CHROMIUM_CANDIDATES = [
  process.env.MEDCORE_CHROMIUM,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].filter(Boolean) as string[];
const executablePath = CHROMIUM_CANDIDATES.find((p) => existsSync(p));

/**
 * E2E infrastructure for MEDCORE. Runs against the built SPA served by `vite
 * preview`. Tests that need a real authenticated session are tagged and skip when
 * MEDCORE_E2E_BACKEND is not set, so the shell-level suite (routing, RTL, error
 * handling, build smoke) runs anywhere while domain teams opt into full-stack E2E
 * by pointing MEDCORE_E2E_BACKEND at a running backend with a seeded clinic.
 *
 * Chromium is provided by the environment (PLAYWRIGHT_BROWSERS_PATH); we do not
 * download a browser.
 */
const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
  ],
  webServer: {
    command: `npm run preview -- --port ${PORT}`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
