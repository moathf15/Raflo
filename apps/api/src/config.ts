import { z } from 'zod';

/** Strict boolean: only true/false/1/0. `z.coerce.boolean()` turned "false" into true (audit 6.3). */
const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'], { error: 'expected true or false' })
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1'));

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8080),

  /** postgres://… in production, as the limited `riflo_app` role (see ops/db/roles.sql). Unset = PGlite (in-process). */
  DATABASE_URL: z.string().optional(),
  /** Owner role used only by `npm run migrate` / `create-admin` (DDL rights). Defaults to DATABASE_URL. */
  DATABASE_MIGRATION_URL: z.string().optional(),
  /** Run migrations when the server starts. Off in production, where migrations run as a separate step. */
  MIGRATE_ON_START: bool(true),
  PGLITE_DIR: z.string().optional(),
  /** Encrypt the connection to PostgreSQL, verifying the server certificate. Forced on in production. */
  DATABASE_SSL: bool(false),
  /** PEM file of the CA that signed the database certificate (managed providers publish one). Default: system CAs. */
  DATABASE_SSL_CA: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** Any single query is cancelled after this long. */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),

  JWT_SECRET: z.string().min(32).default('dev-only-secret-change-me-dev-only-secret'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** Session cookie flags. Secure is forced on in production. */
  COOKIE_SECURE: bool(true),
  COOKIE_DOMAIN: z.string().optional(),

  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174,http://localhost:4173,http://localhost:4174'),

  /** Return sign-in codes in the API response. Refused in production. */
  AUTH_DEV_CODES: bool(false),
  /** Enables /v1/auth/native/verify, which returns a bearer token for native apps. Off by default: browsers use the cookie only. */
  NATIVE_CLIENTS: bool(false),
  /** Sign-in requests allowed per IP per 10 minutes (per-email limits are separate and stored in the database). */
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(5),

  /** `log` = development only, never prints the code. `smtp` = any SMTP provider (SES, SendGrid, Postmark…). */
  EMAIL_PROVIDER: z.enum(['log', 'smtp']).default('log'),
  SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  /** Shared rate-limit store so limits hold across several API instances. */
  REDIS_URL: z.string().optional(),
  /** Set to `memory` only when exactly one API instance runs. */
  RATE_LIMIT_STORE: z.enum(['redis', 'memory']).optional(),

  /**
   * Which reverse proxies may set X-Forwarded-For (security audit S1). Without this, any client could choose its
   * own IP and bypass every per-IP rate limit. `false` (the default) = the API is reached directly; otherwise a
   * comma-separated list of the proxies' addresses or CIDRs, e.g. `10.0.0.0/8` or `uniquelocal` (private ranges).
   * `true` (trust anyone) and hop counts (Fastify treats them as "trust nothing") are refused.
   */
  TRUST_PROXY: z
    .string()
    .trim()
    .refine((v) => v !== 'true', 'TRUST_PROXY=true lets any client choose its IP; list the proxy addresses or CIDRs')
    .refine((v) => !/^\d+$/.test(v), 'hop counts are not supported; list the proxy addresses or CIDRs')
    .optional(),

  PRAYER_BREAK_MINUTES: z.coerce.number().int().min(10).max(60).default(20)
});

export type Config = z.infer<typeof Env>;

/** TRUST_PROXY as Fastify's `trustProxy` option: false, or the list of trusted proxy addresses/CIDRs. */
export function trustProxySetting(raw: string | undefined): false | string[] {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = Env.parse(env);
  if (cfg.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (!cfg.DATABASE_URL) problems.push('DATABASE_URL is required');
    if (cfg.JWT_SECRET.startsWith('dev-only') || cfg.JWT_SECRET.length < 48) problems.push('JWT_SECRET must be a random secret of 48+ characters');
    if (cfg.AUTH_DEV_CODES) problems.push('AUTH_DEV_CODES must be false');
    if (cfg.EMAIL_PROVIDER !== 'smtp' || !cfg.SMTP_URL || !cfg.EMAIL_FROM) problems.push('EMAIL_PROVIDER=smtp with SMTP_URL and EMAIL_FROM is required');
    if (cfg.CORS_ORIGINS.split(',').some((o) => !o.trim().startsWith('https://'))) problems.push('CORS_ORIGINS must all be https://');
    if (cfg.TRUST_PROXY === undefined) problems.push('TRUST_PROXY is required: the proxy addresses/CIDRs in front of the API, or false if there is none');
    if (!cfg.REDIS_URL && cfg.RATE_LIMIT_STORE !== 'memory') problems.push('set REDIS_URL, or RATE_LIMIT_STORE=memory if only one instance runs');
    if (problems.length) throw new Error('Unsafe production configuration:\n- ' + problems.join('\n- '));
    cfg.DATABASE_SSL = true;
    cfg.COOKIE_SECURE = true;
    if (env.MIGRATE_ON_START === undefined) cfg.MIGRATE_ON_START = false;
  }
  return cfg;
}
