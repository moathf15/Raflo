import { z } from 'zod';
import { setEmployeeStatus } from '../context';
import { TOOL_PERMISSIONS } from '../db/org';
import { audit } from '../lib/audit';
import { HttpError, notFound } from '../lib/http';
import { idParam, type Module } from './core';

const EMPLOYEE_COLUMNS = `e.id, e.slug, e.name, e.title, e.title_ar, e.department_id, e.manager_id, e.avatar, e.personality, e.skills, e.responsibilities, e.tools,
  e.instructions, e.role_memory, e.provider_id, e.model_override, e.active, e.status, e.status_detail, e.status_since, e.current_task_id, e.current_meeting_id, e.sort, e.created_at, e.archived_at`;

const EmployeeInput = z.object({
  name: z.string().min(2).max(80),
  title: z.string().min(2).max(80),
  title_ar: z.string().max(80).default(''),
  department_id: z.string().min(1).max(40),
  manager_id: z.uuid().nullable().default(null),
  personality: z.string().max(2000).default(''),
  skills: z.array(z.string().min(1).max(60)).max(30).default([]),
  responsibilities: z.array(z.string().min(1).max(200)).max(30).default([]),
  tools: z.array(z.enum(TOOL_PERMISSIONS)).max(TOOL_PERMISSIONS.length).default(['knowledge.read', 'comms.send']),
  instructions: z.string().max(8000).default(''),
  role_memory: z.string().max(20_000).default(''),
  provider_id: z.uuid().nullable().default(null),
  model_override: z.string().max(100).nullable().default(null),
  active: z.boolean().default(true),
  avatar: z.object({ skin: z.string().regex(/^#[0-9a-f]{6}$/i), hair: z.string().regex(/^#[0-9a-f]{6}$/i), style: z.enum(['short', 'long', 'bun', 'curly', 'hijab', 'bald', 'shemagh']), outfit: z.string().regex(/^#[0-9a-f]{6}$/i) }).optional()
});

/** Performance from stored outcomes. Quality signals (acceptance, reviews, owner ratings) rank above volume. */
export const PERFORMANCE_SQL = `
  SELECT e.id,
    count(DISTINCT t.id) FILTER (WHERE t.status = 'completed' AND t.assignee_id = e.id)::int AS completed,
    count(DISTINCT t.id) FILTER (WHERE t.assignee_id = e.id AND t.status NOT IN ('completed', 'cancelled', 'rejected'))::int AS open,
    count(DISTINCT t.id) FILTER (WHERE t.assignee_id = e.id AND t.status IN ('completed', 'blocked', 'rejected'))::int AS finished_or_failed,
    (SELECT count(*)::int FROM hq_deliverables d WHERE d.employee_id = e.id AND d.review_status = 'accepted') AS accepted,
    (SELECT count(*)::int FROM hq_deliverables d WHERE d.employee_id = e.id AND d.review_status IN ('rejected', 'changes_requested')) AS rejected,
    (SELECT round(avg(d.owner_rating)::numeric, 2) FROM hq_deliverables d WHERE d.employee_id = e.id AND d.owner_rating IS NOT NULL) AS avg_rating,
    (SELECT count(*)::int FROM hq_reviews r JOIN hq_tasks rt ON rt.id = r.task_id WHERE rt.assignee_id = e.id AND r.verdict = 'approved') AS reviews_passed,
    (SELECT count(*)::int FROM hq_reviews r JOIN hq_tasks rt ON rt.id = r.task_id WHERE rt.assignee_id = e.id) AS reviews_total,
    (SELECT count(*)::int FROM hq_runs r WHERE r.employee_id = e.id AND r.status = 'failed') AS failed_runs,
    (SELECT count(*)::int FROM hq_runs r WHERE r.employee_id = e.id) AS runs,
    (SELECT coalesce(sum(r.cost_usd), 0)::float FROM hq_runs r WHERE r.employee_id = e.id) AS cost_usd,
    (SELECT coalesce(sum(r.input_tokens + r.output_tokens + r.cache_read_tokens), 0)::bigint FROM hq_runs r WHERE r.employee_id = e.id) AS tokens,
    (SELECT round(avg(extract(epoch FROM (r.finished_at - r.started_at)))::numeric, 1) FROM hq_runs r WHERE r.employee_id = e.id AND r.kind = 'task' AND r.status = 'succeeded') AS avg_run_seconds
  FROM hq_employees e
  LEFT JOIN hq_tasks t ON t.assignee_id = e.id
  WHERE e.archived_at IS NULL
  GROUP BY e.id`;

export const orgModule: Module = (app, ctx, auth) => {
  app.get('/hq/v1/departments', async (req) => {
    await auth.viewer(req);
    return ctx.db.query('SELECT * FROM hq_departments ORDER BY sort');
  });

  app.get('/hq/v1/employees', async (req) => {
    await auth.viewer(req);
    const { archived } = z.object({ archived: z.enum(['true', 'false']).default('false') }).parse(req.query);
    return ctx.db.query(
      `SELECT ${EMPLOYEE_COLUMNS}, t.title AS current_task_title, m.title AS current_meeting_title, m.room AS current_meeting_room
       FROM hq_employees e LEFT JOIN hq_tasks t ON t.id = e.current_task_id LEFT JOIN hq_meetings m ON m.id = e.current_meeting_id
       WHERE ${archived === 'true' ? 'e.archived_at IS NOT NULL' : 'e.archived_at IS NULL'} ORDER BY e.sort, e.created_at`
    );
  });

  app.get('/hq/v1/employees/:id', async (req) => {
    await auth.viewer(req);
    const id = idParam(req.params);
    const [e] = await ctx.db.query(`SELECT ${EMPLOYEE_COLUMNS} FROM hq_employees e WHERE e.id = $1`, [id]);
    if (!e) throw notFound();
    const [perf] = await ctx.db.query(`SELECT * FROM (${PERFORMANCE_SQL}) p WHERE p.id = $1`, [id]);
    const tasks = await ctx.db.query(
      `SELECT t.id, t.title, t.status, t.priority, t.deadline, t.project_id, p.name AS project_name, t.updated_at, t.completed_at,
              (t.reviewer_id = $1::uuid AND t.assignee_id <> $1::uuid) AS as_reviewer
       FROM hq_tasks t LEFT JOIN hq_projects p ON p.id = t.project_id WHERE t.assignee_id = $1 OR t.reviewer_id = $1 ORDER BY t.updated_at DESC LIMIT 100`,
      [id]
    );
    const deliverables = await ctx.db.query(
      `SELECT d.id, d.task_id, t.title AS task_title, d.version, d.summary, d.review_status, d.owner_rating, d.created_at
       FROM hq_deliverables d JOIN hq_tasks t ON t.id = d.task_id WHERE d.employee_id = $1 ORDER BY d.created_at DESC LIMIT 20`,
      [id]
    );
    const runs = await ctx.db.query(
      `SELECT id, kind, task_id, meeting_id, status, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, error, started_at, finished_at FROM hq_runs WHERE employee_id = $1 ORDER BY started_at DESC LIMIT 30`,
      [id]
    );
    const [dm] = await ctx.db.query<{ id: string }>(`SELECT id FROM hq_channels WHERE kind = 'direct' AND employee_id = $1`, [id]);
    const messages = await ctx.db.query(
      `SELECT m.*, c.kind AS channel_kind, c.name AS channel_name FROM hq_messages m JOIN hq_channels c ON c.id = m.channel_id
       WHERE (m.author_type = 'employee' AND m.author_id = $1::text) OR m.data->>'to' = $1::text OR c.employee_id = $1::uuid ORDER BY m.created_at DESC LIMIT 30`,
      [id]
    );
    const meetings = await ctx.db.query(
      `SELECT m.id, m.title, m.status, m.created_at FROM hq_meetings m JOIN hq_meeting_participants p ON p.meeting_id = m.id WHERE p.employee_id = $1 ORDER BY m.created_at DESC LIMIT 10`,
      [id]
    );
    const knowledge = await ctx.db.query(
      `SELECT id, title, kind, scope, updated_at FROM hq_knowledge WHERE employee_id = $1::uuid OR source->>'employeeId' = $1::text ORDER BY updated_at DESC LIMIT 20`,
      [id]
    );
    const projects = await ctx.db.query(
      `SELECT DISTINCT p.id, p.name FROM hq_projects p JOIN hq_tasks t ON t.project_id = p.id WHERE t.assignee_id = $1 OR t.reviewer_id = $1`,
      [id]
    );
    return { employee: e, performance: perf ?? null, tasks, deliverables, runs, messages, meetings, knowledge, projects, directChannelId: dm?.id ?? null };
  });

  app.post('/hq/v1/employees', async (req) => {
    const o = await auth.owner(req);
    const b = EmployeeInput.parse(req.body);
    const slugBase = b.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'employee';
    const [{ n }] = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM hq_employees WHERE slug LIKE $1', [`${slugBase}%`]);
    const slug = n ? `${slugBase}-${n + 1}` : slugBase;
    const avatar = b.avatar ?? { skin: '#c68863', hair: '#1f1a17', style: 'short', outfit: '#546e7a' };
    const [e] = await ctx.db.query<{ id: string }>(
      `INSERT INTO hq_employees (slug, name, title, title_ar, department_id, manager_id, avatar, personality, skills, responsibilities, tools, instructions, role_memory, provider_id, model_override, active, sort)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, (SELECT coalesce(max(sort), 0) + 1 FROM hq_employees)) RETURNING id`,
      [slug, b.name, b.title, b.title_ar, b.department_id, b.manager_id, JSON.stringify(avatar), b.personality, JSON.stringify(b.skills), JSON.stringify(b.responsibilities), JSON.stringify(b.tools), b.instructions, b.role_memory, b.provider_id, b.model_override, b.active]
    );
    await ctx.db.query(`INSERT INTO hq_channels (kind, name, employee_id) VALUES ('direct', $1, $2)`, [b.name, e.id]);
    await audit(ctx.db, { type: 'owner', id: o.id }, 'employee.create', 'employee', e.id, { name: b.name, title: b.title });
    ctx.bus.emit({ type: 'employees.changed' });
    return { id: e.id, slug };
  });

  app.patch('/hq/v1/employees/:id', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    const b = EmployeeInput.partial().parse(req.body);
    if (b.manager_id === id) throw new HttpError(400, 'invalid_manager');
    const [before] = await ctx.db.query('SELECT name, title, tools, active, instructions, responsibilities, provider_id, model_override FROM hq_employees WHERE id = $1', [id]);
    if (!before) throw notFound();
    const keys = Object.keys(b) as (keyof typeof b)[];
    if (!keys.length) return { ok: true };
    const json = new Set(['skills', 'responsibilities', 'tools', 'avatar']);
    await ctx.db.query(
      `UPDATE hq_employees SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`,
      [id, ...keys.map((k) => (json.has(k) ? JSON.stringify(b[k]) : b[k]))]
    );
    await audit(ctx.db, { type: 'owner', id: o.id }, 'employee.update', 'employee', id, { before, changes: b });
    ctx.bus.emit({ type: 'employees.changed' });
    return { ok: true };
  });

  /** Archive (soft delete): history, deliverables and metrics are kept. Open tasks return to the backlog. */
  app.delete('/hq/v1/employees/:id', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    await ctx.db.tx(async (t) => {
      await t.query(`UPDATE hq_employees SET archived_at = now(), active = false, status = 'idle', current_task_id = NULL WHERE id = $1`, [id]);
      await t.query(`UPDATE hq_tasks SET assignee_id = NULL, status = 'backlog', queue = NULL WHERE assignee_id = $1 AND status NOT IN ('completed', 'cancelled', 'rejected')`, [id]);
      await t.query(`UPDATE hq_tasks SET reviewer_id = NULL WHERE reviewer_id = $1 AND status NOT IN ('completed', 'cancelled', 'rejected')`, [id]);
    });
    await audit(ctx.db, { type: 'owner', id: o.id }, 'employee.archive', 'employee', id);
    ctx.bus.emit({ type: 'employees.changed' });
    return { ok: true };
  });

  app.post('/hq/v1/employees/:id/restore', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    await ctx.db.query('UPDATE hq_employees SET archived_at = NULL, active = true WHERE id = $1', [id]);
    await setEmployeeStatus(ctx, id, 'idle');
    await audit(ctx.db, { type: 'owner', id: o.id }, 'employee.restore', 'employee', id);
    ctx.bus.emit({ type: 'employees.changed' });
    return { ok: true };
  });

  app.get('/hq/v1/performance', async (req) => {
    await auth.viewer(req);
    return ctx.db.query(`SELECT p.*, e.name, e.title, e.department_id FROM (${PERFORMANCE_SQL}) p JOIN hq_employees e ON e.id = p.id ORDER BY e.sort`);
  });

  app.get('/hq/v1/runs/:id', async (req) => {
    await auth.viewer(req);
    const [r] = await ctx.db.query('SELECT * FROM hq_runs WHERE id = $1', [idParam(req.params)]);
    if (!r) throw notFound();
    return r;
  });

  app.get('/hq/v1/tool-permissions', async (req) => {
    await auth.viewer(req);
    return TOOL_PERMISSIONS;
  });
};
