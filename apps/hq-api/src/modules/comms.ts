import { z } from 'zod';
import { postMessage } from '../context';
import { audit } from '../lib/audit';
import { HttpError, notFound } from '../lib/http';
import { idParam, type Module } from './core';

export const commsModule: Module = (app, ctx, auth) => {
  app.get('/hq/v1/channels', async (req) => {
    await auth.viewer(req);
    return ctx.db.query(`SELECT c.*, e.avatar AS employee_avatar, e.title AS employee_title,
      (SELECT max(created_at) FROM hq_messages m WHERE m.channel_id = c.id) AS last_at,
      (SELECT count(*)::int FROM hq_messages m WHERE m.channel_id = c.id) AS message_count
      FROM hq_channels c LEFT JOIN hq_employees e ON e.id = c.employee_id
      WHERE e.archived_at IS NULL OR c.employee_id IS NULL
      ORDER BY CASE c.kind WHEN 'announcements' THEN 0 WHEN 'project' THEN 1 WHEN 'department' THEN 2 ELSE 3 END, c.name`);
  });

  app.get('/hq/v1/channels/:id/messages', async (req) => {
    await auth.viewer(req);
    const id = idParam(req.params);
    const rows = await ctx.db.query(
      `SELECT m.*, e.name AS author_name, e.avatar AS author_avatar FROM hq_messages m LEFT JOIN hq_employees e ON m.author_type = 'employee' AND e.id::text = m.author_id
       WHERE m.channel_id = $1 ORDER BY m.created_at DESC LIMIT 200`,
      [id]
    );
    const pending = await ctx.db.query(`SELECT id, status, error FROM hq_chat_queue WHERE channel_id = $1 AND status IN ('queued', 'running')`, [id]);
    return { messages: rows.reverse(), pending };
  });

  /**
   * The owner posts a message. In a direct channel the employee replies (a real model run, queued for the worker);
   * in other channels the message is an announcement that employees see in their context.
   */
  app.post('/hq/v1/channels/:id/messages', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    const b = z.object({ body: z.string().min(1).max(10_000) }).parse(req.body);
    const [c] = await ctx.db.query<{ id: string; kind: string; employee_id: string | null }>('SELECT id, kind, employee_id FROM hq_channels WHERE id = $1', [id]);
    if (!c) throw notFound();
    if (c.kind === 'direct') {
      const [e] = await ctx.db.query<{ active: boolean }>('SELECT active FROM hq_employees WHERE id = $1 AND archived_at IS NULL', [c.employee_id]);
      if (!e?.active) throw new HttpError(409, 'employee_inactive');
      if (!(await ctx.providers.hasAny())) throw new HttpError(409, 'no_provider', 'Configure an AI provider to talk to employees.');
    }
    const m = await postMessage(ctx, id, { type: 'owner', id: o.id }, b.body);
    if (c.kind === 'direct') {
      await ctx.db.query('INSERT INTO hq_chat_queue (channel_id, employee_id, message_id) VALUES ($1, $2, $3)', [id, c.employee_id, m.id]);
      ctx.wake();
    }
    if (c.kind === 'announcements')
      await ctx.db.query(`INSERT INTO hq_knowledge (scope, kind, title, body, source) VALUES ('company', 'objective', $1, $2, $3)`, [
        `Announcement ${new Date().toISOString().slice(0, 10)}`,
        b.body,
        JSON.stringify({ messageId: m.id })
      ]);
    await audit(ctx.db, { type: 'owner', id: o.id }, 'message.post', 'channel', id);
    return { id: m.id };
  });

  app.get('/hq/v1/notifications', async (req) => {
    await auth.viewer(req);
    return ctx.db.query('SELECT * FROM hq_notifications ORDER BY created_at DESC LIMIT 100');
  });
  app.post('/hq/v1/notifications/read', async (req) => {
    await auth.viewer(req);
    const b = z.object({ ids: z.array(z.uuid()).max(200).optional() }).parse(req.body ?? {});
    if (b.ids) await ctx.db.query('UPDATE hq_notifications SET read_at = now() WHERE id = ANY($1::uuid[]) AND read_at IS NULL', [b.ids]);
    else await ctx.db.query('UPDATE hq_notifications SET read_at = now() WHERE read_at IS NULL');
    return { ok: true };
  });

  // Knowledge base
  const KnowledgeInput = z.object({
    title: z.string().min(2).max(200),
    body: z.string().min(1).max(100_000),
    kind: z.enum(['objective', 'documentation', 'decision', 'requirement', 'architecture', 'brand', 'marketing', 'meeting_summary', 'lesson', 'deliverable', 'expertise', 'other']).default('other'),
    scope: z.enum(['company', 'project', 'department', 'employee']).default('company'),
    project_id: z.uuid().nullable().default(null),
    department_id: z.string().max(40).nullable().default(null),
    employee_id: z.uuid().nullable().default(null),
    tags: z.array(z.string().max(40)).max(20).default([]),
    confidential: z.boolean().default(false)
  });
  const scopeOk = (b: Partial<z.infer<typeof KnowledgeInput>>) => {
    if (b.scope === 'project' && !b.project_id) throw new HttpError(400, 'project_required');
    if (b.scope === 'department' && !b.department_id) throw new HttpError(400, 'department_required');
    if (b.scope === 'employee' && !b.employee_id) throw new HttpError(400, 'employee_required');
  };
  app.get('/hq/v1/knowledge', async (req) => {
    await auth.viewer(req);
    const q = z.object({ q: z.string().max(200).optional(), kind: z.string().max(40).optional() }).parse(req.query);
    const { toTsQuery } = await import('../agents/knowledge');
    const tsq = q.q ? toTsQuery(q.q) : null;
    return ctx.db.query(
      `SELECT k.id, k.scope, k.project_id, k.department_id, k.employee_id, k.kind, k.title, left(k.body, 400) AS excerpt, k.tags, k.confidential, k.source, k.created_at, k.updated_at
       FROM hq_knowledge k WHERE ($1::text IS NULL OR k.tsv @@ to_tsquery('simple', $1)) AND ($2::text IS NULL OR k.kind = $2)
       ORDER BY ${tsq ? `ts_rank(k.tsv, to_tsquery('simple', $1)) DESC,` : ''} k.updated_at DESC LIMIT 300`,
      [tsq, q.kind ?? null]
    );
  });
  app.get('/hq/v1/knowledge/:id', async (req) => {
    await auth.viewer(req);
    const [k] = await ctx.db.query('SELECT id, scope, project_id, department_id, employee_id, kind, title, body, tags, confidential, source, created_at, updated_at FROM hq_knowledge WHERE id = $1', [idParam(req.params)]);
    if (!k) throw notFound();
    return k;
  });
  app.post('/hq/v1/knowledge', async (req) => {
    const o = await auth.owner(req);
    const b = KnowledgeInput.parse(req.body);
    scopeOk(b);
    const [k] = await ctx.db.query<{ id: string }>(
      `INSERT INTO hq_knowledge (scope, project_id, department_id, employee_id, kind, title, body, tags, confidential, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [b.scope, b.project_id, b.department_id, b.employee_id, b.kind, b.title, b.body, JSON.stringify(b.tags), b.confidential, JSON.stringify({ ownerId: o.id })]
    );
    await audit(ctx.db, { type: 'owner', id: o.id }, 'knowledge.create', 'knowledge', k.id, { title: b.title });
    return { id: k.id };
  });
  app.patch('/hq/v1/knowledge/:id', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    const b = KnowledgeInput.partial().parse(req.body);
    scopeOk(b);
    const keys = Object.keys(b) as (keyof typeof b)[];
    if (keys.length)
      await ctx.db.query(`UPDATE hq_knowledge SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => (k === 'tags' ? JSON.stringify(b[k]) : b[k]))]);
    await audit(ctx.db, { type: 'owner', id: o.id }, 'knowledge.update', 'knowledge', id, { fields: keys });
    return { ok: true };
  });
  app.delete('/hq/v1/knowledge/:id', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    const [k] = await ctx.db.query<{ title: string }>('DELETE FROM hq_knowledge WHERE id = $1 RETURNING title', [id]);
    if (!k) throw notFound();
    await audit(ctx.db, { type: 'owner', id: o.id }, 'knowledge.delete', 'knowledge', id, { title: k.title });
    return { ok: true };
  });
};
