import type { Ctx } from '../context';
import { getSetting } from '../lib/settings';
import { answerChat } from './chat';
import { meetingStep } from './meetings';
import { executeTask, planTask, reviewTask } from './tasks';

type Job = { kind: 'task'; id: string; queue: 'execute' | 'review' | 'plan'; employeeId: string } | { kind: 'meeting'; id: string } | { kind: 'chat'; id: string; employeeId: string };

/**
 * Background worker. Work is stored in the database (task queue column, running meetings, chat queue) and
 * claimed with a lease, so it survives restarts and never runs twice at the same time. Concurrency is limited by
 * Settings → Limits; an employee works on one thing at a time.
 */
export class Worker {
  private running = new Set<Promise<void>>();
  private busy = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private again = false;
  private stopped = false;
  /** Paused workers claim nothing new (used by tests and maintenance). */
  paused = false;

  constructor(private ctx: Ctx, private intervalMs = 2000) {}

  async start() {
    // Runs left "running" by a previous process were interrupted.
    await this.ctx.db.query(`UPDATE hq_runs SET status = 'failed', error = 'Interrupted by a restart', finished_at = now() WHERE status = 'running'`);
    await this.ctx.db.query(`UPDATE hq_tasks SET lease_until = NULL WHERE queue IS NOT NULL AND lease_until > now() + interval '1 hour'`);
    await this.ctx.db.query(`UPDATE hq_meetings SET lease_until = NULL WHERE status IN ('running', 'wrapping_up')`);
    await this.ctx.db.query(`UPDATE hq_tasks SET lease_until = NULL WHERE status = 'in_progress' OR status = 'under_review'`);
    await this.ctx.db.query(`UPDATE hq_chat_queue SET status = 'queued', lease_until = NULL WHERE status = 'running'`);
    this.timer = setInterval(() => this.wake(), this.intervalMs);
    this.timer.unref?.();
    this.wake();
  }

  wake = () => {
    if (this.stopped) return;
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    this.tick()
      .catch((e) => console.error('[hq worker]', e))
      .finally(() => {
        this.ticking = false;
        if (this.again) {
          this.again = false;
          this.wake();
        }
      });
  };

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.running]);
  }

  /** Resolves when no job is running and nothing runnable is queued, observed several times in a row (used by tests). */
  async idle(timeoutMs = 30_000) {
    const end = Date.now() + timeoutMs;
    let quiet = 0;
    while (Date.now() < end) {
      if (!this.running.size && !this.ticking) {
        if (++quiet >= 4) return;
        this.wake();
      } else quiet = 0;
      await Promise.race([...this.running, new Promise((r) => setTimeout(r, 25))]);
    }
    throw new Error('worker did not become idle');
  }

  private async tick() {
    const limits = await getSetting(this.ctx.db, 'limits');
    while (this.running.size < limits.maxConcurrency && !this.stopped && !this.paused) {
      const job = await this.claim();
      if (!job) return;
      const p = this.run(job).finally(() => {
        this.running.delete(p);
        if ('employeeId' in job) this.busy.delete(job.employeeId);
        this.wake();
      });
      this.running.add(p);
    }
  }

  private async claim(): Promise<Job | null> {
    const db = this.ctx.db;
    const busy = [...this.busy];
    // 1. Meetings in progress (one step at a time).
    const [m] = await db.query<{ id: string }>(
      `UPDATE hq_meetings SET lease_until = now() + interval '15 minutes'
       WHERE id = (SELECT id FROM hq_meetings WHERE status IN ('running', 'wrapping_up') AND (lease_until IS NULL OR lease_until < now()) ORDER BY created_at LIMIT 1)
       RETURNING id`
    );
    if (m) return { kind: 'meeting', id: m.id };
    // 2. Owner conversations.
    const [c] = await db.query<{ id: string; employee_id: string }>(
      `UPDATE hq_chat_queue SET status = 'running', lease_until = now() + interval '15 minutes'
       WHERE id = (SELECT q.id FROM hq_chat_queue q JOIN hq_employees e ON e.id = q.employee_id
                   WHERE q.status = 'queued' AND NOT (q.employee_id = ANY($1::uuid[])) AND e.current_meeting_id IS NULL ORDER BY q.created_at LIMIT 1)
       RETURNING id, employee_id`,
      [busy]
    );
    if (c) {
      this.busy.add(c.employee_id);
      return { kind: 'chat', id: c.id, employeeId: c.employee_id };
    }
    // 3. Tasks: highest priority first, dependencies complete, the employee free.
    const limits = await getSetting(db, 'limits');
    const [t] = await db.query<{ id: string; queue: 'execute' | 'review' | 'plan'; who: string }>(
      `UPDATE hq_tasks SET lease_until = now() + make_interval(secs => $2)
       WHERE id = (
         SELECT t.id FROM hq_tasks t
         JOIN hq_employees e ON e.id = CASE WHEN t.queue = 'review' THEN t.reviewer_id ELSE t.assignee_id END
         LEFT JOIN hq_projects p ON p.id = t.project_id
         WHERE t.queue IS NOT NULL
           AND t.status IN ('assigned', 'in_progress', 'under_review')
           AND (t.lease_until IS NULL OR t.lease_until < now())
           AND e.active AND e.archived_at IS NULL AND e.current_meeting_id IS NULL
           AND NOT (e.id = ANY($1::uuid[]))
           AND (p.id IS NULL OR p.status = 'active')
           AND (t.queue = 'review' OR NOT EXISTS (
             SELECT 1 FROM hq_task_deps d JOIN hq_tasks dt ON dt.id = d.depends_on_id WHERE d.task_id = t.id AND dt.status <> 'completed'))
         ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.deadline NULLS LAST, t.created_at
         LIMIT 1)
       RETURNING id, queue, CASE WHEN queue = 'review' THEN reviewer_id ELSE assignee_id END AS who`,
      [busy, limits.runTimeoutSeconds * 3]
    );
    if (t) {
      this.busy.add(t.who);
      return { kind: 'task', id: t.id, queue: t.queue, employeeId: t.who };
    }
    return null;
  }

  private async run(job: Job) {
    try {
      if (job.kind === 'meeting') {
        await meetingStep(this.ctx, job.id);
        await this.ctx.db.query(`UPDATE hq_meetings SET lease_until = NULL WHERE id = $1 AND status IN ('running', 'wrapping_up')`, [job.id]);
      } else if (job.kind === 'chat') {
        await answerChat(this.ctx, job.id);
      } else {
        if (job.queue === 'execute') await executeTask(this.ctx, job.id);
        else if (job.queue === 'review') await reviewTask(this.ctx, job.id);
        else await planTask(this.ctx, job.id);
        // Handlers set the next state; a lease is cleared unless they scheduled a retry in the future.
        await this.ctx.db.query(`UPDATE hq_tasks SET lease_until = NULL WHERE id = $1 AND lease_until > now() + interval '10 minutes'`, [job.id]);
      }
    } catch (e) {
      console.error('[hq worker] job failed', job, e);
      // An unexpected error is a bug: block the task with the message instead of retrying silently.
      if (job.kind === 'task')
        await this.ctx.db.query(`UPDATE hq_tasks SET status = 'blocked', queue = NULL, lease_until = NULL, blocked_reason = $2, updated_at = now() WHERE id = $1`, [
          job.id,
          `Internal error: ${(e as Error).message}`
        ]);
      if (job.kind === 'chat') await this.ctx.db.query(`UPDATE hq_chat_queue SET status = 'failed', error = $2 WHERE id = $1`, [job.id, (e as Error).message]);
    }
  }
}
