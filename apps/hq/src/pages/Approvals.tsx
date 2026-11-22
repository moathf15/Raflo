import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Page } from '../App';
import { Markdown } from '../components/Markdown';
import { Button, Card, Empty, ErrorBox, Loading, Modal, Pill, StatusPill, Tabs } from '../components/ui';
import { api, useAction, useApi } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useI18n } from '../lib/i18n';

interface Approval {
  id: string;
  kind: string;
  title: string;
  description: string;
  payload: Record<string, unknown>;
  status: string;
  employee_name: string | null;
  task_id: string | null;
  task_title: string | null;
  decision_note: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  decided_at: string | null;
}

const KIND_LABEL: Record<string, string> = {
  plan: 'Execution plan',
  code_change: 'Code change',
  github_issue: 'GitHub issue',
  external_publish: 'External publishing',
  owner_decision: 'Decision',
  pull_request: 'Pull request',
  merge: 'Merge'
};

/** Every action with outside effect waits here for the owner. */
export function ApprovalsPage() {
  const { lang } = useI18n();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'pending' | 'all' | 'changes'>(params.get('proposal') ? 'changes' : 'pending');
  const list = useApi<Approval[]>(`/approvals?status=${tab === 'pending' ? 'pending' : 'all'}`, ['approvals.changed', 'notification', 'task']);
  const proposals = useApi<{ id: string; title: string; repo: string; status: string; branch: string | null; pr_url: string | null; employee_name: string | null; file_count: number; created_at: string }[]>('/proposals', ['approvals.changed', 'notification']);
  const openProposal = params.get('proposal');
  return (
    <Page title="Approvals">
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'pending', label: 'Waiting for you' }, { id: 'changes', label: 'Code changes' }, { id: 'all', label: 'History' }]} />
      {tab !== 'changes' ? (
        <>
          <ErrorBox error={list.error} onRetry={list.reload} />
          {!list.data ? <Loading /> : list.data.length ? list.data.map((a) => <ApprovalCard key={a.id} a={a} onDone={list.reload} onDiff={(id) => setParams({ proposal: id })} />) : <Empty>Nothing waiting for your approval.</Empty>}
        </>
      ) : (
        <Card>
          {proposals.data?.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Change</th>
                    <th>Repository</th>
                    <th>By</th>
                    <th>Files</th>
                    <th>Status</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {proposals.data.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <button className="link-btn" onClick={() => setParams({ proposal: p.id })}>
                          {p.title}
                        </button>
                      </td>
                      <td>{p.repo}</td>
                      <td>{p.employee_name}</td>
                      <td>{p.file_count}</td>
                      <td>
                        <StatusPill status={p.status} label={p.status.replace('_', ' ')} />
                      </td>
                      <td>{fmtDateTime(p.created_at, lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No code changes proposed yet.</Empty>
          )}
        </Card>
      )}
      {openProposal ? (
        <ProposalDialog
          id={openProposal}
          onClose={() => {
            setParams({});
            void proposals.reload();
            void list.reload();
          }}
        />
      ) : null}
    </Page>
  );
}

function ApprovalCard({ a, onDone, onDiff }: { a: Approval; onDone: () => void; onDiff: (id: string) => void }) {
  const { lang } = useI18n();
  const [note, setNote] = useState('');
  const act = useAction();
  const decide = (decision: 'approve' | 'reject') => act.run(() => api(`/approvals/${a.id}`, { body: { decision, note } })).then(onDone);
  const plan = a.kind === 'plan' ? (a.payload.plan as { summary: string; deliverables: string[]; subtasks: { title: string; assignee: string; reviewer?: string; depends_on: string[] }[] }) : null;
  return (
    <Card
      title={
        <span>
          <Pill tone="violet">{KIND_LABEL[a.kind] ?? a.kind}</Pill> {a.title}
        </span>
      }
      actions={<StatusPill status={a.status} label={a.status} />}
    >
      <p className="small muted">
        Requested by {a.employee_name ?? 'HQ'} · {fmtDateTime(a.created_at, lang)}
        {a.task_id ? (
          <>
            {' · '}
            <Link to={`/tasks/${a.task_id}`}>{a.task_title}</Link>
          </>
        ) : null}
      </p>
      {plan ? (
        <>
          <p>{plan.summary}</p>
          <ol>
            {plan.subtasks.map((s, i) => (
              <li key={i}>
                <strong>{s.title}</strong> — {s.assignee}
                {s.reviewer ? `, reviewed by ${s.reviewer}` : ''}
                {s.depends_on.length ? <span className="muted small"> (after {s.depends_on.join(', ')})</span> : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {a.kind === 'github_issue' ? (
        <div className="quote">
          <strong>{String(a.payload.title)}</strong> <span className="muted small">in {String(a.payload.repo)}</span>
          <Markdown text={String(a.payload.body)} />
        </div>
      ) : null}
      {a.kind === 'external_publish' ? (
        <div className="quote">
          <span className="small muted">Channel: {String(a.payload.channel)}</span>
          <Markdown text={String(a.payload.content)} />
        </div>
      ) : null}
      {a.kind === 'code_change' ? (
        <>
          <p>{a.description}</p>
          <Button small onClick={() => onDiff(String(a.payload.proposalId))}>
            Review the diff
          </Button>
        </>
      ) : null}
      {a.kind === 'owner_decision' ? (
        <p>
          {a.description} — <Link to={`/tasks/${a.task_id}`}>answer on the task</Link>
        </p>
      ) : null}
      {a.result ? <pre className="pre small">{JSON.stringify(a.result, null, 1)}</pre> : null}
      {a.decision_note ? <p className="small">Note: {a.decision_note}</p> : null}
      {a.status === 'pending' && a.kind !== 'owner_decision' ? (
        <div className="row gap-2 wrap">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Note" />
          <Button variant="primary" disabled={act.busy} onClick={() => decide('approve')}>
            Approve
          </Button>
          <Button variant="danger" disabled={act.busy} onClick={() => decide('reject')}>
            Reject
          </Button>
        </div>
      ) : null}
      <ErrorBox error={act.error} />
    </Card>
  );
}

interface ProposalView {
  proposal: { id: string; title: string; description: string; repo: string; base_branch: string; status: string; branch: string | null; commit_sha: string | null; pr_number: number | null; pr_url: string | null; error: string | null; employee_name: string | null; files: { path: string; change: string }[]; task_id: string | null };
  diff: string;
  approval: { id: string; status: string } | null;
}

function ProposalDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const p = useApi<ProposalView>(`/proposals/${id}`);
  const act = useAction();
  const [confirmMerge, setConfirmMerge] = useState('');
  if (!p.data) return <Modal title="Code change" onClose={onClose}>{p.error ? <ErrorBox error={p.error} /> : <Loading />}</Modal>;
  const x = p.data.proposal;
  return (
    <Modal title={`Code change: ${x.title}`} onClose={onClose} wide>
      <p className="small muted">
        {x.employee_name} · {x.repo} (base {x.base_branch}) · <StatusPill status={x.status} label={x.status.replace('_', ' ')} />
        {x.branch ? <> · branch <code>{x.branch}</code></> : null}
        {x.pr_url ? (
          <>
            {' · '}
            <a href={x.pr_url} target="_blank" rel="noopener noreferrer">
              PR #{x.pr_number}
            </a>
          </>
        ) : null}
      </p>
      <Markdown text={x.description} />
      <ul className="small">
        {x.files.map((f) => (
          <li key={f.path}>
            <code>{f.path}</code> <Pill tone={f.change === 'added' ? 'good' : f.change === 'deleted' ? 'bad' : 'info'}>{f.change}</Pill>
          </li>
        ))}
      </ul>
      <Diff text={p.data.diff} />
      {x.error ? <div className="error-box">{x.error}</div> : null}
      <ErrorBox error={act.error} />
      <div className="row gap-2 wrap end">
        {p.data.approval?.status === 'pending' ? (
          <>
            <Button variant="danger" disabled={act.busy} onClick={() => act.run(() => api(`/approvals/${p.data!.approval!.id}`, { body: { decision: 'reject' } })).then(p.reload)}>
              Reject
            </Button>
            <Button variant="primary" disabled={act.busy} onClick={() => act.run(() => api(`/approvals/${p.data!.approval!.id}`, { body: { decision: 'approve' } })).then(p.reload)}>
              Approve and commit to a new hq/* branch
            </Button>
          </>
        ) : null}
        {x.status === 'branch_created' ? (
          <Button variant="primary" disabled={act.busy} onClick={() => act.run(() => api(`/proposals/${x.id}/pull-request`, { body: { draft: true } })).then(p.reload)}>
            Open a draft pull request
          </Button>
        ) : null}
        {x.status === 'pr_opened' ? (
          <>
            <input value={confirmMerge} onChange={(e) => setConfirmMerge(e.target.value)} placeholder={`Type ${x.pr_number} to merge`} aria-label="Confirm merge" />
            <Button variant="danger" disabled={act.busy || confirmMerge !== String(x.pr_number)} onClick={() => act.run(() => api(`/proposals/${x.id}/merge`, { body: { confirm: Number(confirmMerge) } })).then(p.reload)}>
              Merge pull request
            </Button>
          </>
        ) : null}
      </div>
      <p className="small muted">HQ never writes the default or protected branches. Branch creation, pull requests and merging are each controlled in Settings → Permissions and each needs your explicit action.</p>
    </Modal>
  );
}

export function Diff({ text }: { text: string }) {
  return (
    <pre className="diff" dir="ltr">
      {text.split('\n').map((l, i) => (
        <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>
          {l}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}
