import { config } from './config/env.js';
import { runMigrations } from './db/migrate.js';
import { closePool } from './db/pool.js';
import { buildServer } from './http/server.js';

async function main(): Promise<void> {
  const cfg = config();

  // Apply any pending migrations on boot so a fresh clinic box is self-setting-up.
  const applied = await runMigrations();
  if (applied.length) {
    // eslint-disable-next-line no-console
    console.log(`[boot] applied migrations: ${applied.join(', ')}`);
  }

  const app = buildServer();
  await app.listen({ host: cfg.host, port: cfg.port });

  const shutdown = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[boot] fatal:', err);
  process.exit(1);
});
