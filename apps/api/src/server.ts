import { buildApp } from './app';
import { loadConfig } from './config';
import { openDb } from './db/client';
import { migrate } from './db/migrate';
import { seed } from './db/seed';

const cfg = loadConfig();
const db = await openDb(cfg, { url: cfg.DATABASE_URL, max: cfg.DB_POOL_MAX, statementTimeoutMs: cfg.DB_STATEMENT_TIMEOUT_MS, pgliteDir: cfg.PGLITE_DIR });

if (cfg.MIGRATE_ON_START) await migrate(db);
if (!cfg.DATABASE_URL) await seed(db); // local PGlite starts with the Madinah sample content

const app = await buildApp(db, cfg);
await app.listen({ port: cfg.PORT, host: '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}
