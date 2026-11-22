import { z } from 'zod';
import { emitTask, settleEmployee, taskComment } from '../context';
import { audit } from '../lib/audit';
import { HttpError, notFound } from '../lib/http';
import { executeApproval } from './approvals';
import { idParam, type Module } from './core';

const Priority = z.enum(['low', 'normal', 'high', 'urgent']);

const TaskInput = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(20_000).default(''),
  acceptance_criteria: z.string().max(5000).default(''),
  project_id: z.uuid().nullable().default(null),
  assignee_id: z.uuid().nullable().default(null),
  reviewer_id: z.uuid().nullable().default(null),
  priority: Priority.default('normal'),
  deadline: z.iso.date().nullable().default(null),
  depends_on: z.array(z.uuid()).max(20).default([]),
  start: z.boolean().default(true)
});

const TASK_LIST = `SELECT t.*, a.name AS assignee_name, a.avatar AS assignee_avatar, r.name AS reviewer_name, p.name AS project_name,
  (SELECT count(*)::int FROM hq_task_deps d JOIN hq_tasks dt ON dt.id = d.depends_on_id WHERE d.task_id = t.id AND dt.status <> 'completed') AS open_deps,
  (SELECT array_agg(depends_on_id) FROM hq_task_deps d WHERE d.task_id = t.id) AS depends_on
  FROM hq_tasks t LEFT JOIN hq_employees a ON a.id = t.assignee_id LEFT JOIN hq_employees r ON r.id = t.reviewer_id LEFT JOIN hq_projects p ON p.id = t.project_id`;

export const tasksModule: Module = (app, ctx, auth) => {
  app.get('/hq/v1/tasks', async (req) => {
    await auth.viewer(req);
    const q = z
      .object({ project_id: z.uuid().optional(), assignee_id: z.uuid().optional(), status: z.string().max(40).optional(), parent_id: z.uuid().optional(), top: z.enum(['true', 'false']).optional() })
      .parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.project_id) add('t.project_id = ?', q.project_id);
    if (q.assignee_id) add('t.assignee_id = ?', q.assignee_id);
    if (q.status) add('t.status = ?', q.status);
    if (q.parent_id) add('t.parent_id = ?', q.parent_id);
    if (q.top === 'true') where.push('t.parent_id IS NULL');
    return ctx.db.query(`${TASK_LIST} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.created_at DESC LIMIT 500`, params);
  });

  app.post('/hq/v1/tasks', async (req) => {
    const o = await auth.owner(req);
    const b = TaskInput.parse(req.body);
    if (b.reviewer_id && b.reviewer_id === b.assignee_id) throw new HttpError(400, 'reviewer_must_differ');
    const run = b.start && b.assignee_id;
    const [t] = await ctx.db.tx(async (tx) => {
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO hq_tasks (project_id, title, description, acceptance_criteria, status, queue, priority, assignee_id, reviewer_id, deadline, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'owner') RETURNING id`,
        [b.project_id, b.title, b.description, b.acceptance_criteria, b.assignee_id ? 'assigned' : 'backlog', run ? 'execute' : null, b.priority, b.assignee_id, b.reviewer_id, b.deadline]
      );
      for (const d of b.depends_on) await tx.query('INSERT INTO hq_task_deps (task_id, depends_on_id) VALUES ($1, $2)', [rows[0].id, d]);
      return rows;
    });
    await audit(ctx.db, { type: 'owner', id: o.id }, 'task.create', 'task', t.id, { title: b.title, assignee: b.assignee_id });
    await emitTask(ctx, t.id);
    ctx.wake();
    return { id: t.id };
  });

  /** A natural-language objective for the Chief of Staff, who plans and delegates it. */
  app.post('/hq/v1/objectives', async (req) => {
    const o = await auth.owner(req);
    const b = z.object({ objective: z.string().min(10).max(10_000), title: z.string().max(200).optional(), project_id: z.uuid().nullable().default(null), priority: Priority.default('normal'), deadline: z.iso.date().nullable().default(null) }).parse(req.body);
    const [cos] = await ctx.db.query<{ id: string }>(`SELECT id FROM hq_employees WHERE slug = 'chief-of-staff' AND active AND archived_at IS NULL`);
    if (!cos) throw new HttpError(409, 'no_chief_of_staff', 'The Chief of Staff is not active.');
    const title = b.title || (b.objective.length > 100 ? `${b.objective.slice(0, 97)}…` : b.objective);
    const [t] = await ctx.db.query<{ id: string }>(
      `INSERT INTO hq_tasks (project_id, kind, title, description, status, queue, priority, assignee_id, deadline, created_by) VALUES ($1, 'plan', $2, $3, 'assigned', 'plan', $4, $5, $6, 'owner') RETURNING id`,
      [b.project_id, title, b.objective, b.priority, cos.id, b.deadline]
    );
    await audit(ctx.db, { type: 'owner', id: o.id }, 'objective.create', 'task', t.id, { title });
    await emitTask(ctx, t.id);
    ctx.wake();
    return { id: t.id };
  });

  app.get('/hq/v1/tasks/:id', async (req) => {
    await auth.viewer(req);
    const id = idParam(req.params);
    const [task] = await ctx.db.query(`${TASK_LIST} WHERE t.id = $1`, [id]);
    if (!task) throw notFound();
    const [children, deps, dependents, comments, attachments, deliverables, reviews, runs, approvals, proposals] = await Promise.all([
      ctx.db.query(`${TASK_LIST} WHERE t.parent_id = $1 ORDER BY t.created_at`, [id]),
      ctx.db.query(`SELECT t.id, t.title, t.status FROM hq_task_deps d JOIN hq_tasks t ON t.id = d.depends_on_id WHERE d.task_id = $1`, [id]),
      ctx.db.query(`SELECT t.id, t.title, t.status FROM hq_task_deps d JOIN hq_tasks t ON t.id = d.task_id WHERE d.depends_on_id = $1`, [id]),
      ctx.db.query(`SELECT c.*, e.name AS author_name FROM hq_task_comments c LEFT JOIN hq_employees e ON e.id::text = c.author_id WHERE c.task_id = $1 ORDER BY c.created_at`, [id]),
      ctx.db.query(`SELECT id, name, mime, length(content) AS size, created_at FROM hq_task_attachments WHERE task_id = $1 ORDER BY created_at`, [id]),
      ctx.db.query(`SELECT d.*, e.name AS employee_name FROM hq_deliverables d LEFT JOIN hq_employees e ON e.id = d.employee_id WHERE d.task_id = $1 ORDER BY d.version DESC`, [id]),
      ctx.db.query(`SELECT r.*, e.name AS reviewer_name FROM hq_reviews r LEFT JOIN hq_employees e ON e.id::text = r.reviewer_id WHERE r.task_id = $1 ORDER BY r.created_at DESC`, [id]),
      ctx.db.query(`SELECT r.id, r.kind, r.status, r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cost_usd, r.error, r.started_at, r.finished_at, r.model_calls, e.name AS employee_name FROM hq_runs r LEFT JOIN hq_employees e ON e.id = r.employee_id WHERE r.task_id = $1 ORDER BY r.started_at DESC`, [id]),
      ctx.db.query(`SELECT * FROM hq_approvals WHERE task_id = $1 ORDER BY created_at DESC`, [id]),
      ctx.db.query(`SELECT id, repo, title, status, branch, pr_url, created_at FROM hq_change_proposals WHERE task_id = $1 ORDER BY created_at DESC`, [id])
    ]);
    return { task, children, deps, dependents, comments, attachments, deliverables, reviews, runs, approvals, proposals };
  });

  /** Edit a task: reassign, change priority/deadline/reviewer, start, cancel. */
  app.patch('/hq/v1/tasks/:id', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    const b = z
      .object({
        title: z.string().min(3).max(200).optional(),
        description: z.string().max(20_000).optional(),
        acceptance_criteria: z.string().max(5000).optional(),
        assignee_id: z.uuid().nullable().optional(),
        reviewer_id: z.uuid().nullable().optional(),
        priority: Priority.optional(),
        deadline: z.iso.date().nullable().optional(),
        project_id: z.uuid().nullable().optional(),
        action: z.enum(['start', 'cancel', 'retry', 'backlog']).optional()
      })
      .parse(req.body);
    const [t] = await ctx.db.query<{ id: string; status: string; assignee_id: string | null; reviewer_id: string | null; kind: string; title: string }>('SELECT * FROM hq_tasks WHERE id = $1', [id]);
    if (!t) throw notFound();
    const { action, ...fields } = b;
    const sets: Record<string, unknown> = { ...fields };
    const assignee = fields.assignee_id !== undefined ? fields.assignee_id : t.assignee_id;
    const reviewer = fields.reviewer_id !== undefined ? fields.reviewer_id : t.reviewer_id;
    if (assignee && reviewer && assignee === reviewer) throw new HttpError(400, 'reviewer_must_differ');
    if (fields.assignee_id !== undefined && t.status === 'in_progress') throw new HttpError(409, 'task_running', 'Wait for the current run to finish before reassigning.');
    if (fields.assignee_id === null) Object.assign(sets, { status: 'backlog', queue: null });
    if (action === 'cancel') {
      if (['completed', 'cancelled'].includes(t.status)) throw new HttpError(409, 'invalid_state');
      Object.assign(sets, { status: 'cancelled', queue: null, lease_until: null });
    }
    if (action === 'start' || action === 'retry') {
      if (!assignee) throw new HttpError(400, 'no_assignee');
      if (['completed', 'cancelled', 'in_progress'].includes(t.status)) throw new HttpError(409, 'invalid_state');
      Object.assign(sets, { status: 'assigned', queue: t.kind === 'plan' ? 'plan' : 'execute', lease_until: null, attempts: 0, blocked_reason: null });
    }
    if (action === 'backlog') Object.assign(sets, { status: 'backlog', queue: null, lease_until: null });
    const keys = Object.keys(sets);
    if (keys.length) await ctx.db.query(`UPDATE hq_tasks SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => sets[k])]);
    if (action === 'cancel') {
      await ctx.db.query(`UPDATE hq_tasks SET status = 'cancelled', queue = NULL WHERE parent_id = $1 AND status NOT IN ('completed', 'cancelled')`, [id]);
      if (t.assignee_id) await settleEmployee(ctx, t.assignee_id);
    }
    await audit(ctx.db, { type: 'owner', id: o.id }, `task.${action ?? 'update'}`, 'task', id, b);
    await emitTask(ctx, id);
    ctx.bus.emit({ type: 'tasks.changed' });
    ctx.wake();
    return { ok: true };
  });

  app.post('/hq/v1/tasks/:id/comments', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    const b = z.object({ body: z.string().min(1).max(10_000) }).parse(req.body);
    await taskComment(ctx, id, { type: 'owner', id: o.id }, b.body);
    return { ok: true };
  });

  app.post('/hq/v1/tasks/:id/attachments', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    const b = z.object({ name: z.string().min(1).max(200), mime: z.string().max(100).default('text/plain'), content: z.string().min(1).max(50_000) }).parse(req.body);
    if (!/^(text\/|application\/(json|xml|csv))/.test(b.mime)) throw new HttpError(400, 'text_only', 'Only text attachments are supported.');
    await ctx.db.query('INSERT INTO hq_task_attachments (task_id, name, mime, content) VALUES ($1, $2, $3, $4)', [id, b.name, b.mime, b.content]);
    await audit(ctx.db, { type: 'owner', id: o.id }, 'task.attachment', 'task', id, { name: b.name });
    return { ok: true };
  });

  app.get('/hq/v1/attachments/:id', async (req) => {
    await auth.viewer(req);
    const [a] = await ctx.db.query('SELECT * FROM hq_task_attachments WHERE id = $1', [idParam(req.params)]);
    if (!a) throw notFound();
    return a;
  });

  /** Owner review of a deliverable: accept (with rating), request changes (re-runs with feedback) or reject. */
  app.post('/hq/v1/deliverables/:id/review', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    const b = z.object({ verdict: z.enum(['accept', 'changes', 'reject']), rating: z.number().int().min(1).max(5).optional(), feedback: z.string().max(10_000).default('') }).parse(req.body);
    const [d] = await ctx.db.query<{ id: string; task_id: string; employee_id: string | null }>('SELECT id, task_id, employee_id FROM hq_deliverables WHERE id = $1', [id]);
    if (!d) throw notFound();
    const [t] = await ctx.db.query<{ status: string; revision: number; kind: string; assignee_id: string | null }>('SELECT status, revision, kind, assignee_id FROM hq_tasks WHERE id = $1', [d.task_id]);
    const status = b.verdict === 'accept' ? 'accepted' : b.verdict === 'changes' ? 'changes_requested' : 'rejected';
    await ctx.db.query('UPDATE hq_deliverables SET review_status = $2, owner_rating = coalesce($3, owner_rating), owner_feedback = $4 WHERE id = $1', [id, status, b.rating ?? null, b.feedback || null]);
    await ctx.db.query(`INSERT INTO hq_reviews (task_id, deliverable_id, reviewer_type, reviewer_id, verdict, summary) VALUES ($1, $2, 'owner', $3, $4, $5)`, [
      d.task_id,
      id,
      o.id,
      b.verdict === 'accept' ? 'approved' : b.verdict === 'changes' ? 'changes_requested' : 'rejected',
      b.feedback
    ]);
    if (b.verdict === 'changes') {
      if (!t.assignee_id) throw new HttpError(400, 'no_assignee');
      await ctx.db.query(`UPDATE hq_tasks SET status = 'assigned', queue = 'execute', revision = revision + 1, attempts = 0, completed_at = NULL, lease_until = NULL, updated_at = now() WHERE id = $1`, [d.task_id]);
    } else if (b.verdict === 'reject') {
      await ctx.db.query(`UPDATE hq_tasks SET status = 'rejected', queue = NULL, updated_at = now() WHERE id = $1`, [d.task_id]);
    }
    await audit(ctx.db, { type: 'owner', id: o.id }, `deliverable.${b.verdict}`, 'deliverable', id, { rating: b.rating });
    await emitTask(ctx, d.task_id);
    ctx.wake();
    return { ok: true };
  });

  /** The owner answers a decision an employee asked for; the task resumes with the answer in its context. */
  app.post('/hq/v1/tasks/:id/answer', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    const b = z.object({ answer: z.string().min(1).max(10_000) }).parse(req.body);
    const [t] = await ctx.db.query<{ status: string; kind: string; assignee_id: string | null }>('SELECT status, kind, assignee_id FROM hq_tasks WHERE id = $1', [id]);
    if (!t) throw notFound();
    if (t.status !== 'waiting_approval' && t.status !== 'blocked') throw new HttpError(409, 'invalid_state');
    await taskComment(ctx, id, { type: 'owner', id: o.id }, `Owner's answer: ${b.answer}`);
    await ctx.db.query(`UPDATE hq_approvals SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3 WHERE task_id = $1 AND kind = 'owner_decision' AND status = 'pending'`, [id, o.id, b.answer]);
    await ctx.db.query(
      `UPDATE hq_tasks SET status = 'assigned', queue = $2, owner_question = NULL, blocked_reason = NULL, attempts = 0, revision = revision + 1, lease_until = NULL, updated_at = now() WHERE id = $1`,
      [id, t.kind === 'plan' ? 'plan' : 'execute']
    );
    await audit(ctx.db, { type: 'owner', id: o.id }, 'task.answer', 'task', id);
    await emitTask(ctx, id);
    ctx.wake();
    return { ok: true };
  });

  app.post('/hq/v1/tasks/:id/deps', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    const b = z.object({ depends_on: z.uuid(), remove: z.boolean().default(false) }).parse(req.body);
    if (b.remove) await ctx.db.query('DELETE FROM hq_task_deps WHERE task_id = $1 AND depends_on_id = $2', [id, b.depends_on]);
    else {
      // Refuse a dependency that would create a cycle.
      const [cycle] = await ctx.db.query(
        `WITH RECURSIVE up(id) AS (SELECT $2::uuid UNION SELECT d.depends_on_id FROM hq_task_deps d JOIN up ON d.task_id = up.id) SELECT 1 FROM up WHERE id = $1`,
        [id, b.depends_on]
      );
      if (cycle) throw new HttpError(400, 'dependency_cycle');
      await ctx.db.query('INSERT INTO hq_task_deps (task_id, depends_on_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, b.depends_on]);
    }
    await audit(ctx.db, { type: 'owner', id: o.id }, 'task.deps', 'task', id, b);
    ctx.wake();
    return { ok: true };
  });

  // Projects
  app.get('/hq/v1/projects', async (req) => {
    await auth.viewer(req);
    return ctx.db.query(`SELECT p.*,
      (SELECT count(*)::int FROM hq_tasks t WHERE t.project_id = p.id) AS tasks,
      (SELECT count(*)::int FROM hq_tasks t WHERE t.project_id = p.id AND t.status = 'completed') AS completed,
      (SELECT count(*)::int FROM hq_tasks t WHERE t.project_id = p.id AND t.status = 'blocked') AS blocked
      FROM hq_projects p ORDER BY p.created_at DESC`);
  });
  const ProjectInput = z.object({ name: z.string().min(2).max(120), description: z.string().max(10_000).default(''), status: z.enum(['active', 'paused', 'completed', 'archived']).default('active'), repo: z.string().max(201).nullable().default(null) });
  app.post('/hq/v1/projects', async (req) => {
    const o = await auth.owner(req);
    const b = ProjectInput.parse(req.body);
    const [p] = await ctx.db.query<{ id: string }>('INSERT INTO hq_projects (name, description, status, repo) VALUES ($1, $2, $3, $4) RETURNING id', [b.name, b.description, b.status, b.repo]);
    await ctx.db.query(`INSERT INTO hq_channels (kind, name, project_id) VALUES ('project', $1, $2)`, [b.name, p.id]);
    await audit(ctx.db, { type: 'owner', id: o.id }, 'project.create', 'project', p.id, b);
    return { id: p.id };
  });
  app.patch('/hq/v1/projects/:id', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    const b = ProjectInput.partial().parse(req.body);
    const keys = Object.keys(b) as (keyof typeof b)[];
    if (keys.length) await ctx.db.query(`UPDATE hq_projects SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => b[k])]);
    await audit(ctx.db, { type: 'owner', id: o.id }, 'project.update', 'project', id, b);
    ctx.wake();
    return { ok: true };
  });

  // Approvals
  app.get('/hq/v1/approvals', async (req) => {
    await auth.viewer(req);
    const { status } = z.object({ status: z.enum(['pending', 'all']).default('pending') }).parse(req.query);
    return ctx.db.query(
      `SELECT a.*, e.name AS employee_name, t.title AS task_title FROM hq_approvals a LEFT JOIN hq_employees e ON e.id = a.employee_id LEFT JOIN hq_tasks t ON t.id = a.task_id
       ${status === 'pending' ? `WHERE a.status = 'pending'` : ''} ORDER BY a.created_at DESC LIMIT 200`
    );
  });

  app.post('/hq/v1/approvals/:id', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    const b = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(5000).default('') }).parse(req.body);
    const [a] = await ctx.db.query<{ id: string; kind: string; status: string; payload: Record<string, unknown>; task_id: string | null; employee_id: string | null; title: string }>('SELECT * FROM hq_approvals WHERE id = $1', [id]);
    if (!a) throw notFound();
    if (a.status !== 'pending') throw new HttpError(409, 'already_decided');
    if (a.kind === 'owner_decision') throw new HttpError(400, 'answer_on_task', 'Answer this from the task.');
    const decide = (status: string, result: unknown = null) =>
      ctx.db.query('UPDATE hq_approvals SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, result = $5 WHERE id = $1', [id, status, o.id, b.note || null, result ? JSON.stringify(result) : null]);
    if (b.decision === 'reject') {
      await decide('rejected');
      await executeApproval.reject(ctx, a, o.id, b.note);
    } else {
      try {
        const result = await executeApproval.approve(ctx, a, o.id);
        await decide(result.executed ? 'executed' : 'approved', result);
      } catch (e) {
        await decide('failed', { error: (e as Error).message });
        throw e instanceof HttpError ? e : new HttpError(502, 'execution_failed', (e as Error).message);
      }
    }
    await audit(ctx.db, { type: 'owner', id: o.id }, `approval.${b.decision}`, 'approval', id, { kind: a.kind, title: a.title, note: b.note });
    if (a.employee_id) await settleEmployee(ctx, a.employee_id);
    ctx.bus.emit({ type: 'approvals.changed' });
    return { ok: true };
  });
};
