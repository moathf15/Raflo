import { createTwoFilesPatch } from 'diff';
import type { Ctx } from '../context';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/http';
import { getSetting } from '../lib/settings';
import { githubClient, isRepoName, safePath, type GitHub } from './client';

export interface Connection {
  gh: GitHub;
  login: string;
}

/** The connected GitHub account, or null when the owner has not connected one. */
export async function connection(ctx: Ctx): Promise<Connection | null> {
  const [row] = await ctx.db.query<{ token_enc: string; meta: { login?: string } }>(`SELECT token_enc, meta FROM hq_integrations WHERE kind = 'github'`);
  if (!row) return null;
  return { gh: githubClient(ctx.vault.decrypt(row.token_enc), { apiUrl: ctx.cfg.GITHUB_API_URL, fetch: ctx.githubFetch }), login: row.meta.login ?? '' };
}

export async function requireConnection(ctx: Ctx): Promise<Connection> {
  const c = await connection(ctx);
  if (!c) throw new HttpError(409, 'github_not_connected', 'Connect GitHub in the GitHub screen first.');
  return c;
}

/** Repositories the owner has authorised for agents. */
export async function allowedRepos(ctx: Ctx) {
  return ctx.db.query<{ full_name: string; default_branch: string; private: boolean }>('SELECT full_name, default_branch, private FROM hq_repos WHERE allowed ORDER BY added_at');
}

export async function authorisedRepo(ctx: Ctx, repo: string) {
  if (!isRepoName(repo)) throw new HttpError(400, 'invalid_repo');
  const [r] = await ctx.db.query<{ full_name: string; default_branch: string }>('SELECT full_name, default_branch FROM hq_repos WHERE allowed AND lower(full_name) = lower($1)', [repo]);
  if (!r) throw new HttpError(403, 'repo_not_authorised', `${repo} is not authorised for agents.`);
  return r;
}

/** A branch name HQ may create: under hq/, never the default branch or a protected one. */
export async function assertWritableBranch(ctx: Ctx, repo: { default_branch: string }, branch: string) {
  const policy = await getSetting(ctx.db, 'policy');
  if (!/^hq\/[A-Za-z0-9._\-/]{1,120}$/.test(branch) || branch.includes('..')) throw new HttpError(400, 'invalid_branch', 'HQ only writes to branches named hq/…');
  const lower = branch.toLowerCase();
  if (lower === repo.default_branch.toLowerCase() || policy.protectedBranches.some((p) => p.toLowerCase() === lower)) throw new HttpError(403, 'protected_branch');
}

export interface ProposalFile {
  path: string;
  content: string | null;
  original: string | null;
}

/** Unified diff of a change proposal, for the owner's preview. */
export function proposalDiff(files: ProposalFile[]): string {
  return files
    .map((f) => createTwoFilesPatch(f.original === null ? '/dev/null' : `a/${f.path}`, f.content === null ? '/dev/null' : `b/${f.path}`, f.original ?? '', f.content ?? '', '', '', { context: 3 }))
    .join('\n');
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'change';

/**
 * Commit an approved change proposal to a new hq/* branch created from the base branch's current head.
 * Never writes to an existing branch, the default branch or a protected branch.
 */
export async function createBranchForProposal(ctx: Ctx, proposalId: string, ownerId: string) {
  const policy = await getSetting(ctx.db, 'policy');
  if (!policy.githubWriteBranches) throw new HttpError(403, 'branch_writes_disabled', 'Enable "Create hq/* branches" in Settings → Permissions first.');
  const [p] = await ctx.db.query<{ id: string; repo: string; base_branch: string; title: string; description: string; files: ProposalFile[]; status: string }>(
    'SELECT * FROM hq_change_proposals WHERE id = $1',
    [proposalId]
  );
  if (!p) throw new HttpError(404, 'not_found');
  if (p.status !== 'proposed') throw new HttpError(409, 'invalid_state');
  const repo = await authorisedRepo(ctx, p.repo);
  const { gh } = await requireConnection(ctx);
  const branch = `hq/${slugify(p.title)}-${p.id.slice(0, 8)}`;
  await assertWritableBranch(ctx, repo, branch);
  try {
    const head = (await gh.ref(p.repo, p.base_branch)).object.sha;
    const baseCommit = await gh.commit(p.repo, head);
    const tree = await gh.createTree(
      p.repo,
      baseCommit.tree.sha,
      p.files.map((f) => ({ path: safePath(f.path), content: f.content }))
    );
    const commit = await gh.createCommit(p.repo, `${p.title}\n\n${p.description}\n\nProposed in Raflo AI HQ, approved by the owner.`.slice(0, 5000), tree.sha, head);
    await gh.createRef(p.repo, branch, commit.sha);
    await ctx.db.query(`UPDATE hq_change_proposals SET status = 'branch_created', branch = $2, base_sha = $3, commit_sha = $4, updated_at = now() WHERE id = $1`, [p.id, branch, head, commit.sha]);
    await audit(ctx.db, { type: 'owner', id: ownerId }, 'github.branch_created', 'change_proposal', p.id, { repo: p.repo, branch, commit: commit.sha });
    return { branch, commit: commit.sha };
  } catch (e) {
    await ctx.db.query(`UPDATE hq_change_proposals SET error = $2, updated_at = now() WHERE id = $1`, [p.id, (e as Error).message]);
    throw e;
  }
}
