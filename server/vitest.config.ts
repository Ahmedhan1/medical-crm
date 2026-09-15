import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      AUTH_PEPPER: 'test-pepper-value-0123456789',
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/medcore_test',
      TEST_DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/medcore_test',
      SESSION_TTL_SECONDS: '3600',
      QR_TTL_SECONDS: '3600',
    },
    setupFiles: ['./test/helpers/setup.ts'],
    // Integration tests share a single Postgres database; run test files
    // serially so schema reset in one file cannot race another.
    fileParallelism: false,
    include: ['test/**/*.test.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
