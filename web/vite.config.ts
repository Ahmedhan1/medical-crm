import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// MEDCORE frontend build. Served locally on the BOX (static files behind the same
// origin as the API), so the production build is a plain SPA bundle. In dev, the
// API is reached through a same-origin proxy so there is no CORS surface and the
// backend needs no CORS config (preserving the trusted backend).
const API_TARGET = process.env.MEDCORE_API_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Surface the production bundle size (perf visibility, not premature tuning).
    reportCompressedSize: true,
    chunkSizeWarningLimit: 600,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: true,
  },
});
