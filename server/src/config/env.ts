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

  // --- Auth throttling / lockout (brute-force protection) ---
  // Per-account: N failed logins within the window locks the account for the
  // lockout period. Per-IP: a coarse request cap on the login route.
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  LOGIN_LOCKOUT_SECONDS: z.coerce.number().int().positive().default(900),
  LOGIN_IP_MAX_PER_MINUTE: z.coerce.number().int().positive().default(30),

  // --- Backup / recovery (Phase 2) ---
  // Directory the backup engine writes to. Local-first: a path on the MEDCORE
  // box (or a mounted external/encrypted volume). Never exposed via any API.
  BACKUP_DIR: z.string().default('./backups'),
  // Optional at-rest encryption. When set (>=32 chars) dumps are AES-256-GCM
  // encrypted; the key lives in the secret manager, never in the DB or a backup.
  BACKUP_ENCRYPTION_KEY: z.string().min(32).optional(),
  // Retention (rotation) targets. GFS-style; pruning keeps the newest N of each.
  BACKUP_RETAIN_DAILY: z.coerce.number().int().nonnegative().default(7),
  BACKUP_RETAIN_WEEKLY: z.coerce.number().int().nonnegative().default(4),
  BACKUP_RETAIN_MONTHLY: z.coerce.number().int().nonnegative().default(3),
});

export interface BackupConfig {
  dir: string;
  encryptionKey?: string;
  retainDaily: number;
  retainWeekly: number;
  retainMonthly: number;
}

export interface AuthThrottleConfig {
  maxAttempts: number;
  windowSeconds: number;
  lockoutSeconds: number;
  ipMaxPerMinute: number;
}

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  authPepper: string;
  sessionTtlSeconds: number;
  qrTtlSeconds: number;
  backup: BackupConfig;
  authThrottle: AuthThrottleConfig;
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
    backup: {
      dir: env.BACKUP_DIR,
      encryptionKey: env.BACKUP_ENCRYPTION_KEY,
      retainDaily: env.BACKUP_RETAIN_DAILY,
      retainWeekly: env.BACKUP_RETAIN_WEEKLY,
      retainMonthly: env.BACKUP_RETAIN_MONTHLY,
    },
    authThrottle: {
      maxAttempts: env.LOGIN_MAX_ATTEMPTS,
      windowSeconds: env.LOGIN_WINDOW_SECONDS,
      lockoutSeconds: env.LOGIN_LOCKOUT_SECONDS,
      ipMaxPerMinute: env.LOGIN_IP_MAX_PER_MINUTE,
    },
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
