import type { FastifyInstance } from 'fastify';
import type { Sessions } from './auth/session';
import type { Config } from './config';
import type { Db } from './db/client';
import type { Mailer } from './lib/email';
import { HttpError } from './lib/http';

export interface Ctx {
  db: Db;
  sessions: Sessions;
  cfg: Config;
  mailer: Mailer;
}

export type Module = (app: FastifyInstance, ctx: Ctx) => void;

/**
 * Record an admin/editor change with its before and after values (price and hours history, audit 5.5).
 * Always call it with the same transaction as the change, so neither can happen without the other (audit 6.4).
 */
export async function audit(tx: Db, actorId: string, action: string, entity: string, entityId: string, changes: unknown = {}) {
  await tx.query('INSERT INTO audit_log (actor_id, action, entity, entity_id, changes) VALUES ($1, $2, $3, $4, $5)', [actorId, action, entity, entityId, JSON.stringify(changes)]);
}

/** Record a product analytics event. Never fails the request it belongs to. */
export async function track(db: Db, name: string, userId: string | null, props: Record<string, unknown> = {}, anonymousId: string | null = null, sessionId: string | null = null) {
  try {
    await db.query('INSERT INTO events (name, user_id, anonymous_id, props, session_id) VALUES ($1, $2, $3, $4, $5)', [name, userId, anonymousId, JSON.stringify(props), sessionId]);
  } catch {
    /* analytics must not break the product */
  }
}

/** Per-account quotas, counted in the database so they hold across API instances (audit 3.6). */
export const QUOTAS = {
  tripsPerDay: 30,
  tripsTotal: 200,
  visitsPerDay: 50,
  wishlistTotal: 300,
  eventsPerDay: 300
} as const;

/**
 * Transaction-scoped lock on a key (released at commit or rollback). Requests for the same key run one after
 * another, so a count-then-insert inside the same transaction cannot be raced (review 3: quota race).
 */
export async function lockKey(t: Db, key: string) {
  await t.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

/**
 * Check a quota and do the write atomically: inside one transaction, take the lock for `key`, count, refuse if
 * the limit is reached, then run `write` with the same transaction. Concurrent requests for the same key queue
 * on the lock, so they cannot all read the same count and overshoot.
 */
export async function withQuota<T>(db: Db, key: string, checks: { sql: string; params: unknown[]; max: number; code: string }[], write: (t: Db) => Promise<T>): Promise<T> {
  return db.tx(async (t) => {
    await lockKey(t, key);
    for (const c of checks) {
      const [row] = await t.query<{ n: number }>(c.sql, c.params);
      if (row.n >= c.max) throw new HttpError(429, c.code, c.code, { limit: c.max });
    }
    return write(t);
  });
}
