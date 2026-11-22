import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../App';
import { EmployeeSelect } from '../components/dialogs';
import { Button, Card, Empty, ErrorBox, Field, Loading, Modal, Pill, StatusPill, Tabs } from '../components/ui';
import { api, useAction, useApi } from '../lib/api';
import { fmtDateTime, timeAgo } from '../lib/format';
import { useI18n } from '../lib/i18n';
import type { Employee } from '../lib/types';
import { Diff } from './Approvals';

interface Status {
  connected: boolean;
  account: { login: string; avatar: string; method: string } | null;
  oauthAvailable: boolean;
  repos: { full_name: string; default_branch: string; private: boolean; allowed: boolean }[];
  policy: { githubRead: boolean; githubWriteBranches: boolean; githubPullRequests: boolean; githubMerge: boolean };
}

/** Real GitHub integration: connect, authorise repositories, browse, assign issues and review pull requests. */
export function GitHubPage() {
  const s = useApi<Status>('/github/status');
  const [token, setToken] = useState('');
  const act = useAction();
  const [repo, setRepo] = useState<string | null>(null);
  if (!s.data) return s.error ? <ErrorBox error={s.error} onRetry={s.reload} /> : <Loading />;
  const allowed = s.data.repos.filter((r) => r.allowed);
  const current = repo ?? allowed[0]?.full_name ?? null;
  return (
    <Page title="GitHub">
      {!s.data.connected ? (
        <Card title="Connect GitHub">
          <p>Agents only read repositories you authorise. Writing (branches, pull requests, merges, issues) always requires your approval and is controlled in Settings → Permissions.</p>
          {s.data.oauthAvailable ? (
            <a className="btn btn-primary" href="/hq/v1/github/oauth/start">
              Connect with GitHub
            </a>
          ) : (
            <p className="small muted">OAuth is not configured on the server (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET). You can paste a token instead.</p>
          )}
          <Field label="Fine-grained personal access token" hint="Recommended permissions, for the Raflo repository only: Contents (read; read & write only if you enable branch creation), Issues (read & write), Pull requests (read & write), Checks (read), Metadata (read). The token is verified, then stored encrypted.">
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          </Field>
          <ErrorBox error={act.error} />
          <Button variant="primary" disabled={token.length < 20 || act.busy} onClick={() => act.run(() => api('/github/token', { body: { token } })).then((r) => r && (setToken(''), s.reload()))}>
            Verify and connect
          </Button>
        </Card>
      ) : (
        <>
          <Card
            title={
              <span className="row gap-2">
                {s.data.account?.avatar ? <img src={s.data.account.avatar} alt="" width={24} height={24} className="round" /> : null} Connected as {s.data.account?.login}
              </span>
            }
            actions={
              <Button small variant="danger" onClick={() => confirm('Disconnect GitHub? Agents lose repository access.') && void api('/github', { method: 'DELETE' }).then(s.reload)}>
                Disconnect
              </Button>
            }
          >
            <div className="row gap-2 wrap small">
              <Pill tone={s.data.policy.githubRead ? 'good' : 'muted'}>read {s.data.policy.githubRead ? 'on' : 'off'}</Pill>
              <Pill tone={s.data.policy.githubWriteBranches ? 'warn' : 'muted'}>hq/* branches {s.data.policy.githubWriteBranches ? 'on' : 'off'}</Pill>
              <Pill tone={s.data.policy.githubPullRequests ? 'warn' : 'muted'}>pull requests {s.data.policy.githubPullRequests ? 'on' : 'off'}</Pill>
              <Pill tone={s.data.policy.githubMerge ? 'bad' : 'muted'}>merge {s.data.policy.githubMerge ? 'on' : 'off'}</Pill>
              <Link to="/settings">Change in Settings</Link>
            </div>
            <RepoPicker authorised={s.data.repos} onChange={s.reload} />
          </Card>
          {allowed.length ? (
            <>
              <div className="toolbar">
                <select value={current ?? ''} onChange={(e) => setRepo(e.target.value)} aria-label="Repository">
                  {allowed.map((r) => (
                    <option key={r.full_name}>{r.full_name}</option>
                  ))}
                </select>
              </div>
              {current ? <RepoView repo={current} /> : null}
            </>
          ) : null}
        </>
      )}
    </Page>
  );
}

function RepoPicker({ authorised, onChange }: { authorised: Status['repos']; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const avail = useApi<{ full_name: string; private: boolean; description: string | null; authorised: boolean }[]>(open ? '/github/available' : null);
  const [name, setName] = useState('moathf15/Raflo');
  const act = useAction();
  const set = (repo: string, allowed: boolean) => act.run(() => api('/github/repos', { body: { repo, allowed } })).then(() => (onChange(), avail.reload()));
  return (
    <div>
      <h3>Authorised repositories</h3>
      {authorised.length ? (
        <ul className="list">
          {authorised.map((r) => (
            <li key={r.full_name} className="row between">
              <span>
                <code>{r.full_name}</code> <span className="small muted">default branch {r.default_branch}</span> {r.private ? <Pill tone="muted">private</Pill> : null}
              </span>
              <Button small variant={r.allowed ? 'ghost' : 'default'} onClick={() => set(r.full_name, !r.allowed)}>
                {r.allowed ? 'Revoke' : 'Authorise'}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">None yet.</p>
      )}
      <div className="row gap-2 wrap">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="owner/repository" />
        <Button variant="primary" small disabled={act.busy} onClick={() => set(name, true)}>
          Authorise repository
        </Button>
        <Button small onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Browse my repositories'}
        </Button>
      </div>
      <ErrorBox error={act.error} />
      {open ? (
        avail.data ? (
          <ul className="list">
            {avail.data.map((r) => (
              <li key={r.full_name} className="row between">
                <span>
                  <code>{r.full_name}</code> <span className="small muted">{r.description}</span>
                </span>
                {r.authorised ? <Pill tone="good">authorised</Pill> : <Button small onClick={() => set(r.full_name, true)}>Authorise</Button>}
              </li>
            ))}
          </ul>
        ) : (
          <ErrorBox error={avail.error} />
        )
      ) : null}
    </div>
  );
}

type RepoTab = 'pulls' | 'issues' | 'commits' | 'branches' | 'activity' | 'code';

function RepoView({ repo }: { repo: string }) {
  const [tab, setTab] = useState<RepoTab>('pulls');
  const r = encodeURIComponent(repo);
  return (
    <Card>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'pulls', label: 'Pull requests' },
          { id: 'issues', label: 'Issues' },
          { id: 'commits', label: 'Commits' },
          { id: 'branches', label: 'Branches' },
          { id: 'activity', label: 'Activity' },
          { id: 'code', label: 'Code' }
        ]}
      />
      {tab === 'pulls' ? <Pulls repo={repo} q={r} /> : null}
      {tab === 'issues' ? <Issues repo={repo} q={r} /> : null}
      {tab === 'commits' ? <Commits q={r} /> : null}
      {tab === 'branches' ? <Branches q={r} /> : null}
      {tab === 'activity' ? <Activity q={r} /> : null}
      {tab === 'code' ? <Code q={r} /> : null}
    </Card>
  );
}

function Pulls({ repo, q }: { repo: string; q: string }) {
  const { lang } = useI18n();
  const [state, setState] = useState('open');
  const list = useApi<{ number: number; title: string; state: string; draft: boolean; user: { login: string }; head: { ref: string }; base: { ref: string }; updated_at: string; html_url: string }[]>(`/github/pulls?repo=${q}&state=${state}`);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <select value={state} onChange={(e) => setState(e.target.value)} aria-label="State">
        <option value="open">Open</option>
        <option value="closed">Closed</option>
        <option value="all">All</option>
      </select>
      <ErrorBox error={list.error} />
      {list.data?.length ? (
        <ul className="list">
          {list.data.map((p) => (
            <li key={p.number}>
              <button className="link-btn" onClick={() => setOpen(p.number)}>
                #{p.number} {p.title}
              </button>{' '}
              {p.draft ? <Pill tone="muted">draft</Pill> : null} <span className="small muted">
                {p.user.login} · {p.head.ref} → {p.base.ref} · {timeAgo(p.updated_at, lang)}
              </span>
            </li>
          ))}
        </ul>
      ) : list.data ? (
        <Empty>No pull requests.</Empty>
      ) : (
        <Loading />
      )}
      {open ? <PullDialog repo={repo} q={q} number={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function PullDialog({ repo, q, number, onClose }: { repo: string; q: string; number: number; onClose: () => void }) {
  const d = useApi<{ pr: { title: string; body: string | null; html_url: string; state: string; merged: boolean; head: { sha: string } }; files: { filename: string; status: string; additions: number; deletions: number; patch?: string }[]; checks: { check_runs: { id: number; name: string; status: string; conclusion: string | null; html_url: string }[] } }>(`/github/pull?repo=${q}&number=${number}`);
  const emps = useApi<Employee[]>('/employees');
  const [reviewer, setReviewer] = useState('');
  const act = useAction();
  return (
    <Modal title={`#${number} ${d.data?.pr.title ?? ''}`} onClose={onClose} wide>
      {d.data ? (
        <>
          <p className="small">
            <a href={d.data.pr.html_url} target="_blank" rel="noopener noreferrer">
              Open on GitHub
            </a>{' '}
            · {d.data.pr.merged ? 'merged' : d.data.pr.state}
          </p>
          <h3>CI checks</h3>
          {d.data.checks.check_runs.length ? (
            <ul className="list">
              {d.data.checks.check_runs.map((c) => (
                <li key={c.id}>
                  <StatusPill status={c.conclusion === 'success' ? 'completed' : c.conclusion === 'failure' ? 'blocked' : 'in_progress'} label={c.conclusion ?? c.status} /> {c.name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No checks reported.</p>
          )}
          <h3>Ask for a code review report</h3>
          <div className="row gap-2">
            <EmployeeSelect value={reviewer} onChange={setReviewer} employees={(emps.data ?? []).filter((e) => e.tools.includes('github.read'))} allowEmpty="Choose a reviewer…" label="Reviewer" />
            <Button
              variant="primary"
              disabled={!reviewer || act.busy}
              onClick={async () => {
                const r = await act.run(() => api<{ id: string }>('/github/pulls/review', { body: { repo, number, assignee_id: reviewer } }));
                if (r) window.location.assign(`/tasks/${r.id}`);
              }}
            >
              Request review
            </Button>
          </div>
          <ErrorBox error={act.error} />
          <h3>Changed files ({d.data.files.length})</h3>
          {d.data.files.map((f) => (
            <details key={f.filename}>
              <summary>
                <code>{f.filename}</code> <span className="small muted">+{f.additions} −{f.deletions}</span>
              </summary>
              <Diff text={f.patch ?? '(binary or too large)'} />
            </details>
          ))}
        </>
      ) : d.error ? (
        <ErrorBox error={d.error} />
      ) : (
        <Loading />
      )}
    </Modal>
  );
}

function Issues({ repo, q }: { repo: string; q: string }) {
  const { lang } = useI18n();
  const list = useApi<{ number: number; title: string; state: string; user: { login: string }; labels: { name: string }[]; updated_at: string; html_url: string }[]>(`/github/issues?repo=${q}`);
  const emps = useApi<Employee[]>('/employees');
  const [assign, setAssign] = useState<number | null>(null);
  const [who, setWho] = useState({ assignee: '', reviewer: '' });
  const act = useAction();
  return (
    <>
      <ErrorBox error={list.error} />
      {list.data?.length ? (
        <ul className="list">
          {list.data.map((i) => (
            <li key={i.number} className="row between gap-2">
              <span>
                <a href={i.html_url} target="_blank" rel="noopener noreferrer">
                  #{i.number} {i.title}
                </a>{' '}
                {i.labels.map((l) => (
                  <Pill key={l.name} tone="muted">
                    {l.name}
                  </Pill>
                ))}{' '}
                <span className="small muted">{timeAgo(i.updated_at, lang)}</span>
              </span>
              <Button small onClick={() => setAssign(i.number)}>
                Assign to employee
              </Button>
            </li>
          ))}
        </ul>
      ) : list.data ? (
        <Empty>No open issues.</Empty>
      ) : (
        <Loading />
      )}
      {assign ? (
        <Modal title={`Assign issue #${assign}`} onClose={() => setAssign(null)}>
          <div className="form">
            <Field label="Assignee">
              <EmployeeSelect value={who.assignee} onChange={(v) => setWho({ ...who, assignee: v })} employees={emps.data ?? []} allowEmpty="Choose…" />
            </Field>
            <Field label="Independent reviewer (optional)">
              <EmployeeSelect value={who.reviewer} onChange={(v) => setWho({ ...who, reviewer: v })} employees={emps.data ?? []} allowEmpty="None" exclude={who.assignee} />
            </Field>
            <ErrorBox error={act.error} />
            <Button
              variant="primary"
              disabled={!who.assignee || act.busy}
              onClick={async () => {
                const r = await act.run(() => api<{ id: string }>('/github/issues/assign', { body: { repo, number: assign, assignee_id: who.assignee, reviewer_id: who.reviewer || null } }));
                if (r) window.location.assign(`/tasks/${r.id}`);
              }}
            >
              Create task
            </Button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function Commits({ q }: { q: string }) {
  const { lang } = useI18n();
  const list = useApi<{ sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } } }[]>(`/github/commits?repo=${q}`);
  if (!list.data) return list.error ? <ErrorBox error={list.error} /> : <Loading />;
  return (
    <ul className="list">
      {list.data.map((c) => (
        <li key={c.sha}>
          <a href={c.html_url} target="_blank" rel="noopener noreferrer">
            <code>{c.sha.slice(0, 7)}</code>
          </a>{' '}
          {c.commit.message.split('\n')[0]} <span className="small muted">
            {c.commit.author.name} · {fmtDateTime(c.commit.author.date, lang)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Branches({ q }: { q: string }) {
  const list = useApi<{ name: string; protected: boolean; commit: { sha: string } }[]>(`/github/branches?repo=${q}`);
  if (!list.data) return list.error ? <ErrorBox error={list.error} /> : <Loading />;
  return (
    <ul className="list">
      {list.data.map((b) => (
        <li key={b.name}>
          <code>{b.name}</code> {b.protected ? <Pill tone="warn">protected</Pill> : null} {b.name.startsWith('hq/') ? <Pill tone="violet">HQ</Pill> : null} <span className="small muted">{b.commit.sha.slice(0, 7)}</span>
        </li>
      ))}
    </ul>
  );
}

function Activity({ q }: { q: string }) {
  const { lang } = useI18n();
  const list = useApi<{ id: string; type: string; actor: { login: string }; created_at: string }[]>(`/github/events?repo=${q}`);
  if (!list.data) return list.error ? <ErrorBox error={list.error} /> : <Loading />;
  return list.data.length ? (
    <ul className="list">
      {list.data.map((e) => (
        <li key={e.id}>
          <strong>{e.actor.login}</strong> {e.type.replace(/Event$/, '')} <span className="small muted">{timeAgo(e.created_at, lang)}</span>
        </li>
      ))}
    </ul>
  ) : (
    <Empty>No recent activity.</Empty>
  );
}

function Code({ q }: { q: string }) {
  const tree = useApi<{ files: { path: string; size: number }[]; truncated: boolean }>(`/github/tree?repo=${q}`);
  const [filter, setFilter] = useState('');
  const [path, setPath] = useState<string | null>(null);
  const file = useApi<{ content: string; path: string }>(path ? `/github/file?repo=${q}&path=${encodeURIComponent(path)}` : null);
  if (!tree.data) return tree.error ? <ErrorBox error={tree.error} /> : <Loading />;
  const files = tree.data.files.filter((f) => !f.path.includes('node_modules') && f.path.toLowerCase().includes(filter.toLowerCase())).slice(0, 300);
  return (
    <div className="code-browser">
      <div>
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files…" aria-label="Filter files" />
        <ul className="file-list">
          {files.map((f) => (
            <li key={f.path}>
              <button className={`link-btn${path === f.path ? ' active' : ''}`} onClick={() => setPath(f.path)}>
                {f.path}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div>{path ? file.data ? <pre className="code-view" dir="ltr">{file.data.content}</pre> : file.error ? <ErrorBox error={file.error} /> : <Loading /> : <Empty>Select a file.</Empty>}</div>
    </div>
  );
}
