import { z } from 'zod';
import { spend } from '../agents/runner';
import { audit } from '../lib/audit';
import { HttpError, notFound } from '../lib/http';
import { getSetting } from '../lib/settings';
import { createBriefing } from '../orchestrator/briefing';
import { idParam, type Module } from './core';

/** Executive metrics. Every number is a query over stored data; nothing is estimated except cost (from token counts × prices). */
export const dashboardModule: Module = (app, ctx, auth) => {
  app.get('/hq/v1/dashboard', async (req) => {
    await auth.viewer(req);
    const one = async <T>(sql: string) => (await ctx.db.query<T>(sql))[0];
    const [employees, tasks, approvals, projects, deadlines, meetings, usage, byDay, byModel, departments, providers] = await Promise.all([
      one<{ total: number; active: number; working: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE active)::int AS active,
         count(*) FILTER (WHERE status NOT IN ('idle', 'completed', 'blocked', 'waiting_approval'))::int AS working FROM hq_employees WHERE archived_at IS NULL`
      ),
      one<Record<string, number>>(
        `SELECT count(*) FILTER (WHERE status IN ('in_progress', 'under_review'))::int AS in_progress, count(*) FILTER (WHERE status = 'assigned')::int AS queued,
         count(*) FILTER (WHERE status = 'completed')::int AS completed, count(*) FILTER (WHERE status = 'blocked')::int AS blocked,
         count(*) FILTER (WHERE status = 'waiting_approval')::int AS waiting, count(*) FILTER (WHERE status = 'backlog')::int AS backlog,
         count(*) FILTER (WHERE completed_at >= now() - interval '24 hours')::int AS completed_24h FROM hq_tasks`
      ),
      ctx.db.query(`SELECT a.id, a.kind, a.title, a.created_at, e.name AS employee_name FROM hq_approvals a LEFT JOIN hq_employees e ON e.id = a.employee_id WHERE a.status = 'pending' ORDER BY a.created_at LIMIT 10`),
      ctx.db.query(`SELECT p.id, p.name, p.status, count(t.id)::int AS tasks, count(t.id) FILTER (WHERE t.status = 'completed')::int AS completed, count(t.id) FILTER (WHERE t.status = 'blocked')::int AS blocked
        FROM hq_projects p LEFT JOIN hq_tasks t ON t.project_id = p.id AND t.kind <> 'plan' WHERE p.status = 'active' GROUP BY p.id ORDER BY p.created_at DESC LIMIT 10`),
      ctx.db.query(`SELECT t.id, t.title, t.deadline, t.status, e.name AS assignee_name FROM hq_tasks t LEFT JOIN hq_employees e ON e.id = t.assignee_id
        WHERE t.deadline IS NOT NULL AND t.status NOT IN ('completed', 'cancelled', 'rejected') ORDER BY t.deadline LIMIT 10`),
      ctx.db.query(`SELECT id, title, status, room, created_at, ended_at FROM hq_meetings ORDER BY created_at DESC LIMIT 6`),
      one<{ runs: number; failed: number; tokens: number; cost_usd: number; unpriced_runs: number }>(
        `SELECT count(*)::int AS runs, count(*) FILTER (WHERE status = 'failed')::int AS failed, coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0)::bigint AS tokens,
         coalesce(sum(cost_usd), 0)::float AS cost_usd, count(*) FILTER (WHERE cost_usd IS NULL AND model_calls > 0)::int AS unpriced_runs FROM hq_runs`
      ),
      ctx.db.query(`SELECT to_char(date_trunc('day', started_at), 'YYYY-MM-DD') AS day, count(*)::int AS runs, coalesce(sum(cost_usd), 0)::float AS cost_usd,
        coalesce(sum(input_tokens + output_tokens + cache_read_tokens), 0)::bigint AS tokens FROM hq_runs WHERE started_at >= now() - interval '14 days' GROUP BY 1 ORDER BY 1`),
      ctx.db.query(`SELECT model, count(*)::int AS runs, coalesce(sum(cost_usd), 0)::float AS cost_usd, coalesce(sum(input_tokens), 0)::bigint AS input, coalesce(sum(output_tokens), 0)::bigint AS output,
        coalesce(sum(cache_read_tokens), 0)::bigint AS cache_read FROM hq_runs GROUP BY model ORDER BY cost_usd DESC`),
      ctx.db.query(`SELECT d.id, d.name_en, d.name_ar, d.color, count(DISTINCT e.id)::int AS employees,
        count(t.id) FILTER (WHERE t.status = 'completed')::int AS completed, count(t.id) FILTER (WHERE t.status IN ('in_progress', 'under_review', 'assigned'))::int AS active,
        count(t.id) FILTER (WHERE t.status = 'blocked')::int AS blocked,
        (SELECT count(*)::int FROM hq_deliverables dd JOIN hq_employees de ON de.id = dd.employee_id WHERE de.department_id = d.id AND dd.review_status = 'accepted') AS accepted,
        (SELECT coalesce(sum(r.cost_usd), 0)::float FROM hq_runs r JOIN hq_employees re ON re.id = r.employee_id WHERE re.department_id = d.id) AS cost_usd
        FROM hq_departments d LEFT JOIN hq_employees e ON e.department_id = d.id AND e.archived_at IS NULL LEFT JOIN hq_tasks t ON t.assignee_id = e.id GROUP BY d.id ORDER BY d.sort`),
      ctx.db.query(`SELECT count(*)::int AS n, bool_or(last_check->>'ok' = 'true') AS verified FROM hq_providers WHERE enabled`)
    ]);
    const limits = await getSetting(ctx.db, 'limits');
    const [gh] = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM hq_integrations WHERE kind = 'github'`);
    return {
      employees,
      tasks,
      approvals,
      projects,
      deadlines,
      meetings,
      usage: { ...usage, tokens: Number(usage.tokens), ...(await spend(ctx)), dailyBudgetUsd: limits.dailyBudgetUsd, monthlyBudgetUsd: limits.monthlyBudgetUsd },
      usageByDay: byDay,
      usageByModel: byModel,
      departments,
      setup: { providers: (providers[0] as { n: number }).n, providerVerified: !!(providers[0] as { verified: boolean | null }).verified, github: gh.n > 0 }
    };
  });

  app.get('/hq/v1/reports', async (req) => {
    await auth.viewer(req);
    return ctx.db.query('SELECT id, kind, title, content IS NOT NULL AS written, created_at FROM hq_reports ORDER BY created_at DESC LIMIT 100');
  });
  app.get('/hq/v1/reports/:id', async (req) => {
    await auth.viewer(req);
    const [r] = await ctx.db.query('SELECT * FROM hq_reports WHERE id = $1', [idParam(req.params)]);
    if (!r) throw notFound();
    return r;
  });
  app.post('/hq/v1/reports', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const o = await auth.owner(req);
    const b = z.object({ kind: z.enum(['daily_briefing', 'weekly_briefing']).default('daily_briefing') }).parse(req.body ?? {});
    try {
      const res = await createBriefing(ctx, b.kind);
      await audit(ctx.db, { type: 'owner', id: o.id }, 'report.create', 'report', res.id, { kind: b.kind, written: res.written });
      return res;
    } catch (e) {
      throw new HttpError(502, 'briefing_failed', (e as Error).message);
    }
  });

  /** Live updates (Server-Sent Events). Every event is emitted after the change was stored. */
  app.get('/hq/v1/stream', async (req, reply) => {
    await auth.viewer(req);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    const off = ctx.bus.on((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      off();
    });
  });
};
