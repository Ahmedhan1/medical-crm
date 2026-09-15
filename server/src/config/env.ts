import { z } from 'zod';

/**
 * Centralised, validated configuration. The process refuses to start with an
 * invalid or insecure configuration rather than failing later at runtime.
 *
 * There are no `process.env` reads anywhere else in the codebase — everything
 * flows through this validated object so config is typed and testable.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().url(),
  TEST_DATABASE_URL: z.string().url().optional(),

  AUTH_PEPPER: z.string().min(16, 'AUTH_PEPPER must be at least 16 chars'),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(43_200),
  QR_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
});

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  authPepper: string;
  sessionTtlSeconds: number;
  qrTtlSeconds: number;
};

let cached: AppConfig | null = null;

export function loadConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): AppConfig {
  const raw = { ...process.env, ...overrides };
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  const env = parsed.data;
  const isTest = env.NODE_ENV === 'test';
  const databaseUrl = isTest ? env.TEST_DATABASE_URL ?? env.DATABASE_URL : env.DATABASE_URL;

  // A production deployment must not run with the placeholder secret.
  if (env.NODE_ENV === 'production' && env.AUTH_PEPPER.includes('change-me')) {
    throw new Error('Refusing to start in production with the default AUTH_PEPPER.');
  }

  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    databaseUrl,
    authPepper: env.AUTH_PEPPER,
    sessionTtlSeconds: env.SESSION_TTL_SECONDS,
    qrTtlSeconds: env.QR_TTL_SECONDS,
  };
}

/** Lazily-loaded process-wide config. */
export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper: force a fresh load (e.g. after mutating process.env). */
export function resetConfigCache(): void {
  cached = null;
}
