import { z } from 'zod';
import { emitTask } from '../context';
import { exchangeOAuthCode, githubClient, GitHubError, isRepoName } from '../github/client';
import { assertWritableBranch, authorisedRepo, proposalDiff, requireConnection, type ProposalFile } from '../github/service';
import { audit } from '../lib/audit';
import { randomToken } from '../lib/crypto';
import { HttpError, notFound } from '../lib/http';
import { getSetting } from '../lib/settings';
import { idParam, type Module } from './core';

const repoQuery = (q: unknown) => {
  const { repo } = z.object({ repo: z.string().max(201) }).parse(q);
  if (!isRepoName(repo)) throw new HttpError(400, 'invalid_repo');
  return repo;
};

/** GitHub errors become clear 4xx/502 responses instead of 500s. */
async function gh<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GitHubError) throw new HttpError(e.status === 401 ? 502 : e.status >= 500 ? 502 : e.status, 'github_error', e.message);
    throw e;
  }
}

export const githubModule: Module = (app, ctx, auth) => {
  app.get('/hq/v1/github/status', async (req) => {
    await auth.viewer(req);
    const [row] = await ctx.db.query<{ meta: Record<string, unknown>; created_at: string }>(`SELECT meta, created_at FROM hq_integrations WHERE kind = 'github'`);
    const repos = await ctx.db.query('SELECT * FROM hq_repos ORDER BY added_at');
    return {
      connected: !!row,
      account: row?.meta ?? null,
      connectedAt: row?.created_at ?? null,
      oauthAvailable: !!(ctx.cfg.GITHUB_CLIENT_ID && ctx.cfg.GITHUB_CLIENT_SECRET),
      repos,
      policy: await getSetting(ctx.db, 'policy')
    };
  });

  /** Connect with a token (fine-grained personal access token or GitHub App user token). Verified before it is stored. */
  app.post('/hq/v1/github/token', async (req) => {
    const o = await auth.owner(req);
    const { token } = z.object({ token: z.string().min(20).max(500) }).parse(req.body);
    const me = await gh(() => githubClient(token, { apiUrl: ctx.cfg.GITHUB_API_URL, fetch: ctx.githubFetch }).me());
    await ctx.db.query(
      `INSERT INTO hq_integrations (kind, token_enc, meta) VALUES ('github', $1, $2) ON CONFLICT (kind) DO UPDATE SET token_enc = $1, meta = $2, created_at = now()`,
      [ctx.vault.encrypt(token), JSON.stringify({ login: me.login, avatar: me.avatar_url, method: 'token' })]
    );
    await audit(ctx.db, { type: 'owner', id: o.id }, 'github.connect', 'integration', 'github', { login: me.login, method: 'token' });
    return { login: me.login };
  });

  app.get('/hq/v1/github/oauth/start', async (req, reply) => {
    const o = await auth.owner(req);
    if (!ctx.cfg.GITHUB_CLIENT_ID) throw new HttpError(409, 'oauth_not_configured');
    const state = randomToken(24);
    await ctx.db.query('INSERT INTO hq_oauth_states (state, owner_id) VALUES ($1, $2)', [state, o.id]);
    const redirect = `${ctx.cfg.HQ_PUBLIC_URL.replace(/\/$/, '')}/hq/v1/github/oauth/callback`;
    // GitHub App user tokens get the app's fine-grained permissions; for an OAuth App, `repo` is the minimum for private repositories.
    const url = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(ctx.cfg.GITHUB_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirect)}&state=${state}&scope=${encodeURIComponent('repo read:user')}`;
    return reply.redirect(url);
  });

  // GitHub redirects here cross-site, so the SameSite=Strict session cookie is not sent: the single-use,
  // 10-minute state created by the signed-in owner is what authorises the callback.
  app.get('/hq/v1/github/oauth/callback', async (req, reply) => {
    const q = z.object({ code: z.string().min(1).max(200), state: z.string().min(10).max(100) }).parse(req.query);
    const [s] = await ctx.db.query<{ owner_id: string }>(`DELETE FROM hq_oauth_states WHERE state = $1 AND created_at > now() - interval '10 minutes' RETURNING owner_id`, [q.state]);
    if (!s) throw new HttpError(400, 'invalid_state');
    const o = { id: s.owner_id };
    const token = await gh(() => exchangeOAuthCode(ctx.cfg.GITHUB_CLIENT_ID!, ctx.cfg.GITHUB_CLIENT_SECRET!, q.code, ctx.githubFetch));
    const me = await gh(() => githubClient(token, { apiUrl: ctx.cfg.GITHUB_API_URL, fetch: ctx.githubFetch }).me());
    await ctx.db.query(
      `INSERT INTO hq_integrations (kind, token_enc, meta) VALUES ('github', $1, $2) ON CONFLICT (kind) DO UPDATE SET token_enc = $1, meta = $2, created_at = now()`,
      [ctx.vault.encrypt(token), JSON.stringify({ login: me.login, avatar: me.avatar_url, method: 'oauth' })]
    );
    await audit(ctx.db, { type: 'owner', id: o.id }, 'github.connect', 'integration', 'github', { login: me.login, method: 'oauth' });
    return reply.redirect('/github');
  });

  app.delete('/hq/v1/github', async (req) => {
    const o = await auth.owner(req);
    await ctx.db.query(`DELETE FROM hq_integrations WHERE kind = 'github'`);
    await audit(ctx.db, { type: 'owner', id: o.id }, 'github.disconnect', 'integration', 'github');
    return { ok: true };
  });

  /** Repositories the token can see, marked when authorised for agents. */
  app.get('/hq/v1/github/available', async (req) => {
    await auth.owner(req);
    const { gh: client } = await requireConnection(ctx);
    const repos = await gh(() => client.listRepos());
    const allowed = new Set((await ctx.db.query<{ full_name: string }>('SELECT full_name FROM hq_repos WHERE allowed')).map((r) => r.full_name.toLowerCase()));
    return repos.map((r) => ({ full_name: r.full_name, private: r.private, default_branch: r.default_branch, description: r.description, pushed_at: r.pushed_at, authorised: allowed.has(r.full_name.toLowerCase()) }));
  });

  app.post('/hq/v1/github/repos', async (req) => {
    const o = await auth.owner(req);
    const b = z.object({ repo: z.string().max(201), allowed: z.boolean().default(true) }).parse(req.body);
    if (!isRepoName(b.repo)) throw new HttpError(400, 'invalid_repo');
    const { gh: client } = await requireConnection(ctx);
    const r = await gh(() => client.repo(b.repo));
    await ctx.db.query(
      `INSERT INTO hq_repos (full_name, default_branch, private, allowed) VALUES ($1, $2, $3, $4) ON CONFLICT (full_name) DO UPDATE SET allowed = $4, default_branch = $2, private = $3`,
      [r.full_name, r.default_branch, r.private, b.allowed]
    );
    await audit(ctx.db, { type: 'owner', id: o.id }, b.allowed ? 'github.repo_authorise' : 'github.repo_revoke', 'repo', r.full_name);
    return { ok: true, repo: r.full_name, default_branch: r.default_branch };
  });

  // Read-only views of an authorised repository.
  const view = (path: string, fn: (repo: string, q: Record<string, string>) => Promise<unknown>) =>
    app.get(`/hq/v1/github/${path}`, async (req) => {
      await auth.viewer(req);
      const repo = repoQuery(req.query);
      await authorisedRepo(ctx, repo);
      return gh(() => fn(repo, req.query as Record<string, string>));
    });
  view('branches', async (repo) => (await requireConnection(ctx)).gh.branches(repo));
  view('commits', async (repo, q) => (await requireConnection(ctx)).gh.commits(repo, q.ref));
  view('issues', async (repo, q) => ((await (await requireConnection(ctx)).gh.issues(repo, q.state ?? 'open')) as { pull_request?: unknown }[]).filter((i) => !i.pull_request));
  view('pulls', async (repo, q) => (await requireConnection(ctx)).gh.pulls(repo, q.state ?? 'open'));
  view('events', async (repo) => (await requireConnection(ctx)).gh.events(repo));
  view('pull', async (repo, q) => {
    const n = z.coerce.number().int().positive().parse(q.number);
    const { gh: c } = await requireConnection(ctx);
    const [pr, files] = await Promise.all([c.pull(repo, n), c.pullFiles(repo, n)]);
    const checks = await c.checkRuns(repo, pr.head.sha).catch(() => ({ total_count: 0, check_runs: [] }));
    return { pr, files, checks };
  });
  view('checks', async (repo, q) => (await requireConnection(ctx)).gh.checkRuns(repo, z.string().min(1).max(200).parse(q.ref)));
  view('tree', async (repo, q) => {
    const r = await authorisedRepo(ctx, repo);
    const t = await (await requireConnection(ctx)).gh.tree(repo, q.ref || r.default_branch);
    return { truncated: t.truncated, files: t.tree.filter((f) => f.type === 'blob').map((f) => ({ path: f.path, size: f.size })) };
  });
  view('file', async (repo, q) => (await requireConnection(ctx)).gh.file(repo, z.string().min(1).max(500).parse(q.path), q.ref || undefined));

  /** Assign a GitHub issue to an employee as a task. The issue text is passed to the agent as untrusted input. */
  app.post('/hq/v1/github/issues/assign', async (req) => {
    const o = await auth.owner(req);
    const b = z.object({ repo: z.string().max(201), number: z.number().int().positive(), assignee_id: z.uuid(), reviewer_id: z.uuid().nullable().default(null), project_id: z.uuid().nullable().default(null) }).parse(req.body);
    await authorisedRepo(ctx, b.repo);
    const { gh: c } = await requireConnection(ctx);
    const issue = await gh(() => c.issue(b.repo, b.number));
    const [t] = await ctx.db.query<{ id: string }>(
      `INSERT INTO hq_tasks (project_id, title, description, status, queue, assignee_id, reviewer_id, github_issue, created_by) VALUES ($1, $2, $3, 'assigned', 'execute', $4, $5, $6, 'owner') RETURNING id`,
      [
        b.project_id,
        `${b.repo}#${issue.number}: ${issue.title}`.slice(0, 200),
        `Work on GitHub issue ${issue.html_url}. Its text is in your context.`,
        b.assignee_id,
        b.reviewer_id,
        JSON.stringify({ repo: b.repo, number: issue.number, title: issue.title, body: issue.body ?? '', url: issue.html_url })
      ]
    );
    await audit(ctx.db, { type: 'owner', id: o.id }, 'github.issue_assigned', 'task', t.id, { repo: b.repo, issue: issue.number });
    await emitTask(ctx, t.id);
    ctx.wake();
    return { id: t.id };
  });

  /** Ask an employee (e.g. the architect or QA) for a code review report of a pull request. */
  app.post('/hq/v1/github/pulls/review', async (req) => {
    const o = await auth.owner(req);
    const b = z.object({ repo: z.string().max(201), number: z.number().int().positive(), assignee_id: z.uuid() }).parse(req.body);
    await authorisedRepo(ctx, b.repo);
    const [t] = await ctx.db.query<{ id: string }>(
      `INSERT INTO hq_tasks (title, description, acceptance_criteria, status, queue, assignee_id, created_by) VALUES ($1, $2, $3, 'assigned', 'execute', $4, 'owner') RETURNING id`,
      [
        `Code review: ${b.repo} PR #${b.number}`,
        `Review pull request #${b.number} in ${b.repo}. Read it with github_read_pull and inspect related files with github_read_file. Produce a code review report.`,
        'Report lists: summary of the change; correctness issues; security issues; maintainability; test coverage; each finding with file/line evidence and severity; a clear merge recommendation.',
        b.assignee_id
      ]
    );
    await audit(ctx.db, { type: 'owner', id: o.id }, 'github.review_requested', 'task', t.id, { repo: b.repo, pr: b.number });
    ctx.wake();
    return { id: t.id };
  });

  // Change proposals (agent-written code awaiting the owner).
  app.get('/hq/v1/proposals', async (req) => {
    await auth.viewer(req);
    return ctx.db.query(
      `SELECT p.id, p.task_id, p.repo, p.base_branch, p.title, p.status, p.branch, p.pr_number, p.pr_url, p.error, p.created_at, e.name AS employee_name, jsonb_array_length(p.files) AS file_count
       FROM hq_change_proposals p LEFT JOIN hq_employees e ON e.id = p.employee_id ORDER BY p.created_at DESC LIMIT 100`
    );
  });
  app.get('/hq/v1/proposals/:id', async (req) => {
    await auth.viewer(req);
    const [p] = await ctx.db.query<{ files: ProposalFile[] } & Record<string, unknown>>(
      'SELECT p.*, e.name AS employee_name FROM hq_change_proposals p LEFT JOIN hq_employees e ON e.id = p.employee_id WHERE p.id = $1',
      [idParam(req.params)]
    );
    if (!p) throw notFound();
    const [approval] = await ctx.db.query(`SELECT id, status FROM hq_approvals WHERE kind = 'code_change' AND payload->>'proposalId' = $1`, [p.id]);
    return { proposal: { ...p, files: p.files.map((f) => ({ path: f.path, change: f.original === null ? 'added' : f.content === null ? 'deleted' : 'modified' })) }, diff: proposalDiff(p.files), approval: approval ?? null };
  });

  /** Open a pull request from an approved proposal's hq/* branch. The click is the owner's explicit approval. */
  app.post('/hq/v1/proposals/:id/pull-request', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    const b = z.object({ draft: z.boolean().default(true) }).parse(req.body ?? {});
    const policy = await getSetting(ctx.db, 'policy');
    if (!policy.githubPullRequests) throw new HttpError(403, 'pull_requests_disabled');
    const [p] = await ctx.db.query<{ id: string; repo: string; base_branch: string; branch: string | null; title: string; description: string; status: string; task_id: string | null }>(
      'SELECT * FROM hq_change_proposals WHERE id = $1',
      [id]
    );
    if (!p) throw notFound();
    if (p.status !== 'branch_created' || !p.branch) throw new HttpError(409, 'invalid_state', 'Approve the code change first (it creates the branch).');
    const repo = await authorisedRepo(ctx, p.repo);
    await assertWritableBranch(ctx, repo, p.branch);
    const { gh: c } = await requireConnection(ctx);
    const pr = await gh(() => c.createPull(p.repo, { title: p.title, body: `${p.description}\n\n---\nProposed by an AI employee in Raflo AI HQ. Opened after explicit owner approval.`, head: p.branch!, base: p.base_branch, draft: b.draft }));
    await ctx.db.query(`UPDATE hq_change_proposals SET status = 'pr_opened', pr_number = $2, pr_url = $3, updated_at = now() WHERE id = $1`, [id, pr.number, pr.html_url]);
    await ctx.db.query(`INSERT INTO hq_approvals (kind, title, payload, status, task_id, decided_by, decided_at, result) VALUES ('pull_request', $1, $2, 'executed', $3, $4, now(), $5)`, [
      `Pull request: ${p.title}`,
      JSON.stringify({ proposalId: id }),
      p.task_id,
      o.id,
      JSON.stringify({ number: pr.number, url: pr.html_url })
    ]);
    await audit(ctx.db, { type: 'owner', id: o.id }, 'github.pr_opened', 'change_proposal', id, { repo: p.repo, number: pr.number });
    return { number: pr.number, url: pr.html_url };
  });

  /** Merge: only when enabled in the policy and confirmed explicitly by typing the PR number. */
  app.post('/hq/v1/proposals/:id/merge', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    const b = z.object({ confirm: z.number().int() }).parse(req.body);
    const policy = await getSetting(ctx.db, 'policy');
    if (!policy.githubMerge) throw new HttpError(403, 'merge_disabled', 'Merging is disabled in Settings → Permissions.');
    const [p] = await ctx.db.query<{ id: string; repo: string; pr_number: number | null; status: string; task_id: string | null; title: string }>('SELECT * FROM hq_change_proposals WHERE id = $1', [id]);
    if (!p?.pr_number || p.status !== 'pr_opened') throw new HttpError(409, 'invalid_state');
    if (b.confirm !== p.pr_number) throw new HttpError(400, 'confirmation_mismatch', 'Type the pull request number to confirm.');
    await authorisedRepo(ctx, p.repo);
    const { gh: c } = await requireConnection(ctx);
    const pr = await gh(() => c.pull(p.repo, p.pr_number!));
    if (pr.draft) throw new HttpError(409, 'draft', 'Mark the pull request ready for review on GitHub first.');
    const res = await gh(() => c.mergePull(p.repo, p.pr_number!, pr.head.sha));
    await ctx.db.query(`UPDATE hq_change_proposals SET status = 'merged', updated_at = now() WHERE id = $1`, [id]);
    await ctx.db.query(`INSERT INTO hq_approvals (kind, title, payload, status, task_id, decided_by, decided_at, result) VALUES ('merge', $1, $2, 'executed', $3, $4, now(), $5)`, [
      `Merge: ${p.title}`,
      JSON.stringify({ proposalId: id }),
      p.task_id,
      o.id,
      JSON.stringify(res)
    ]);
    await audit(ctx.db, { type: 'owner', id: o.id }, 'github.merged', 'change_proposal', id, { repo: p.repo, number: p.pr_number, sha: res.sha });
    return res;
  });
};
