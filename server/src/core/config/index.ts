/**
 * Configuration, validated once at startup.
 *
 * The process refuses to boot on a missing or malformed value rather than
 * failing later at the first request that happens to need it. A bad JWT secret
 * discovered at login time looks like a login bug; discovered here it reads as
 * what it is.
 */

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Read a .env file into process.env without overwriting anything already set.
 *
 * Kept rather than taking a dependency, and ported from the old POS `env.js`
 * for the same reason it was written there: it must run before anything else,
 * so it cannot depend on `npm install` having succeeded. An already-exported
 * value always wins, so a deliberate override in a terminal is never silently
 * replaced by a stale file.
 */
function loadEnvFile(): void {
  const file = process.env.ENV_FILE || path.join(__dirname, '../../../.env');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq < 1) continue;

    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    // Strip quotes only after taking the whole rest of the line, so a secret
    // containing '#' or a space survives intact.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const csv = (raw: string): string[] =>
  raw.split(',').map((s) => s.trim()).filter(Boolean);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().startsWith('/').default('/api/v1'),

  DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a Postgres connection URI' }),
  /**
   * A privileged connection used ONLY by migrations and seeding.
   *
   * The application itself runs as a limited role that cannot create tables, so
   * it cannot be the connection that alters them. Falls back to DATABASE_URL in
   * development, where both are the same superuser-ish account anyway.
   */
  MIGRATION_DATABASE_URL: z.string().url().optional(),
  PGPOOL_MAX: z.coerce.number().int().min(1).max(50).default(8),
  /** Caps a runaway query rather than letting it hold a pooled connection all day. */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  /* Tokens. Access tokens stay short because permissions are deliberately NOT
   * carried in them — a revoked role must stop working quickly. */
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  /* Login hardening. */
  MAX_FAILED_LOGINS: z.coerce.number().int().min(1).default(5),
  ACCOUNT_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),

  CORS_ORIGINS: z.string().default('').transform(csv),
  TRUST_PROXY: z.coerce.boolean().default(false),

  REDIS_URL: z.string().url().optional(),

  UPLOAD_DIR: z.string().default('./var/uploads'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof schema> & {
  isProduction: boolean;
  isTest: boolean;
};

function build(): Config {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    // Names and reasons only. Printing the offending values here would put a
    // database password and both signing secrets into whatever collects stdout.
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    console.error('Configuration is invalid:\n' + lines.join('\n'));
    process.exit(1);
  }

  const env = parsed.data;

  // A wildcard origin in production would let any site drive the API with the
  // caller's cookies. Caught here rather than left to a reviewer to notice.
  if (env.NODE_ENV === 'production') {
    if (env.CORS_ORIGINS.length === 0 || env.CORS_ORIGINS.includes('*')) {
      console.error('Configuration is invalid:\n  - CORS_ORIGINS must list explicit origins in production');
      process.exit(1);
    }
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      console.error('Configuration is invalid:\n  - JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
      process.exit(1);
    }
  }

  return {
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
  };
}

export const config: Config = build();
