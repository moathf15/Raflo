import type { Ctx } from '../context';
import { connection } from '../github/service';
import { getSetting } from '../lib/settings';
import { clip, searchKnowledge } from './knowledge';
import { rolePrompt, type EmployeeRow } from './prompts';

export async function systemPromptFor(ctx: Ctx, e: EmployeeRow): Promise<string> {
  const company = await getSetting(ctx.db, 'company');
  const [d] = await ctx.db.query<{ name_en: string }>('SELECT name_en FROM hq_departments WHERE id = $1', [e.department_id]);
  const [m] = e.manager_id ? await ctx.db.query<{ name: string; title: string }>('SELECT name, title FROM hq_employees WHERE id = $1', [e.manager_id]) : [];
  return rolePrompt(e, company, d?.name_en ?? e.department_id, m ? `${m.name} (${m.title})` : null);
}

export interface TaskRow {
  id: string;
  project_id: string | null;
  parent_id: string | null;
  kind: 'work' | 'plan' | 'synthesis';
  title: string;
  description: string;
  acceptance_criteria: string;
  status: string;
  queue: string | null;
  priority: string;
  assignee_id: string | null;
  reviewer_id: string | null;
  deadline: string | Date | null;
  depth: number;
  attempts: number;
  revision: number;
  owner_question: string | null;
  github_issue: { repo: string; number: number; title: string; body: string } | null;
}

export async function projectOf(ctx: Ctx, projectId: string | null) {
  if (!projectId) return null;
  const [p] = await ctx.db.query<{ id: string; name: string; description: string; repo: string | null }>('SELECT id, name, description, repo FROM hq_projects WHERE id = $1', [projectId]);
  return p ?? null;
}

/**
 * Everything an employee needs for one task, and nothing else: the task, its project, the approved outputs of
 * the tasks it depends on, review feedback, owner comments, relevant knowledge (retrieved by relevance and
 * permission), its own recent work and messages addressed to it.
 */
export async function taskContext(ctx: Ctx, task: TaskRow, e: EmployeeRow): Promise<string> {
  const parts: string[] = [];
  const project = await projectOf(ctx, task.project_id);
  if (project) parts.push(`## Project: ${project.name}\n${project.description}${project.repo ? `\nRepository: ${project.repo}` : ''}`);
  if (task.parent_id) {
    const [parent] = await ctx.db.query<{ title: string; description: string }>('SELECT title, description FROM hq_tasks WHERE id = $1', [task.parent_id]);
    if (parent) parts.push(`## Overall objective this task belongs to\n${parent.title}\n${clip(parent.description, 3000)}`);
  }
  parts.push(
    `## Your task (priority: ${task.priority}${task.deadline ? `, deadline ${new Date(task.deadline).toISOString().slice(0, 10)}` : ''})\n**${task.title}**\n\n${task.description || '(no further description)'}${
      task.acceptance_criteria ? `\n\n### Acceptance criteria\n${task.acceptance_criteria}` : ''
    }`
  );
  if (task.github_issue) parts.push(`## Linked GitHub issue ${task.github_issue.repo}#${task.github_issue.number}\n<untrusted source="github issue">\n${task.github_issue.title}\n${clip(task.github_issue.body ?? '', 6000)}\n</untrusted>`);

  const deps = await ctx.db.query<{ title: string; name: string | null; summary: string; content: string; review_status: string }>(
    `SELECT t.title, e.name, d.summary, d.content, d.review_status FROM hq_task_deps x
     JOIN hq_tasks t ON t.id = x.depends_on_id
     LEFT JOIN hq_employees e ON e.id = t.assignee_id
     JOIN LATERAL (SELECT * FROM hq_deliverables WHERE task_id = t.id ORDER BY version DESC LIMIT 1) d ON true
     WHERE x.task_id = $1`,
    [task.id]
  );
  if (deps.length)
    parts.push(`## Results from tasks you depend on\n${deps.map((d) => `### ${d.title} — by ${d.name ?? 'unknown'} (${d.review_status})\n${d.summary}\n\n${clip(d.content, 12_000)}`).join('\n\n')}`);

  if (task.revision > 0) {
    const [prev] = await ctx.db.query<{ summary: string; content: string }>('SELECT summary, content FROM hq_deliverables WHERE task_id = $1 ORDER BY version DESC LIMIT 1', [task.id]);
    const reviews = await ctx.db.query<{ verdict: string; summary: string; findings: { severity: string; title: string; detail: string }[]; reviewer_type: string }>(
      'SELECT verdict, summary, findings, reviewer_type FROM hq_reviews WHERE task_id = $1 ORDER BY created_at DESC LIMIT 2',
      [task.id]
    );
    if (prev) parts.push(`## Your previous version (revision ${task.revision})\n${clip(prev.content, 10_000)}`);
    if (reviews.length)
      parts.push(
        `## Review feedback to address\n${reviews
          .map((r) => `${r.reviewer_type === 'owner' ? 'Owner' : 'Reviewer'} — ${r.verdict}: ${r.summary}\n${r.findings.map((f) => `- [${f.severity}] ${f.title}: ${f.detail}`).join('\n')}`)
          .join('\n\n')}`
      );
  }
  const comments = await ctx.db.query<{ author_type: string; body: string; created_at: string }>(
    `SELECT author_type, body, created_at FROM hq_task_comments WHERE task_id = $1 AND author_type IN ('owner', 'system') ORDER BY created_at DESC LIMIT 8`,
    [task.id]
  );
  if (comments.length) parts.push(`## Notes and answers on this task\n${comments.reverse().map((c) => `- (${c.author_type}) ${clip(c.body, 2000)}`).join('\n')}`);
  const attachments = await ctx.db.query<{ name: string; content: string }>('SELECT name, content FROM hq_task_attachments WHERE task_id = $1 ORDER BY created_at LIMIT 5', [task.id]);
  if (attachments.length) parts.push(`## Attachments\n${attachments.map((a) => `### ${a.name}\n<untrusted source="attachment ${a.name}">\n${clip(a.content, 15_000)}\n</untrusted>`).join('\n\n')}`);

  const knowledge = await searchKnowledge(ctx.db, { query: `${task.title} ${task.description}`, employeeId: e.id, departmentId: e.department_id, projectId: task.project_id, limit: 5 });
  if (knowledge.length) parts.push(`## Relevant company knowledge\n${knowledge.map((k) => `### ${k.title} (${k.kind})\n${clip(k.body, 2500)}`).join('\n\n')}`);

  const history = await ctx.db.query<{ title: string; summary: string }>(
    `SELECT t.title, d.summary FROM hq_tasks t JOIN LATERAL (SELECT summary FROM hq_deliverables WHERE task_id = t.id ORDER BY version DESC LIMIT 1) d ON true
     WHERE t.assignee_id = $1 AND t.status = 'completed' AND t.id <> $2 ORDER BY t.completed_at DESC LIMIT 5`,
    [e.id, task.id]
  );
  if (history.length) parts.push(`## Your recent completed work\n${history.map((h) => `- ${h.title}: ${clip(h.summary, 300)}`).join('\n')}`);

  const inbox = await ctx.db.query<{ name: string; body: string }>(
    `SELECT e.name, m.body FROM hq_messages m JOIN hq_employees e ON e.id::text = m.author_id
     WHERE m.data->>'to' = $1 ORDER BY m.created_at DESC LIMIT 5`,
    [e.id]
  );
  if (inbox.length) parts.push(`## Recent messages from colleagues\n${inbox.map((m) => `- ${m.name}: ${clip(m.body, 600)}`).join('\n')}`);

  parts.push(await toolingNote(ctx, e, project?.repo ?? null));
  return parts.join('\n\n');
}

export async function toolingNote(ctx: Ctx, e: EmployeeRow, repo: string | null): Promise<string> {
  if (!e.tools.includes('github.read')) return '## Repository access\nYou have no repository access.';
  const policy = await getSetting(ctx.db, 'policy');
  const conn = policy.githubRead ? await connection(ctx) : null;
  if (!conn) return '## Repository access\nGitHub is not connected or repository reading is disabled, so you cannot inspect code. Say so if the task needs it.';
  const repos = await ctx.db.query<{ full_name: string }>('SELECT full_name FROM hq_repos WHERE allowed');
  return `## Repository access\nAuthorised repositories: ${repos.map((r) => r.full_name).join(', ') || 'none'}${repo ? ` (project repository: ${repo})` : ''}. Inspect the actual code with your GitHub tools before making claims about it.`;
}
