import { z } from 'zod';
import { projectOf, systemPromptFor, taskContext, toolingNote, type TaskRow } from '../agents/context';
import { clip } from '../agents/knowledge';
import type { EmployeeRow } from '../agents/prompts';
import { loadEmployee, runAgent, RunError, type Terminal } from '../agents/runner';
import { toolsFor } from '../agents/tools';
import { channelFor, emitTask, notify, postMessage, setEmployeeStatus, settleEmployee, taskComment, type Ctx } from '../context';
import { audit } from '../lib/audit';
import { getSetting } from '../lib/settings';

export const Deliverable = z.object({
  summary: z.string().min(5).max(2000).describe('Two to five sentences: what you produced and the key conclusions.'),
  content: z.string().min(1).max(100_000).describe('The full deliverable in Markdown.'),
  outcome: z.enum(['completed', 'blocked', 'needs_owner_decision']).describe('completed = the task is done; blocked = cannot proceed; needs_owner_decision = a decision only the owner can make.'),
  blocker: z.string().max(2000).optional().describe('Required when outcome is blocked.'),
  question: z.string().max(2000).optional().describe('Required when outcome is needs_owner_decision: the decision you need, with options.'),
  verification: z.string().max(3000).optional().describe('What you actually checked (files read, data used) and what remains unverified.')
});

const deliverableTerminal: Terminal<typeof Deliverable> = {
  name: 'submit_deliverable',
  description: 'Submit your finished work for this task. Call exactly once, at the end.',
  input: Deliverable,
  status: ['writing', 'Submitting deliverable']
};

export const ReviewOutput = z.object({
  verdict: z.enum(['approved', 'changes_requested']),
  summary: z.string().min(5).max(3000),
  findings: z
    .array(z.object({ severity: z.enum(['critical', 'major', 'minor', 'info']), title: z.string().max(200), detail: z.string().max(3000), evidence: z.string().max(3000).optional() }))
    .max(30)
    .default([])
});

export const PlanOutput = z.object({
  summary: z.string().min(5).max(3000).describe('How the objective will be achieved.'),
  deliverables: z.array(z.string().max(300)).min(1).max(15).describe('What the owner will receive at the end.'),
  subtasks: z
    .array(
      z.object({
        key: z.string().min(1).max(30).describe('Short unique key, e.g. "req" or "ux-audit".'),
        title: z.string().min(3).max(200),
        description: z.string().min(10).max(6000),
        acceptance_criteria: z.string().max(3000).default(''),
        assignee: z.string().describe('Employee slug from the roster.'),
        reviewer: z.string().optional().describe('Optional slug of a different employee who must independently verify the result (e.g. qa-engineer for code).'),
        depends_on: z.array(z.string()).max(10).default([]).describe('Keys of subtasks whose results this one needs.'),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
        deadline_days: z.number().int().min(0).max(365).optional()
      })
    )
    .min(1)
    .max(20)
});
export type Plan = z.infer<typeof PlanOutput>;

async function loadTask(ctx: Ctx, id: string) {
  const [t] = await ctx.db.query<TaskRow>('SELECT * FROM hq_tasks WHERE id = $1', [id]);
  return t ?? null;
}

async function updateTask(ctx: Ctx, id: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  await ctx.db.query(`UPDATE hq_tasks SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
  await emitTask(ctx, id);
}

/** Post a task event to the project channel (or the assignee's department channel). */
async function announce(ctx: Ctx, task: TaskRow, e: EmployeeRow | null, body: string) {
  const ch = (task.project_id && (await channelFor(ctx, 'project', task.project_id))) || (e && (await channelFor(ctx, 'department', e.department_id)));
  if (ch) await postMessage(ctx, ch, { type: 'system' }, body, { taskId: task.id });
}

/** A run failed: retry later if it may succeed, otherwise block the task with the reason. */
async function handleFailure(ctx: Ctx, task: TaskRow, e: EmployeeRow, err: unknown, queue: 'execute' | 'review' | 'plan') {
  const limits = await getSetting(ctx.db, 'limits');
  const re = err instanceof RunError ? err : new RunError((err as Error).message, true, 'provider');
  const attempts = task.attempts + 1;
  if (re.retryable && attempts < limits.maxAttempts) {
    const backoff = 30 * 2 ** (attempts - 1);
    await updateTask(ctx, task.id, { attempts, queue, lease_until: new Date(Date.now() + backoff * 1000), blocked_reason: `Attempt ${attempts} failed: ${re.message}. Retrying in ${backoff}s.` });
    await taskComment(ctx, task.id, { type: 'system' }, `Attempt ${attempts} failed: ${re.message}. Retrying automatically.`);
  } else {
    await updateTask(ctx, task.id, { attempts, status: 'blocked', queue: null, lease_until: null, blocked_reason: re.message });
    await taskComment(ctx, task.id, { type: 'system' }, `Blocked: ${re.message}`);
    await notify(ctx, 'task_blocked', `Task blocked: ${task.title}`, re.message, `/tasks/${task.id}`);
  }
  await settleEmployee(ctx, e.id);
}

/** Execute a work or synthesis task with its assignee. */
export async function executeTask(ctx: Ctx, taskId: string) {
  const task = await loadTask(ctx, taskId);
  if (!task || !task.assignee_id) return;
  const e = await loadEmployee(ctx, task.assignee_id);
  if (!e || !e.active || e.archived_at) {
    await updateTask(ctx, task.id, { status: 'blocked', queue: null, blocked_reason: 'The assignee is inactive.' });
    return;
  }
  const first = task.attempts === 0 && task.revision === 0;
  await updateTask(ctx, task.id, { status: 'in_progress', blocked_reason: null, ...(first ? { started_at: new Date() } : {}) });
  if (first) await announce(ctx, task, e, `${e.name} started “${task.title}”.`);
  await setEmployeeStatus(ctx, e.id, 'working', task.title, { taskId: task.id });
  const project = await projectOf(ctx, task.project_id);
  let prompt = await taskContext(ctx, task, e);
  if (task.kind === 'synthesis') prompt += await synthesisContext(ctx, task);
  prompt += `\n\nDo the task now. Use your tools where they help you verify facts. Finish by calling submit_deliverable.`;
  try {
    const res = await runAgent(ctx, {
      kind: 'task',
      employee: e,
      system: await systemPromptFor(ctx, e),
      prompt,
      tools: toolsFor(e, { allowSideEffects: true }),
      terminal: deliverableTerminal,
      textFallback: (text) => (text.length > 50 ? { summary: clip(text, 400), content: text, outcome: 'completed' as const } : null),
      taskId: task.id,
      projectId: task.project_id,
      projectRepo: project?.repo ?? null,
      thinkingStatus: ['thinking', task.title]
    });
    await recordDeliverable(ctx, task, e, res.output!, res.runId);
  } catch (err) {
    await handleFailure(ctx, task, e, err, 'execute');
  }
}

async function recordDeliverable(ctx: Ctx, task: TaskRow, e: EmployeeRow, d: z.infer<typeof Deliverable>, runId: string) {
  const [{ v }] = await ctx.db.query<{ v: number }>('SELECT coalesce(max(version), 0) + 1 AS v FROM hq_deliverables WHERE task_id = $1', [task.id]);
  const content = d.verification ? `${d.content}\n\n---\n**Verification:** ${d.verification}` : d.content;
  const [del] = await ctx.db.query<{ id: string }>(
    'INSERT INTO hq_deliverables (task_id, employee_id, run_id, version, summary, content, data) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [task.id, e.id, runId, v, d.summary, content, JSON.stringify({ outcome: d.outcome, blocker: d.blocker, question: d.question })]
  );
  if (d.outcome === 'blocked') {
    await updateTask(ctx, task.id, { status: 'blocked', queue: null, lease_until: null, blocked_reason: d.blocker ?? d.summary });
    await notify(ctx, 'task_blocked', `${e.name} is blocked: ${task.title}`, d.blocker ?? d.summary, `/tasks/${task.id}`);
    await settleEmployee(ctx, e.id);
    return;
  }
  if (d.outcome === 'needs_owner_decision') {
    const question = d.question ?? d.summary;
    await updateTask(ctx, task.id, { status: 'waiting_approval', queue: null, lease_until: null, owner_question: question });
    await ctx.db.query(`INSERT INTO hq_approvals (kind, title, description, payload, employee_id, task_id) VALUES ('owner_decision', $1, $2, $3, $4, $5)`, [
      `Decision needed: ${task.title}`,
      question,
      JSON.stringify({ deliverableId: del.id }),
      e.id,
      task.id
    ]);
    await notify(ctx, 'approval', `${e.name} needs your decision`, question, `/tasks/${task.id}`);
    await settleEmployee(ctx, e.id);
    return;
  }
  if (task.reviewer_id && task.reviewer_id !== e.id) {
    await updateTask(ctx, task.id, { status: 'under_review', queue: 'review', lease_until: null, attempts: 0 });
    await announce(ctx, task, e, `${e.name} submitted “${task.title}” for review.`);
    await settleEmployee(ctx, e.id);
    return;
  }
  await completeTask(ctx, task, e, del.id);
}

async function completeTask(ctx: Ctx, task: TaskRow, e: EmployeeRow, deliverableId: string) {
  await updateTask(ctx, task.id, { status: 'completed', queue: null, lease_until: null, completed_at: new Date(), blocked_reason: null });
  await announce(ctx, task, e, `${e.name} completed “${task.title}”.`);
  await settleEmployee(ctx, e.id, true);
  if (task.kind === 'synthesis' && task.parent_id) {
    await updateTask(ctx, task.parent_id, { status: 'completed', queue: null, completed_at: new Date() });
    const [parent] = await ctx.db.query<{ title: string }>('SELECT title FROM hq_tasks WHERE id = $1', [task.parent_id]);
    await notify(ctx, 'objective_done', `Results ready: ${parent?.title ?? task.title}`, 'The Chief of Staff prepared the final report.', `/tasks/${task.parent_id}`);
  } else if (!task.parent_id) {
    await notify(ctx, 'task_done', `${e.name} completed: ${task.title}`, '', `/tasks/${task.id}`);
  }
  // Deliverables become retrievable knowledge for later work in the same project / company.
  const [d] = await ctx.db.query<{ summary: string }>('SELECT summary FROM hq_deliverables WHERE id = $1', [deliverableId]);
  if (d)
    await ctx.db.query(`INSERT INTO hq_knowledge (scope, project_id, kind, title, body, source) VALUES ($1, $2, 'deliverable', $3, $4, $5)`, [
      task.project_id ? 'project' : 'company',
      task.project_id,
      `Deliverable: ${task.title}`,
      d.summary,
      JSON.stringify({ taskId: task.id, deliverableId, employeeId: e.id })
    ]);
  ctx.wake();
}

/** Independent review by the reviewer (e.g. QA): checks the deliverable against the criteria and the real code. */
export async function reviewTask(ctx: Ctx, taskId: string) {
  const task = await loadTask(ctx, taskId);
  if (!task?.reviewer_id) return;
  const reviewer = await loadEmployee(ctx, task.reviewer_id);
  const author = task.assignee_id ? await loadEmployee(ctx, task.assignee_id) : null;
  if (!reviewer || !reviewer.active) {
    await updateTask(ctx, task.id, { status: 'blocked', queue: null, blocked_reason: 'The reviewer is inactive.' });
    return;
  }
  const [del] = await ctx.db.query<{ id: string; summary: string; content: string; version: number }>('SELECT * FROM hq_deliverables WHERE task_id = $1 ORDER BY version DESC LIMIT 1', [task.id]);
  if (!del) return;
  const proposals = await ctx.db.query<{ id: string; title: string; repo: string; files: { path: string; content: string | null; original: string | null }[] }>(
    `SELECT id, title, repo, files FROM hq_change_proposals WHERE task_id = $1 ORDER BY created_at DESC LIMIT 3`,
    [task.id]
  );
  await setEmployeeStatus(ctx, reviewer.id, 'collaborating', `Reviewing: ${task.title}`, { taskId: task.id });
  const project = await projectOf(ctx, task.project_id);
  const prompt = `You are reviewing work by ${author?.name ?? 'a colleague'} (${author?.title ?? ''}). Verify it independently: do not accept claims at face value. Check it against the task and acceptance criteria${
    proposals.length ? ', read the proposed code below and compare with the repository where needed' : ''
  }. Approve only if it is correct and complete enough to hand to the owner.

## Task
**${task.title}**
${task.description}
${task.acceptance_criteria ? `\n### Acceptance criteria\n${task.acceptance_criteria}` : ''}

## Deliverable (version ${del.version})
${del.summary}

${clip(del.content, 40_000)}
${proposals
  .map(
    (p) =>
      `\n## Proposed code change: ${p.title} (${p.repo})\n${p.files
        .map((f) => `### ${f.path}${f.content === null ? ' (deleted)' : f.original === null ? ' (new file)' : ''}\n<untrusted source="proposal ${p.id}">\n${clip(f.content ?? '', 15_000)}\n</untrusted>`)
        .join('\n')}`
  )
  .join('\n')}

${await toolingNote(ctx, reviewer, project?.repo ?? null)}

Finish by calling submit_review. Use changes_requested with concrete findings if anything important is wrong or unverified.`;
  try {
    const res = await runAgent(ctx, {
      kind: 'review',
      employee: reviewer,
      system: await systemPromptFor(ctx, reviewer),
      prompt,
      tools: toolsFor(reviewer, { allowSideEffects: false }),
      terminal: { name: 'submit_review', description: 'Submit your review verdict and findings.', input: ReviewOutput, status: ['writing', 'Writing review'] },
      taskId: task.id,
      projectId: task.project_id,
      projectRepo: project?.repo ?? null,
      thinkingStatus: ['reading', `Reviewing: ${task.title}`]
    });
    const r = res.output!;
    await ctx.db.query('INSERT INTO hq_reviews (task_id, deliverable_id, reviewer_type, reviewer_id, verdict, summary, findings, run_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
      task.id,
      del.id,
      'employee',
      reviewer.id,
      r.verdict,
      r.summary,
      JSON.stringify(r.findings),
      res.runId
    ]);
    await settleEmployee(ctx, reviewer.id);
    if (r.verdict === 'approved') {
      await ctx.db.query(`UPDATE hq_deliverables SET review_status = 'accepted' WHERE id = $1`, [del.id]);
      await completeTask(ctx, task, author ?? reviewer, del.id);
      return;
    }
    await ctx.db.query(`UPDATE hq_deliverables SET review_status = 'changes_requested' WHERE id = $1`, [del.id]);
    const limits = await getSetting(ctx.db, 'limits');
    if (task.revision + 1 > limits.maxRevisions) {
      await updateTask(ctx, task.id, { status: 'blocked', queue: null, lease_until: null, blocked_reason: `Review still requests changes after ${limits.maxRevisions} revisions. Owner decision needed.` });
      await notify(ctx, 'task_blocked', `Review loop stopped: ${task.title}`, r.summary, `/tasks/${task.id}`);
    } else {
      await updateTask(ctx, task.id, { status: 'assigned', queue: 'execute', revision: task.revision + 1, attempts: 0, lease_until: null });
      await announce(ctx, task, reviewer, `${reviewer.name} requested changes on “${task.title}”: ${clip(r.summary, 300)}`);
    }
  } catch (err) {
    await handleFailure(ctx, task, reviewer, err, 'review');
  }
}

async function roster(ctx: Ctx) {
  return ctx.db.query<{ id: string; slug: string; name: string; title: string; department_id: string; skills: string[] }>(
    'SELECT id, slug, name, title, department_id, skills FROM hq_employees WHERE active AND archived_at IS NULL ORDER BY sort'
  );
}

/** The Chief of Staff turns an objective into a plan of subtasks with owners, reviewers and dependencies. */
export async function planTask(ctx: Ctx, taskId: string) {
  const task = await loadTask(ctx, taskId);
  if (!task?.assignee_id) return;
  const e = await loadEmployee(ctx, task.assignee_id);
  if (!e) return;
  const limits = await getSetting(ctx.db, 'limits');
  await updateTask(ctx, task.id, { status: 'in_progress', started_at: new Date() });
  await setEmployeeStatus(ctx, e.id, 'thinking', `Planning: ${task.title}`, { taskId: task.id });
  const team = await roster(ctx);
  const project = await projectOf(ctx, task.project_id);
  const prompt = `The owner gave you this objective. Understand it, identify the deliverables, break it into at most ${limits.maxSubtasks} subtasks, pick the right employee for each, set dependencies (only where a subtask truly needs another's result, so independent work runs in parallel) and add an independent reviewer where quality must be verified (e.g. qa-engineer for code, ux-researcher for UX). You will receive every result and write the final report yourself, so do not add a final "compile report" subtask.

## Objective
**${task.title}**
${task.description}
${project ? `\nProject: ${project.name}${project.repo ? ` (repository ${project.repo})` : ''}` : ''}

## Roster (slug — name, title, department, skills)
${team.map((m) => `- ${m.slug} — ${m.name}, ${m.title}, ${m.department_id}; ${m.skills.join(', ')}`).join('\n')}

${(await taskContext(ctx, task, e)).split('## Your task')[0]}
Call create_plan with the plan.`;
  try {
    const res = await runAgent(ctx, {
      kind: 'plan',
      employee: e,
      system: await systemPromptFor(ctx, e),
      prompt,
      tools: toolsFor(e, { allowSideEffects: false }),
      terminal: { name: 'create_plan', description: 'Submit the execution plan.', input: PlanOutput, status: ['writing', 'Writing the plan'] },
      taskId: task.id,
      projectId: task.project_id,
      projectRepo: project?.repo ?? null,
      thinkingStatus: ['thinking', `Planning: ${task.title}`]
    });
    const plan = res.output!;
    const problems = validatePlan(plan, team, limits.maxSubtasks);
    if (problems.length) throw new RunError(`The plan was invalid: ${problems.join('; ')}`, true, 'output');
    await ctx.db.query('INSERT INTO hq_deliverables (task_id, employee_id, run_id, summary, content, data) VALUES ($1, $2, $3, $4, $5, $6)', [
      task.id,
      e.id,
      res.runId,
      plan.summary,
      renderPlan(plan, team),
      JSON.stringify({ plan })
    ]);
    const policy = await getSetting(ctx.db, 'policy');
    if (policy.planRequiresApproval) {
      await ctx.db.query(`INSERT INTO hq_approvals (kind, title, description, payload, employee_id, task_id) VALUES ('plan', $1, $2, $3, $4, $5)`, [
        `Plan: ${task.title}`,
        plan.summary,
        JSON.stringify({ plan }),
        e.id,
        task.id
      ]);
      await updateTask(ctx, task.id, { status: 'waiting_approval', queue: null, lease_until: null, owner_question: 'Approve the plan to start execution.' });
      await notify(ctx, 'approval', `${e.name} prepared a plan`, task.title, `/tasks/${task.id}`);
      await settleEmployee(ctx, e.id);
    } else {
      await materializePlan(ctx, task.id, plan, { type: 'system' });
      await settleEmployee(ctx, e.id);
    }
  } catch (err) {
    await handleFailure(ctx, task, e, err, 'plan');
  }
}

export function validatePlan(plan: Plan, team: { slug: string }[], maxSubtasks: number): string[] {
  const problems: string[] = [];
  const slugs = new Set(team.map((t) => t.slug));
  const keys = new Set<string>();
  if (plan.subtasks.length > maxSubtasks) problems.push(`more than ${maxSubtasks} subtasks`);
  for (const s of plan.subtasks) {
    if (keys.has(s.key)) problems.push(`duplicate key ${s.key}`);
    keys.add(s.key);
    if (!slugs.has(s.assignee)) problems.push(`unknown assignee ${s.assignee}`);
    if (s.reviewer && !slugs.has(s.reviewer)) problems.push(`unknown reviewer ${s.reviewer}`);
    if (s.reviewer === s.assignee) problems.push(`${s.key}: reviewer must differ from assignee`);
  }
  for (const s of plan.subtasks) for (const d of s.depends_on) if (!keys.has(d)) problems.push(`${s.key} depends on unknown ${d}`);
  // Cycle check (depth-first).
  const deps = new Map(plan.subtasks.map((s) => [s.key, s.depends_on]));
  const state = new Map<string, 1 | 2>();
  const visit = (k: string): boolean => {
    if (state.get(k) === 2) return false;
    if (state.get(k) === 1) return true;
    state.set(k, 1);
    for (const d of deps.get(k) ?? []) if (visit(d)) return true;
    state.set(k, 2);
    return false;
  };
  for (const k of keys) if (visit(k)) {
    problems.push('dependencies contain a cycle');
    break;
  }
  return problems;
}

function renderPlan(plan: Plan, team: { slug: string; name: string }[]) {
  const name = (s?: string) => team.find((t) => t.slug === s)?.name ?? s ?? '';
  return `${plan.summary}\n\n### Deliverables\n${plan.deliverables.map((d) => `- ${d}`).join('\n')}\n\n### Subtasks\n${plan.subtasks
    .map((s) => `- **${s.title}** — ${name(s.assignee)}${s.reviewer ? `, reviewed by ${name(s.reviewer)}` : ''}${s.depends_on.length ? ` (after ${s.depends_on.join(', ')})` : ''}\n  ${s.description}`)
    .join('\n')}`;
}

/** Create the plan's subtasks and the final synthesis task (Chief of Staff, after all subtasks). */
export async function materializePlan(ctx: Ctx, planTaskId: string, plan: Plan, actor: { type: 'owner' | 'system'; id?: string }) {
  const task = await loadTask(ctx, planTaskId);
  if (!task) return;
  const limits = await getSetting(ctx.db, 'limits');
  if (task.depth + 1 > limits.maxDelegationDepth) throw new Error('Delegation depth limit reached');
  const team = await roster(ctx);
  const bySlug = new Map(team.map((t) => [t.slug, t.id]));
  await ctx.db.tx(async (t) => {
    const ids = new Map<string, string>();
    for (const s of plan.subtasks) {
      const deadline = s.deadline_days != null ? new Date(Date.now() + s.deadline_days * 864e5) : null;
      const [row] = await t.query<{ id: string }>(
        `INSERT INTO hq_tasks (project_id, parent_id, title, description, acceptance_criteria, status, queue, priority, assignee_id, reviewer_id, created_by, deadline, depth)
         VALUES ($1, $2, $3, $4, $5, 'assigned', 'execute', $6, $7, $8, $9, $10, $11) RETURNING id`,
        [task.project_id, task.id, s.title, s.description, s.acceptance_criteria, s.priority, bySlug.get(s.assignee), s.reviewer ? bySlug.get(s.reviewer) : null, task.assignee_id, deadline, task.depth + 1]
      );
      ids.set(s.key, row.id);
    }
    for (const s of plan.subtasks) for (const d of s.depends_on) await t.query('INSERT INTO hq_task_deps (task_id, depends_on_id) VALUES ($1, $2)', [ids.get(s.key), ids.get(d)]);
    const [syn] = await t.query<{ id: string }>(
      `INSERT INTO hq_tasks (project_id, parent_id, kind, title, description, status, queue, priority, assignee_id, created_by, deadline, depth)
       VALUES ($1, $2, 'synthesis', $3, $4, 'assigned', 'execute', $5, $6::uuid, $6::text, $7, $8) RETURNING id`,
      [
        task.project_id,
        task.id,
        `Final report: ${task.title}`,
        `Review every subtask result (they are in your context), check them against the objective, flag gaps, contradictions and anything unverified, and present the final results to the owner with recommendations and the decisions needed. Planned deliverables:\n${plan.deliverables.map((d) => `- ${d}`).join('\n')}`,
        task.priority,
        task.assignee_id,
        task.deadline,
        task.depth + 1
      ]
    );
    for (const id of ids.values()) await t.query('INSERT INTO hq_task_deps (task_id, depends_on_id) VALUES ($1, $2)', [syn.id, id]);
    await t.query(`UPDATE hq_tasks SET status = 'in_progress', queue = NULL, owner_question = NULL, updated_at = now() WHERE id = $1`, [task.id]);
  });
  await audit(ctx.db, actor, 'plan.started', 'task', task.id, { subtasks: plan.subtasks.length });
  await emitTask(ctx, task.id);
  ctx.bus.emit({ type: 'tasks.changed' });
  ctx.wake();
}

async function synthesisContext(ctx: Ctx, task: TaskRow): Promise<string> {
  const rows = await ctx.db.query<{ title: string; status: string; name: string | null; blocked_reason: string | null }>(
    `SELECT t.title, t.status, e.name, t.blocked_reason FROM hq_tasks t LEFT JOIN hq_employees e ON e.id = t.assignee_id WHERE t.parent_id = $1 AND t.kind = 'work' ORDER BY t.created_at`,
    [task.parent_id]
  );
  return `\n\n## Status of all subtasks\n${rows.map((r) => `- ${r.title} — ${r.name ?? 'unassigned'}: ${r.status}${r.blocked_reason ? ` (${r.blocked_reason})` : ''}`).join('\n')}`;
}
