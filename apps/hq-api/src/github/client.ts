/**
 * Minimal GitHub REST client over fetch. Only the calls the HQ needs; every call is authenticated with the token
 * the owner connected (OAuth / GitHub App user token, or a fine-grained token).
 */
export type Fetch = typeof fetch;

export class GitHubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const isRepoName = (s: string) => REPO_RE.test(s) && !s.includes('..');

/** A repository path: relative, no traversal, no control characters. */
export function safePath(p: string): string {
  const clean = p.replace(/^\/+/, '').trim();
  if (clean.length > 500 || /(^|\/)\.\.(\/|$)/.test(clean) || /[\0-\x1f]/.test(clean)) throw new GitHubError(400, 'invalid path');
  return clean;
}

const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');

export function githubClient(token: string, opts: { apiUrl?: string; fetch?: Fetch } = {}) {
  const base = opts.apiUrl ?? 'https://api.github.com';
  const f = opts.fetch ?? fetch;

  async function call<T>(method: string, path: string, body?: unknown, accept = 'application/vnd.github+json'): Promise<T> {
    const res = await f(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'raflo-hq',
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000)
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? msg;
      } catch {
        /* keep raw text */
      }
      throw new GitHubError(res.status, `GitHub ${res.status}: ${msg}`);
    }
    return (accept.includes('json') ? JSON.parse(text) : text) as T;
  }

  const r = (repo: string) => {
    if (!isRepoName(repo)) throw new GitHubError(400, 'invalid repository name');
    return `/repos/${repo}`;
  };

  return {
    me: () => call<{ login: string; id: number; avatar_url: string }>('GET', '/user'),
    listRepos: () => call<GhRepo[]>('GET', '/user/repos?per_page=100&sort=pushed'),
    repo: (repo: string) => call<GhRepo>('GET', r(repo)),
    branches: (repo: string) => call<{ name: string; commit: { sha: string }; protected: boolean }[]>('GET', `${r(repo)}/branches?per_page=100`),
    commits: (repo: string, ref?: string) => call<GhCommit[]>('GET', `${r(repo)}/commits?per_page=30${ref ? `&sha=${encodeURIComponent(ref)}` : ''}`),
    issues: (repo: string, state = 'open') => call<GhIssue[]>('GET', `${r(repo)}/issues?per_page=50&state=${encodeURIComponent(state)}`),
    issue: (repo: string, n: number) => call<GhIssue>('GET', `${r(repo)}/issues/${n}`),
    pulls: (repo: string, state = 'open') => call<GhPull[]>('GET', `${r(repo)}/pulls?per_page=50&state=${encodeURIComponent(state)}`),
    pull: (repo: string, n: number) => call<GhPull>('GET', `${r(repo)}/pulls/${n}`),
    pullFiles: (repo: string, n: number) => call<GhFile[]>('GET', `${r(repo)}/pulls/${n}/files?per_page=100`),
    checkRuns: (repo: string, ref: string) =>
      call<{ total_count: number; check_runs: { id: number; name: string; status: string; conclusion: string | null; html_url: string; started_at: string; completed_at: string | null }[] }>(
        'GET',
        `${r(repo)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=50`
      ),
    events: (repo: string) => call<{ id: string; type: string; actor: { login: string }; created_at: string; payload: Record<string, unknown> }[]>('GET', `${r(repo)}/events?per_page=30`),
    tree: (repo: string, ref: string) => call<{ sha: string; truncated: boolean; tree: { path: string; type: string; size?: number }[] }>('GET', `${r(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`),
    async file(repo: string, path: string, ref?: string): Promise<{ path: string; sha: string; size: number; content: string }> {
      const p = safePath(path);
      const res = await call<{ type: string; encoding?: string; content?: string; sha: string; size: number; path: string }>('GET', `${r(repo)}/contents/${enc(p)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
      if (res.type !== 'file') throw new GitHubError(400, `${p} is not a file`);
      if (res.size > 400_000) throw new GitHubError(413, `${p} is too large to read (${res.size} bytes)`);
      const content = res.encoding === 'base64' && res.content ? Buffer.from(res.content, 'base64').toString('utf8') : (res.content ?? '');
      return { path: res.path, sha: res.sha, size: res.size, content };
    },
    searchCode: (repo: string, q: string) =>
      call<{ total_count: number; items: { path: string; html_url: string }[] }>('GET', `/search/code?per_page=20&q=${encodeURIComponent(`${q} repo:${repo}`)}`),
    createIssue: (repo: string, body: { title: string; body: string; labels?: string[] }) => call<GhIssue>('POST', `${r(repo)}/issues`, body),
    ref: (repo: string, branch: string) => call<{ object: { sha: string } }>('GET', `${r(repo)}/git/ref/heads/${enc(branch)}`),
    commit: (repo: string, sha: string) => call<{ sha: string; tree: { sha: string } }>('GET', `${r(repo)}/git/commits/${sha}`),
    createTree: (repo: string, baseTree: string, files: { path: string; content: string | null }[]) =>
      call<{ sha: string }>('POST', `${r(repo)}/git/trees`, {
        base_tree: baseTree,
        tree: files.map((f) => (f.content === null ? { path: f.path, mode: '100644', type: 'blob', sha: null } : { path: f.path, mode: '100644', type: 'blob', content: f.content }))
      }),
    createCommit: (repo: string, message: string, tree: string, parent: string) => call<{ sha: string }>('POST', `${r(repo)}/git/commits`, { message, tree, parents: [parent] }),
    createRef: (repo: string, branch: string, sha: string) => call<{ ref: string }>('POST', `${r(repo)}/git/refs`, { ref: `refs/heads/${branch}`, sha }),
    createPull: (repo: string, body: { title: string; body: string; head: string; base: string; draft?: boolean }) => call<GhPull>('POST', `${r(repo)}/pulls`, body),
    mergePull: (repo: string, n: number, sha: string) => call<{ merged: boolean; sha: string; message: string }>('PUT', `${r(repo)}/pulls/${n}/merge`, { sha, merge_method: 'squash' })
  };
}

export type GitHub = ReturnType<typeof githubClient>;

export interface GhRepo {
  full_name: string;
  default_branch: string;
  private: boolean;
  description: string | null;
  html_url: string;
  pushed_at: string;
  permissions?: { admin: boolean; push: boolean; pull: boolean };
}
export interface GhCommit {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name: string; date: string } };
  author: { login: string } | null;
}
export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user: { login: string };
  labels: { name: string }[];
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}
export interface GhPull {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  html_url: string;
  user: { login: string };
  head: { ref: string; sha: string };
  base: { ref: string };
  created_at: string;
  updated_at: string;
}
export interface GhFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/** Exchange an OAuth `code` for a user token (OAuth App or GitHub App user-to-server flow). */
export async function exchangeOAuthCode(clientId: string, clientSecret: string, code: string, f: Fetch = fetch): Promise<string> {
  const res = await f('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'raflo-hq' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    signal: AbortSignal.timeout(15_000)
  });
  const body = (await res.json()) as { access_token?: string; error_description?: string };
  if (!body.access_token) throw new GitHubError(400, body.error_description ?? 'GitHub did not return a token');
  return body.access_token;
}
