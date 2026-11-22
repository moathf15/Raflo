import type { Config } from './config';
import type { Db } from './db/client';
import type { Fetch } from './github/client';
import type { Bus } from './lib/bus';
import type { Vault } from './lib/crypto';
import type { Providers } from './providers/registry';

export interface Ctx {
  db: Db;
  cfg: Config;
  vault: Vault;
  bus: Bus;
  providers: Providers;
  /** fetch used for GitHub calls (tests inject a fake GitHub). */
  githubFetch: Fetch;
  /** Wakes the background worker after something was queued. Set when the worker starts. */
  wake: () => void;
}

/** Employee states shown by the office. Each one is set by the code path that is actually doing that thing. */
export const EMPLOYEE_STATUSES = ['idle', 'thinking', 'working', 'reading', 'writing', 'in_meeting', 'collaborating', 'waiting_approval', 'blocked', 'completed'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export async function setEmployeeStatus(
  ctx: Ctx,
  employeeId: string,
  status: EmployeeStatus,
  detail: string | null = null,
  extra: { taskId?: string | null; meetingId?: string | null } = {}
) {
  const sets = ['status = $2', 'status_detail = $3', 'status_since = now()'];
  const params: unknown[] = [employeeId, status, detail?.slice(0, 200) ?? null];
  if (extra.taskId !== undefined) {
    params.push(extra.taskId);
    sets.push(`current_task_id = $${params.length}`);
  }
  if (extra.meetingId !== undefined) {
    params.push(extra.meetingId);
    sets.push(`current_meeting_id = $${params.length}`);
  }
  const [row] = await ctx.db.query<{ id: string; status: string; status_detail: string | null; status_since: string; current_task_id: string | null; current_meeting_id: string | null }>(
    `UPDATE hq_employees SET ${sets.join(', ')} WHERE id = $1 RETURNING id, status, status_detail, status_since, current_task_id, current_meeting_id`,
    params
  );
  if (row) ctx.bus.emit({ type: 'employee.status', employee: row });
}

/**
 * After an employee finishes something, pick the state that is true now: waiting on an owner approval,
 * blocked on a task, or idle (shown as "completed" briefly when a task just finished).
 */
export async function settleEmployee(ctx: Ctx, employeeId: string, justCompleted = false) {
  const [w] = await ctx.db.query<{ waiting: number; blocked: number }>(
    `SELECT count(*) FILTER (WHERE status = 'waiting_approval')::int AS waiting, count(*) FILTER (WHERE status = 'blocked')::int AS blocked
     FROM hq_tasks WHERE assignee_id = $1`,
    [employeeId]
  );
  const [m] = await ctx.db.query<{ current_meeting_id: string | null }>('SELECT current_meeting_id FROM hq_employees WHERE id = $1', [employeeId]);
  if (m?.current_meeting_id) return setEmployeeStatus(ctx, employeeId, 'in_meeting', null, { taskId: null });
  if (justCompleted) return setEmployeeStatus(ctx, employeeId, 'completed', 'Finished a task', { taskId: null });
  if (w.waiting > 0) return setEmployeeStatus(ctx, employeeId, 'waiting_approval', 'Waiting for the owner', { taskId: null });
  if (w.blocked > 0) return setEmployeeStatus(ctx, employeeId, 'blocked', 'Has a blocked task', { taskId: null });
  return setEmployeeStatus(ctx, employeeId, 'idle', null, { taskId: null });
}

export async function notify(ctx: Ctx, kind: string, title: string, body = '', link: string | null = null) {
  const [n] = await ctx.db.query('INSERT INTO hq_notifications (kind, title, body, link) VALUES ($1, $2, $3, $4) RETURNING *', [kind, title.slice(0, 300), body.slice(0, 2000), link]);
  ctx.bus.emit({ type: 'notification', notification: n });
}

export async function postMessage(
  ctx: Ctx,
  channelId: string,
  author: { type: 'owner' | 'employee' | 'system'; id?: string | null },
  body: string,
  data: Record<string, unknown> = {},
  runId: string | null = null
) {
  const [m] = await ctx.db.query(
    'INSERT INTO hq_messages (channel_id, author_type, author_id, body, data, run_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [channelId, author.type, author.id ?? null, body.slice(0, 20_000), JSON.stringify(data), runId]
  );
  ctx.bus.emit({ type: 'message', message: m });
  return m as { id: string };
}

export async function channelFor(ctx: Ctx, kind: 'announcements' | 'department' | 'project', ref?: string | null): Promise<string | null> {
  if (kind === 'announcements') return (await ctx.db.query<{ id: string }>(`SELECT id FROM hq_channels WHERE kind = 'announcements' LIMIT 1`))[0]?.id ?? null;
  if (kind === 'department') return (await ctx.db.query<{ id: string }>(`SELECT id FROM hq_channels WHERE kind = 'department' AND department_id = $1`, [ref]))[0]?.id ?? null;
  if (!ref) return null;
  const [c] = await ctx.db.query<{ id: string }>(`SELECT id FROM hq_channels WHERE kind = 'project' AND project_id = $1`, [ref]);
  if (c) return c.id;
  const [p] = await ctx.db.query<{ name: string }>('SELECT name FROM hq_projects WHERE id = $1', [ref]);
  if (!p) return null;
  const [n] = await ctx.db.query<{ id: string }>(`INSERT INTO hq_channels (kind, name, project_id) VALUES ('project', $1, $2) ON CONFLICT DO NOTHING RETURNING id`, [p.name, ref]);
  return n?.id ?? (await ctx.db.query<{ id: string }>(`SELECT id FROM hq_channels WHERE kind = 'project' AND project_id = $1`, [ref]))[0].id;
}

export async function emitTask(ctx: Ctx, taskId: string) {
  const [t] = await ctx.db.query('SELECT * FROM hq_tasks WHERE id = $1', [taskId]);
  if (t) ctx.bus.emit({ type: 'task', task: t });
}

export async function taskComment(ctx: Ctx, taskId: string, author: { type: 'owner' | 'employee' | 'system'; id?: string | null }, body: string) {
  await ctx.db.query('INSERT INTO hq_task_comments (task_id, author_type, author_id, body) VALUES ($1, $2, $3, $4)', [taskId, author.type, author.id ?? null, body.slice(0, 20_000)]);
  ctx.bus.emit({ type: 'task.comment', taskId });
}
