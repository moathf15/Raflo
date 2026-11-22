import { randomBytes } from 'node:crypto';
import type { Config } from './config';
import type { Ctx } from './context';
import { openDb, type Db } from './db/client';
import { migrate } from './db/migrate';
import { seedOrg } from './db/org';
import type { Fetch } from './github/client';
import { Bus } from './lib/bus';
import { loadVault, type Vault } from './lib/crypto';
import { Worker } from './orchestrator/worker';
import { createProviders, type ProviderFactory } from './providers/registry';

export interface HqOptions {
  db?: Db;
  vault?: Vault;
  providerFactory?: ProviderFactory;
  githubFetch?: Fetch;
  workerIntervalMs?: number;
}

/** Wire the HQ: database (migrated, organisation seeded on first start), vault, event bus, providers and worker. */
export async function createHq(cfg: Config, opts: HqOptions = {}) {
  const db = opts.db ?? (await openDb(cfg, { url: cfg.DATABASE_URL, max: cfg.DB_POOL_MAX, statementTimeoutMs: cfg.DB_STATEMENT_TIMEOUT_MS, pgliteDir: cfg.HQ_PGLITE_DIR }));
  if (cfg.MIGRATE_ON_START) await migrate(db);
  await seedOrg(db);
  const vault = opts.vault ?? loadVault(cfg);
  const bus = new Bus();
  const ctx: Ctx = { db, cfg, vault, bus, providers: createProviders(db, vault, opts.providerFactory), githubFetch: opts.githubFetch ?? fetch, wake: () => {} };
  const worker = new Worker(ctx, opts.workerIntervalMs);
  ctx.wake = worker.wake;
  // A one-time code for creating the first owner; printed to the log, valid until an owner exists.
  const [{ n }] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM hq_owners');
  const setupCode = n === 0 ? randomBytes(6).toString('hex') : null;
  return { ctx, db, worker, setupCode };
}
