import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'], { error: 'expected true or false' })
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1'));

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HQ_PORT: z.coerce.number().int().default(8090),
  /** Public origin of the HQ (where the browser loads it). Used for the CSRF origin check and the GitHub OAuth callback. */
  HQ_PUBLIC_URL: z.string().default('http://localhost:5180'),
  /** Extra allowed origins (comma separated), e.g. the Vite dev server. */
  HQ_ALLOWED_ORIGINS: z.string().default('http://localhost:5180,http://localhost:8090'),

  /** postgres://… in production. Unset = PGlite stored in HQ_PGLITE_DIR (persistent across restarts). */
  HQ_DATABASE_URL: z.string().optional(),
  HQ_PGLITE_DIR: z.string().default('./.data/hq'),
  DATABASE_SSL: bool(false),
  DATABASE_SSL_CA: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
  MIGRATE_ON_START: bool(true),

  /**
   * 32-byte key (base64 or hex) that encrypts provider API keys and the GitHub token at rest (AES-256-GCM).
   * Required in production. In development a key is generated once into HQ_PGLITE_DIR/../hq.key.
   */
  HQ_ENCRYPTION_KEY: z.string().optional(),
  HQ_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),
  COOKIE_SECURE: bool(true),

  /** GitHub OAuth app or GitHub App (user-to-server) credentials. Without them, a fine-grained token can be pasted instead. */
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_API_URL: z.string().default('https://api.github.com'),

  /** Directory with the built HQ frontend (apps/hq/dist). Served at / when present. */
  HQ_STATIC_DIR: z.string().optional(),
  /** Run the background worker (task queue, meetings) in this process. */
  HQ_WORKER: bool(true)
});

export type Config = z.infer<typeof Env> & { DATABASE_URL?: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg: Config = Env.parse(env);
  cfg.DATABASE_URL = cfg.HQ_DATABASE_URL;
  if (cfg.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (!cfg.HQ_ENCRYPTION_KEY) problems.push('HQ_ENCRYPTION_KEY is required (32 random bytes, base64)');
    if (!cfg.HQ_PUBLIC_URL.startsWith('https://')) problems.push('HQ_PUBLIC_URL must be https://');
    if (problems.length) throw new Error('Unsafe production configuration:\n- ' + problems.join('\n- '));
    cfg.COOKIE_SECURE = true;
  }
  return cfg;
}

export function allowedOrigins(cfg: Config): Set<string> {
  const set = new Set(cfg.HQ_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean));
  set.add(new URL(cfg.HQ_PUBLIC_URL).origin);
  return set;
}
