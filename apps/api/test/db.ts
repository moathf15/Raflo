import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pgliteDb, postgresDb, type Db } from '../src/db/client';

/**
 * Test database. Default: PGlite in memory.
 * With TEST_DATABASE_URL (a role allowed to CREATE DATABASE), each test file gets a fresh database
 * on a real PostgreSQL server, over TLS when TEST_DATABASE_SSL_CA is set.
 */
export async function testDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return pgliteDb();
  const ca = process.env.TEST_DATABASE_SSL_CA ? readFileSync(process.env.TEST_DATABASE_SSL_CA, 'utf8') : undefined;
  const opts = { ssl: !!ca, sslCa: ca, max: 5, statementTimeoutMs: 10_000 };
  const name = `riflo_test_${randomBytes(4).toString('hex')}`;
  const admin = postgresDb({ connectionString: url, ...opts, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.close();
  const target = new URL(url);
  target.pathname = `/${name}`;
  const db = postgresDb({ connectionString: target.toString(), ...opts });
  return {
    ...db,
    async close() {
      await db.close();
      const cleanup = postgresDb({ connectionString: url, ...opts, max: 1 });
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.close();
    }
  };
}
