import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import type { Config } from '../config';

/**
 * Calendar dates (`date`, OID 1082) are returned as 'yyyy-mm-dd' text, never as a JS Date.
 * A Date is built at local midnight, so on a server running in Asia/Riyadh (UTC+3) toISOString() gave the
 * previous day: a trip starting on the 10th was read back as the 9th.
 */
const DATE_OID = 1082;
const keepDateText = (v: string) => v;

/** The only database surface the app uses: parameterised SQL in, rows out. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run a script of several statements (migrations only; no parameters). */
  exec(sql: string): Promise<void>;
  /** Run `fn` in a transaction; rolls back if it throws. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PostgresOptions {
  connectionString: string;
  ssl: boolean;
  /** PEM text of a CA to trust for the database certificate. */
  sslCa?: string;
  max: number;
  statementTimeoutMs: number;
}

/** Production: a real PostgreSQL server, with TLS, bounded pool and query timeouts (audit 3.6, 3.7). */
export function postgresDb(opts: PostgresOptions | string): Db {
  const o: PostgresOptions = typeof opts === 'string' ? { connectionString: opts, ssl: false, max: 10, statementTimeoutMs: 5000 } : opts;
  const pool = new pg.Pool({
    connectionString: o.connectionString,
    // TLS with certificate verification; never `rejectUnauthorized: false`.
    ssl: o.ssl ? { rejectUnauthorized: true, ...(o.sslCa ? { ca: o.sslCa } : {}) } : undefined,
    max: o.max,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    statement_timeout: o.statementTimeoutMs,
    query_timeout: o.statementTimeoutMs + 1000,
    application_name: 'riflo-hq',
    types: { getTypeParser: ((oid: number, format?: 'text' | 'binary') => (oid === DATE_OID ? keepDateText : pg.types.getTypeParser(oid, format as 'text'))) as typeof pg.types.getTypeParser }
  });
  const wrap = (c: pg.Pool | pg.PoolClient): Db => ({
    async query<T>(sql: string, params: unknown[] = []) {
      return (await c.query(sql, params)).rows as T[];
    },
    async exec(sql) {
      await c.query(sql);
    },
    async tx(fn) {
      if (c !== pool) return fn(wrap(c));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  });
  return wrap(pool);
}

/** Development and tests: PostgreSQL in-process (WASM). `dataDir` undefined = in memory. */
export async function pgliteDb(dataDir?: string): Promise<Db> {
  const pgl = await PGlite.create(dataDir);
  const wrap = (c: Pick<PGlite, 'query' | 'exec'>, inTx: boolean): Db => ({
    async query<T>(sql: string, params: unknown[] = []) {
      return (await c.query<T>(sql, params, { parsers: { [DATE_OID]: keepDateText } })).rows;
    },
    async exec(sql) {
      await c.exec(sql);
    },
    async tx(fn) {
      if (inTx) return fn(wrap(c, true));
      return (await pgl.transaction((t) => fn(wrap(t, true)))) as Awaited<ReturnType<typeof fn>>;
    },
    close: () => pgl.close()
  });
  return wrap(pgl, false);
}

/**
 * The database for this process, from the configuration: PostgreSQL when a URL is given (TLS settings from
 * DATABASE_SSL / DATABASE_SSL_CA), otherwise PGlite in `pgliteDir` (undefined = in memory).
 */
export async function openDb(cfg: Config, opts: { url: string | undefined; max: number; statementTimeoutMs: number; pgliteDir?: string }): Promise<Db> {
  if (!opts.url) return pgliteDb(opts.pgliteDir);
  const sslCa = cfg.DATABASE_SSL_CA ? readFileSync(cfg.DATABASE_SSL_CA, 'utf8') : undefined;
  return postgresDb({ connectionString: opts.url, ssl: cfg.DATABASE_SSL, sslCa, max: opts.max, statementTimeoutMs: opts.statementTimeoutMs });
}
