import { z } from 'zod';
import { channelFor, notify, postMessage, type Ctx, type EmployeeStatus } from '../context';
import { safePath } from '../github/client';
import { allowedRepos, authorisedRepo, connection } from '../github/service';
import { audit } from '../lib/audit';
import { getSetting } from '../lib/settings';
import type { ToolDef } from '../providers/types';
import { clip, searchKnowledge } from './knowledge';
import type { EmployeeRow } from './prompts';

/** What a tool knows about the run that called it. */
export interface ToolEnv {
  employee: EmployeeRow;
  runId: string;
  taskId: string | null;
  projectId: string | null;
  projectRepo: string | null;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  /** Permission the employee needs (Employee → Permissions). */
  permission: string;
  description: string;
  input: S;
  status: [EmployeeStatus, string];
  /** True for tools that change something outside the conversation (always through an owner approval). */
  sideEffect?: boolean;
  run(ctx: Ctx, env: ToolEnv, input: z.infer<S>): Promise<string>;
}

const tool = <S extends z.ZodType>(t: Tool<S>) => t as unknown as Tool;
export const toJsonSchema = (s: z.ZodType): Record<string, unknown> => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s) as Record<string, unknown>;
  return rest;
};
export const toToolDef = (name: string, description: string, input: z.ZodType): ToolDef => ({ name, description, schema: toJsonSchema(input) });

const untrusted = (source: string, body: string) => `<untrusted source="${source.replace(/"/g, "'")}">\n${body}\n</untrusted>`;
const Repo = z.string().max(201).optional().describe('owner/name of an authorised repository. Defaults to the project repository.');

async function readableRepo(ctx: Ctx, env: ToolEnv, repo?: string) {
  const policy = await getSetting(ctx.db, 'policy');
  if (!policy.githubRead) throw new Error('Repository reading is disabled by the owner (Settings → Permissions).');
  const conn = await connection(ctx);
  if (!conn) throw new Error('GitHub is not connected.');
  let name = repo ?? env.projectRepo;
  if (!name) {
    const all = await allowedRepos(ctx);
    if (all.length !== 1) throw new Error(`Specify the repository. Authorised: ${all.map((r) => r.full_name).join(', ') || 'none'}`);
    name = all[0].full_name;
  }
  const r = await authorisedRepo(ctx, name);
  return { gh: conn.gh, repo: r.full_name, defaultBranch: r.default_branch };
}

export const TOOLS: Tool[] = [
  tool({
    name: 'knowledge_search',
    permission: 'knowledge.read',
    description: 'Search the company knowledge base (objectives, requirements, decisions, brand guidelines, meeting summaries, previous deliverables).',
    input: z.object({ query: z.string().min(2).max(300) }),
    status: ['reading', 'Searching company knowledge'],
    async run(ctx, env, i) {
      const hits = await searchKnowledge(ctx.db, { query: i.query, employeeId: env.employee.id, departmentId: env.employee.department_id, projectId: env.projectId, limit: 6 });
      if (!hits.length) return 'No matching knowledge entries.';
      return hits.map((h) => `### ${h.title} (${h.kind}, id ${h.id})\n${clip(h.body, 3000)}`).join('\n\n');
    }
  }),
  tool({
    name: 'knowledge_save',
    permission: 'knowledge.write',
    description: 'Save a durable piece of knowledge (a decision, requirement, architecture note, lesson learned) to the company knowledge base. Do not save drafts or chatter.',
    input: z.object({
      title: z.string().min(3).max(200),
      body: z.string().min(10).max(20_000),
      kind: z.enum(['decision', 'requirement', 'architecture', 'brand', 'marketing', 'lesson', 'documentation', 'other']),
      tags: z.array(z.string().max(40)).max(10).default([])
    }),
    status: ['writing', 'Writing to the knowledge base'],
    async run(ctx, env, i) {
      const [k] = await ctx.db.query<{ id: string }>(
        `INSERT INTO hq_knowledge (scope, project_id, kind, title, body, tags, source) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [env.projectId ? 'project' : 'company', env.projectId, i.kind, i.title, i.body, JSON.stringify(i.tags), JSON.stringify({ employeeId: env.employee.id, taskId: env.taskId, runId: env.runId })]
      );
      await audit(ctx.db, { type: 'employee', id: env.employee.id }, 'knowledge.create', 'knowledge', k.id, { title: i.title });
      return `Saved as knowledge entry ${k.id}.`;
    }
  }),
  tool({
    name: 'send_message',
    permission: 'comms.send',
    description:
      'Send a short message to a colleague (by their slug, e.g. "qa-engineer"). It is posted in the project channel (or their department channel) and included in their context next time they work. It does not trigger an immediate reply.',
    input: z.object({ to: z.string().min(2).max(60), body: z.string().min(2).max(4000) }),
    status: ['collaborating', 'Messaging a colleague'],
    async run(ctx, env, i) {
      const [to] = await ctx.db.query<{ id: string; name: string; department_id: string }>('SELECT id, name, department_id FROM hq_employees WHERE slug = $1 AND archived_at IS NULL', [i.to]);
      if (!to) throw new Error(`No employee with slug "${i.to}".`);
      if (to.id === env.employee.id) throw new Error('You cannot message yourself.');
      const channel = (env.projectId && (await channelFor(ctx, 'project', env.projectId))) || (await channelFor(ctx, 'department', to.department_id));
      if (!channel) throw new Error('No channel available.');
      await postMessage(ctx, channel, { type: 'employee', id: env.employee.id }, i.body, { to: to.id, taskId: env.taskId }, env.runId);
      return `Message sent to ${to.name}.`;
    }
  }),
  tool({
    name: 'github_list_files',
    permission: 'github.read',
    description: 'List files in an authorised repository (optionally under a path prefix).',
    input: z.object({ repo: Repo, path_prefix: z.string().max(300).default(''), ref: z.string().max(200).optional() }),
    status: ['reading', 'Browsing the repository'],
    async run(ctx, env, i) {
      const { gh, repo, defaultBranch } = await readableRepo(ctx, env, i.repo);
      const prefix = i.path_prefix ? safePath(i.path_prefix) : '';
      const tree = await gh.tree(repo, i.ref ?? defaultBranch);
      const files = tree.tree.filter((f) => f.type === 'blob' && f.path.startsWith(prefix) && !f.path.includes('node_modules/'));
      const shown = files.slice(0, 400).map((f) => `${f.path} (${f.size ?? 0} B)`);
      return `${repo}@${i.ref ?? defaultBranch}: ${files.length} files${files.length > 400 ? ' (first 400 shown)' : ''}\n${shown.join('\n')}`;
    }
  }),
  tool({
    name: 'github_read_file',
    permission: 'github.read',
    description: 'Read a file from an authorised repository.',
    input: z.object({ repo: Repo, path: z.string().min(1).max(500), ref: z.string().max(200).optional() }),
    status: ['reading', 'Reading code'],
    async run(ctx, env, i) {
      const { gh, repo, defaultBranch } = await readableRepo(ctx, env, i.repo);
      const f = await gh.file(repo, i.path, i.ref ?? defaultBranch);
      return untrusted(`github:${repo}/${f.path}`, clip(f.content, 60_000));
    }
  }),
  tool({
    name: 'github_search_code',
    permission: 'github.read',
    description: 'Search code in an authorised repository (GitHub code search on the default branch).',
    input: z.object({ repo: Repo, query: z.string().min(2).max(200) }),
    status: ['reading', 'Searching the codebase'],
    async run(ctx, env, i) {
      const { gh, repo } = await readableRepo(ctx, env, i.repo);
      const res = await gh.searchCode(repo, i.query);
      return res.items.length ? `${res.total_count} matches:\n${res.items.map((x) => x.path).join('\n')}` : 'No matches.';
    }
  }),
  tool({
    name: 'github_list_issues',
    permission: 'github.read',
    description: 'List issues of an authorised repository.',
    input: z.object({ repo: Repo, state: z.enum(['open', 'closed', 'all']).default('open') }),
    status: ['reading', 'Reading GitHub issues'],
    async run(ctx, env, i) {
      const { gh, repo } = await readableRepo(ctx, env, i.repo);
      const issues = (await gh.issues(repo, i.state)).filter((x) => !x.pull_request);
      return untrusted(`github:${repo}/issues`, issues.map((x) => `#${x.number} [${x.state}] ${x.title}\n${clip(x.body ?? '', 800)}`).join('\n\n') || 'No issues.');
    }
  }),
  tool({
    name: 'github_read_pull',
    permission: 'github.read',
    description: 'Read a pull request: description, changed files and their patches.',
    input: z.object({ repo: Repo, number: z.number().int().positive() }),
    status: ['reading', 'Reviewing a pull request'],
    async run(ctx, env, i) {
      const { gh, repo } = await readableRepo(ctx, env, i.repo);
      const [pr, files] = await Promise.all([gh.pull(repo, i.number), gh.pullFiles(repo, i.number)]);
      const body = `#${pr.number} ${pr.title} (${pr.state}${pr.merged ? ', merged' : ''}) ${pr.head.ref} → ${pr.base.ref}\n${clip(pr.body ?? '', 3000)}\n\n${files
        .map((f) => `--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})\n${clip(f.patch ?? '(binary or too large)', 8000)}`)
        .join('\n\n')}`;
      return untrusted(`github:${repo}/pull/${i.number}`, clip(body, 80_000));
    }
  }),
  tool({
    name: 'github_propose_change',
    permission: 'github.propose',
    description:
      'Propose code changes to an authorised repository. Give the complete new content of each file (or delete: true). Nothing is written: the owner reviews the diff and, if approved, HQ commits it to a new hq/* branch.',
    input: z.object({
      repo: Repo,
      title: z.string().min(5).max(120),
      description: z.string().min(10).max(5000),
      files: z.array(z.object({ path: z.string().min(1).max(300), content: z.string().max(200_000).optional(), delete: z.boolean().optional() })).min(1).max(20)
    }),
    status: ['writing', 'Preparing a code change'],
    sideEffect: true,
    async run(ctx, env, i) {
      const { gh, repo, defaultBranch } = await readableRepo(ctx, env, i.repo);
      const files: { path: string; content: string | null; original: string | null }[] = [];
      for (const f of i.files) {
        const path = safePath(f.path);
        if (!f.delete && f.content === undefined) throw new Error(`${path}: give content or delete: true`);
        let original: string | null = null;
        try {
          original = (await gh.file(repo, path, defaultBranch)).content;
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
        }
        if (f.delete && original === null) throw new Error(`${path} does not exist`);
        files.push({ path, content: f.delete ? null : (f.content as string), original });
      }
      const [p] = await ctx.db.query<{ id: string }>(
        `INSERT INTO hq_change_proposals (task_id, employee_id, repo, base_branch, title, description, files) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [env.taskId, env.employee.id, repo, defaultBranch, i.title, i.description, JSON.stringify(files)]
      );
      await ctx.db.query(
        `INSERT INTO hq_approvals (kind, title, description, payload, employee_id, task_id) VALUES ('code_change', $1, $2, $3, $4, $5)`,
        [`Code change: ${i.title}`, i.description, JSON.stringify({ proposalId: p.id, repo }), env.employee.id, env.taskId]
      );
      await audit(ctx.db, { type: 'employee', id: env.employee.id }, 'github.change_proposed', 'change_proposal', p.id, { repo, files: files.map((f) => f.path) });
      await notify(ctx, 'approval', `${env.employee.name} proposed a code change`, i.title, `/approvals`);
      return `Change proposal ${p.id} created with ${files.length} file(s). It now waits for the owner's review; it is NOT committed. Mention it in your deliverable.`;
    }
  }),
  tool({
    name: 'github_request_issue',
    permission: 'github.issue',
    description: 'Request that a GitHub issue be created. The owner approves it before it is created.',
    input: z.object({ repo: Repo, title: z.string().min(5).max(200), body: z.string().min(10).max(20_000), labels: z.array(z.string().max(50)).max(5).default([]) }),
    status: ['writing', 'Drafting a GitHub issue'],
    sideEffect: true,
    async run(ctx, env, i) {
      const { repo } = await readableRepo(ctx, env, i.repo);
      await ctx.db.query(`INSERT INTO hq_approvals (kind, title, description, payload, employee_id, task_id) VALUES ('github_issue', $1, $2, $3, $4, $5)`, [
        `GitHub issue: ${i.title}`,
        i.body.slice(0, 2000),
        JSON.stringify({ repo, title: i.title, body: i.body, labels: i.labels }),
        env.employee.id,
        env.taskId
      ]);
      await notify(ctx, 'approval', `${env.employee.name} requested a GitHub issue`, i.title, `/approvals`);
      return 'Issue request submitted for owner approval. It is not created yet.';
    }
  }),
  tool({
    name: 'request_external_publish',
    permission: 'external.publish',
    description: 'Ask the owner to approve publishing content externally (social post, email, website copy). HQ has no publishing integration; approved content is handed to the owner to publish.',
    input: z.object({ channel: z.string().min(2).max(60), content: z.string().min(5).max(20_000), notes: z.string().max(2000).default('') }),
    status: ['waiting_approval', 'Waiting for publishing approval'],
    sideEffect: true,
    async run(ctx, env, i) {
      await ctx.db.query(`INSERT INTO hq_approvals (kind, title, description, payload, employee_id, task_id) VALUES ('external_publish', $1, $2, $3, $4, $5)`, [
        `Publish on ${i.channel}`,
        i.notes,
        JSON.stringify(i),
        env.employee.id,
        env.taskId
      ]);
      await notify(ctx, 'approval', `${env.employee.name} wants to publish on ${i.channel}`, i.content.slice(0, 200), '/approvals');
      return 'Publishing request submitted for owner approval. Nothing was published.';
    }
  })
];

/** The tools an employee may use: their permissions, minus tools the run kind excludes. */
export function toolsFor(employee: { tools: string[] }, opts: { allowSideEffects: boolean }): Tool[] {
  return TOOLS.filter((t) => employee.tools.includes(t.permission) && (opts.allowSideEffects || !t.sideEffect));
}
