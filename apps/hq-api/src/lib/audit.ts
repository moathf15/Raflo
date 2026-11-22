import type { Db } from '../db/client';

export type Actor = { type: 'owner' | 'employee' | 'system'; id?: string | null };

/** Append-only record of every owner decision, configuration change and agent side effect. */
export async function audit(db: Db, actor: Actor, action: string, entity: string, entityId: string | null, details: Record<string, unknown> = {}) {
  await db.query('INSERT INTO hq_audit_log (actor_type, actor_id, action, entity, entity_id, details) VALUES ($1, $2, $3, $4, $5, $6)', [
    actor.type,
    actor.id ?? null,
    action,
    entity,
    entityId,
    JSON.stringify(details)
  ]);
}
