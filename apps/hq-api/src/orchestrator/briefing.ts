import { z } from 'zod';
import { systemPromptFor } from '../agents/context';
import { loadEmployee, runAgent, spend } from '../agents/runner';
import { settleEmployee, type Ctx } from '../context';

/** Facts for a briefing, all read from stored data for the period. */
export async function briefingFacts(ctx: Ctx, hours: number) {
  const since = `now() - make_interval(hours => ${Number(hours)})`;
  const q = <T>(sql: string) => ctx.db.query<T>(sql);
  const completed = await q<{ title: string; assignee: string | null; summary: string | null }>(
    `SELECT t.title, e.name AS assignee, (SELECT summary FROM hq_deliverables d WHERE d.task_id = t.id ORDER BY version DESC LIMIT 1) AS summary
     FROM hq_tasks t LEFT JOIN hq_employees e ON e.id = t.assignee_id WHERE t.completed_at >= ${since} ORDER BY t.completed_at DESC LIMIT 30`
  );
  const started = await q<{ title: string; assignee: string | null }>(`SELECT t.title, e.name AS assignee FROM hq_tasks t LEFT JOIN hq_employees e ON e.id = t.assignee_id WHERE t.created_at >= ${since} ORDER BY t.created_at DESC LIMIT 30`);
  const blocked = await q<{ title: string; assignee: string | null; reason: string | null }>(
    `SELECT t.title, e.name AS assignee, t.blocked_reason AS reason FROM hq_tasks t LEFT JOIN hq_employees e ON e.id = t.assignee_id WHERE t.status = 'blocked' ORDER BY t.updated_at DESC LIMIT 20`
  );
  const overdue = await q<{ title: string; assignee: string | null; deadline: string }>(
    `SELECT t.title, e.name AS assignee, t.deadline FROM hq_tasks t LEFT JOIN hq_employees e ON e.id = t.assignee_id WHERE t.deadline < now() AND t.status NOT IN ('completed', 'cancelled', 'rejected') ORDER BY t.deadline LIMIT 20`
  );
  const approvals = await q<{ title: string; kind: string; created_at: string }>(`SELECT title, kind, created_at FROM hq_approvals WHERE status = 'pending' ORDER BY created_at LIMIT 20`);
  const meetings = await q<{ title: string; status: string; summary: string | null }>(
    `SELECT title, status, minutes->>'executive_summary' AS summary FROM hq_meetings WHERE created_at >= ${since} ORDER BY created_at DESC LIMIT 10`
  );
  const inProgress = await q<{ n: number }>(`SELECT count(*)::int AS n FROM hq_tasks WHERE status IN ('in_progress', 'under_review', 'assigned')`);
  const failedRuns = await q<{ n: number }>(`SELECT count(*)::int AS n FROM hq_runs WHERE status = 'failed' AND started_at >= ${since}`);
  return { periodHours: hours, generatedAt: new Date().toISOString(), completed, started, blocked, overdue, pendingApprovals: approvals, meetings, inProgress: inProgress[0].n, failedRuns: failedRuns[0].n, spend: await spend(ctx) };
}

const Briefing = z.object({
  headline: z.string().max(300),
  what_happened: z.string().max(4000),
  completed: z.array(z.string().max(500)).max(30).default([]),
  delayed_or_blocked: z.array(z.string().max(500)).max(30).default([]),
  needs_ceo_decision: z.array(z.string().max(500)).max(30).default([]),
  next_steps: z.array(z.string().max(500)).max(20).default([])
});

/**
 * Create a briefing. The facts are always stored; the Chief of Staff's written summary is added when a provider is
 * configured (and is grounded only in those facts).
 */
export async function createBriefing(ctx: Ctx, kind: 'daily_briefing' | 'weekly_briefing') {
  const facts = await briefingFacts(ctx, kind === 'daily_briefing' ? 24 : 24 * 7);
  const title = `${kind === 'daily_briefing' ? 'Daily' : 'Weekly'} briefing — ${new Date().toISOString().slice(0, 10)}`;
  const [r] = await ctx.db.query<{ id: string }>('INSERT INTO hq_reports (kind, title, facts) VALUES ($1, $2, $3) RETURNING id', [kind, title, JSON.stringify(facts)]);
  const [cos] = await ctx.db.query<{ id: string }>(`SELECT id FROM hq_employees WHERE slug = 'chief-of-staff' AND active AND archived_at IS NULL`);
  if (!cos || !(await ctx.providers.hasAny())) return { id: r.id, written: false };
  const e = (await loadEmployee(ctx, cos.id))!;
  try {
    const res = await runAgent(ctx, {
      kind: 'briefing',
      employee: e,
      system: await systemPromptFor(ctx, e),
      prompt: `Write the ${kind === 'daily_briefing' ? 'daily' : 'weekly'} executive briefing for the CEO using ONLY these facts from the HQ database (JSON). Do not add events that are not in the facts. If little happened, say so.\n\n${JSON.stringify(facts, null, 1)}\n\nCall submit_briefing.`,
      tools: [],
      terminal: { name: 'submit_briefing', description: 'Submit the briefing.', input: Briefing, status: ['writing', 'Writing the briefing'] },
      maxIterations: 2
    });
    await ctx.db.query('UPDATE hq_reports SET content = $2, run_id = $3 WHERE id = $1', [r.id, JSON.stringify(res.output), res.runId]);
    return { id: r.id, written: true };
  } finally {
    await settleEmployee(ctx, e.id);
  }
}
