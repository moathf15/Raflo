import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Markdown } from '../components/Markdown';
import { EmployeeSelect } from '../components/dialogs';
import { Button, Card, Empty, ErrorBox, Field, Loading, Modal, Pill, StatusPill } from '../components/ui';
import { api, useAction, useApi } from '../lib/api';
import { fmtDate, fmtDateTime, fmtDuration, fmtUsd, timeAgo } from '../lib/format';
import { useI18n } from '../lib/i18n';
import type { Employee, Task } from '../lib/types';

interface Detail {
  task: Task;
  children: Task[];
  deps: { id: string; title: string; status: string }[];
  dependents: { id: string; title: string; status: string }[];
  comments: { id: string; author_type: string; author_name: string | null; body: string; created_at: string }[];
  attachments: { id: string; name: string; size: number; created_at: string }[];
  deliverables: { id: string; version: number; summary: string; content: string; review_status: string; owner_rating: number | null; owner_feedback: string | null; employee_name: string | null; created_at: string; data: { outcome?: string; plan?: unknown } }[];
  reviews: { id: string; reviewer_type: string; reviewer_name: string | null; verdict: string; summary: string; findings: { severity: string; title: string; detail: string; evidence?: string }[]; created_at: string }[];
  runs: { id: string; kind: string; status: string; model: string | null; input_tokens: number; output_tokens: number; cache_read_tokens: number; cost_usd: string | null; error: string | null; started_at: string; finished_at: string | null; model_calls: number; employee_name: string | null }[];
  approvals: { id: string; kind: string; title: string; status: string; description: string }[];
  proposals: { id: string; repo: string; title: string; status: string; branch: string | null; pr_url: string | null }[];
}

export function TaskDetailPage() {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const d = useApi<Detail>(`/tasks/${id}`, (e) => e.type === 'task.comment' || e.type === 'approvals.changed' || e.type === 'run' || (e.type === 'task' && ((e.task as Task).id === id || (e.task as Task).parent_id === id)));
  const emps = useApi<Employee[]>('/employees');
  const act = useAction();
  const [comment, setComment] = useState('');
  const [answer, setAnswer] = useState('');
  const [edit, setEdit] = useState(false);
  const [runLog, setRunLog] = useState<string | null>(null);
  const [attach, setAttach] = useState(false);
  if (!d.data) return d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : <Loading />;
  const { task } = d.data;
  const patch = (body: unknown) => act.run(() => api(`/tasks/${task.id}`, { method: 'PATCH', body })).then(d.reload);
  const latest = d.data.deliverables[0];
  const planApproval = d.data.approvals.find((a) => a.kind === 'plan' && a.status === 'pending');
  const totalCost = d.data.runs.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);

  return (
    <div className="page">
      <nav className="crumbs small">
        <Link to="/tasks">{t.nav.tasks}</Link>
        {task.parent_id ? (
          <>
            {' / '}
            <Link to={`/tasks/${task.parent_id}`}>Objective</Link>
          </>
        ) : null}
      </nav>
      <header className="page-head">
        <div>
          <h1>{task.title}</h1>
          <div className="row gap-2 wrap">
            <StatusPill status={task.status} />
            <Pill>{t.priority[task.priority]}</Pill>
            {task.kind === 'plan' ? <Pill tone="violet">Objective (Chief of Staff)</Pill> : null}
            {task.kind === 'synthesis' ? <Pill tone="violet">Final report</Pill> : null}
            {task.project_name ? <Pill>{task.project_name}</Pill> : null}
            {task.deadline ? <span className="small muted">Deadline {fmtDate(task.deadline, lang)}</span> : null}
            {task.github_issue ? (
              <a className="small" href={task.github_issue.url} target="_blank" rel="noopener noreferrer">
                {task.github_issue.repo}#{task.github_issue.number}
              </a>
            ) : null}
          </div>
        </div>
        <div className="row gap-2 wrap">
          {['backlog', 'blocked', 'rejected'].includes(task.status) && task.assignee_id ? (
            <Button variant="primary" onClick={() => patch({ action: task.status === 'backlog' ? 'start' : 'retry' })}>
              {task.status === 'backlog' ? t.common.start : 'Retry'}
            </Button>
          ) : null}
          <Button onClick={() => setEdit(true)}>{t.common.edit}</Button>
          {!['completed', 'cancelled'].includes(task.status) ? (
            <Button variant="danger" onClick={() => confirm('Cancel this task (and its subtasks)?') && patch({ action: 'cancel' })}>
              Cancel task
            </Button>
          ) : null}
        </div>
      </header>
      <ErrorBox error={act.error} />
      {task.status === 'blocked' && task.blocked_reason ? <div className="error-box">{task.blocked_reason}</div> : null}
      {task.queue && task.blocked_reason && task.status !== 'blocked' ? <div className="warn-note">{task.blocked_reason}</div> : null}

      {planApproval ? (
        <Card title="The Chief of Staff's plan needs your approval" className="highlight">
          {latest ? <Markdown text={latest.content} /> : null}
          <div className="row gap-2">
            <Button variant="primary" disabled={act.busy} onClick={() => act.run(() => api(`/approvals/${planApproval.id}`, { body: { decision: 'approve' } })).then(d.reload)}>
              Approve plan and start
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const note = prompt('Why reject? (sent to the record)') ?? '';
                void act.run(() => api(`/approvals/${planApproval.id}`, { body: { decision: 'reject', note } })).then(d.reload);
              }}
            >
              Reject
            </Button>
          </div>
        </Card>
      ) : null}

      {task.status === 'waiting_approval' && task.owner_question && !planApproval ? (
        <Card title="Your decision is needed" className="highlight">
          <p>{task.owner_question}</p>
          <Field label="Your answer">
            <textarea rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} />
          </Field>
          <Button variant="primary" disabled={!answer.trim() || act.busy} onClick={() => act.run(() => api(`/tasks/${task.id}/answer`, { body: { answer } })).then(() => (setAnswer(''), d.reload()))}>
            Send answer and resume
          </Button>
        </Card>
      ) : null}

      <div className="detail-grid">
        <div className="detail-main">
          <Card title="Brief">
            {task.description ? <Markdown text={task.description} /> : <p className="muted">No description.</p>}
            {task.acceptance_criteria ? (
              <>
                <h3>Acceptance criteria</h3>
                <Markdown text={task.acceptance_criteria} />
              </>
            ) : null}
          </Card>

          {d.data.children.length ? (
            <Card title={`Subtasks (${d.data.children.filter((c) => c.status === 'completed').length}/${d.data.children.length})`}>
              <ul className="list">
                {d.data.children.map((c) => (
                  <li key={c.id} className="row between gap-2">
                    <span>
                      <Link to={`/tasks/${c.id}`}>{c.title}</Link> <span className="muted small">{c.assignee_name}</span>
                      {c.reviewer_name ? <span className="muted small"> · reviewed by {c.reviewer_name}</span> : null}
                      {c.open_deps ? <span className="muted small"> · waits on {c.open_deps}</span> : null}
                    </span>
                    <StatusPill status={c.status} />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card title={`Deliverables (${d.data.deliverables.length})`}>
            {d.data.deliverables.length ? (
              d.data.deliverables.map((x, i) => <DeliverableView key={x.id} d={x} latest={i === 0} taskStatus={task.status} onDone={d.reload} />)
            ) : (
              <Empty>{task.status === 'in_progress' ? 'The employee is working on it…' : 'No deliverable yet.'}</Empty>
            )}
          </Card>

          {d.data.reviews.length ? (
            <Card title="Review history">
              {d.data.reviews.map((r) => (
                <div key={r.id} className="review">
                  <div className="row gap-2">
                    <strong>{r.reviewer_type === 'owner' ? 'Owner' : r.reviewer_name}</strong>
                    <StatusPill status={r.verdict === 'approved' ? 'accepted' : r.verdict} label={r.verdict.replace('_', ' ')} />
                    <span className="muted small">{timeAgo(r.created_at, lang)}</span>
                  </div>
                  {r.summary ? <p>{r.summary}</p> : null}
                  {r.findings.length ? (
                    <ul>
                      {r.findings.map((f, i) => (
                        <li key={i}>
                          <Pill tone={f.severity === 'critical' || f.severity === 'major' ? 'bad' : 'muted'}>{f.severity}</Pill> <strong>{f.title}</strong> — {f.detail}
                          {f.evidence ? <div className="small muted">{f.evidence}</div> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </Card>
          ) : null}

          <Card title="Comments">
            {d.data.comments.map((c) => (
              <div key={c.id} className={`comment c-${c.author_type}`}>
                <span className="small muted">
                  {c.author_type === 'owner' ? 'Owner' : c.author_type === 'system' ? 'System' : c.author_name} · {fmtDateTime(c.created_at, lang)}
                </span>
                <Markdown text={c.body} />
              </div>
            ))}
            <div className="row gap-2">
              <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a note (the employee sees it on the next run)" aria-label="Comment" />
              <Button disabled={!comment.trim()} onClick={() => act.run(() => api(`/tasks/${task.id}/comments`, { body: { body: comment } })).then(() => (setComment(''), d.reload()))}>
                {t.common.send}
              </Button>
            </div>
          </Card>
        </div>

        <aside className="detail-side">
          <Card title="People">
            <dl className="kv">
              <dt>Assignee</dt>
              <dd>{task.assignee_name ?? t.common.unassigned}</dd>
              <dt>Reviewer</dt>
              <dd>{task.reviewer_name ?? '—'}</dd>
              <dt>Created</dt>
              <dd>{fmtDateTime(task.created_at, lang)}</dd>
              {task.completed_at ? (
                <>
                  <dt>Completed</dt>
                  <dd>{fmtDateTime(task.completed_at, lang)}</dd>
                </>
              ) : null}
              <dt>Attempts / revision</dt>
              <dd>
                {task.attempts} / {task.revision}
              </dd>
            </dl>
          </Card>
          <Card title="Dependencies">
            {d.data.deps.length ? (
              <ul className="list">
                {d.data.deps.map((x) => (
                  <li key={x.id} className="row between gap-2">
                    <Link to={`/tasks/${x.id}`}>{x.title}</Link>
                    <StatusPill status={x.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">None</p>
            )}
            {d.data.dependents.length ? (
              <>
                <h3>Blocks</h3>
                <ul className="list">
                  {d.data.dependents.map((x) => (
                    <li key={x.id}>
                      <Link to={`/tasks/${x.id}`}>{x.title}</Link>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </Card>
          {d.data.proposals.length ? (
            <Card title="Code changes">
              <ul className="list">
                {d.data.proposals.map((p) => (
                  <li key={p.id}>
                    <Link to={`/approvals?proposal=${p.id}`}>{p.title}</Link> <StatusPill status={p.status} label={p.status.replace('_', ' ')} />
                    {p.pr_url ? (
                      <a className="small" href={p.pr_url} target="_blank" rel="noopener noreferrer">
                        {' '}
                        PR
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          <Card title="Attachments" actions={<Button small onClick={() => setAttach(true)}>Add</Button>}>
            {d.data.attachments.length ? (
              <ul className="list">
                {d.data.attachments.map((a) => (
                  <li key={a.id} className="small">
                    {a.name} <span className="muted">({a.size} chars)</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">None</p>
            )}
          </Card>
          <Card title={`AI runs · ${fmtUsd(totalCost)}`}>
            {d.data.runs.length ? (
              <ul className="list">
                {d.data.runs.map((r) => (
                  <li key={r.id}>
                    <button className="link-btn" onClick={() => setRunLog(r.id)}>
                      {r.kind} · {r.employee_name}
                    </button>{' '}
                    <StatusPill status={r.status} label={r.status} />
                    <div className="small muted">
                      {r.model} · {r.model_calls} calls · {(r.input_tokens + r.cache_read_tokens).toLocaleString()} in / {r.output_tokens.toLocaleString()} out · {r.cost_usd == null ? 'no price' : fmtUsd(Number(r.cost_usd))}
                      {r.finished_at ? ` · ${fmtDuration((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000)}` : ''}
                    </div>
                    {r.error ? <div className="small bad">{r.error}</div> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No runs yet.</p>
            )}
          </Card>
        </aside>
      </div>
      {edit ? <EditTask task={task} employees={emps.data ?? []} onClose={() => (setEdit(false), d.reload())} /> : null}
      {runLog ? <RunLog id={runLog} onClose={() => setRunLog(null)} /> : null}
      {attach ? <AttachDialog taskId={task.id} onClose={() => (setAttach(false), d.reload())} /> : null}
    </div>
  );
}

function DeliverableView({ d, latest, taskStatus, onDone }: { d: Detail['deliverables'][number]; latest: boolean; taskStatus: string; onDone: () => void }) {
  const { lang } = useI18n();
  const [open, setOpen] = useState(latest);
  const [rating, setRating] = useState(d.owner_rating ?? 0);
  const [feedback, setFeedback] = useState('');
  const act = useAction();
  const review = (verdict: 'accept' | 'changes' | 'reject') => act.run(() => api(`/deliverables/${d.id}/review`, { body: { verdict, rating: rating || undefined, feedback } })).then(onDone);
  return (
    <article className="deliverable">
      <header className="row between gap-2">
        <button className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
          v{d.version} · {d.employee_name} · {fmtDateTime(d.created_at, lang)}
        </button>
        <StatusPill status={d.review_status} label={d.review_status.replace('_', ' ')} />
      </header>
      <p className="summary">{d.summary}</p>
      {open ? <Markdown text={d.content} /> : null}
      {latest && ['completed', 'under_review', 'blocked'].includes(taskStatus) && d.review_status !== 'rejected' ? (
        <div className="owner-review">
          <span className="small">Your review:</span>
          <div className="stars" role="radiogroup" aria-label="Rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} role="radio" aria-checked={rating === n} className={n <= rating ? 'star on' : 'star'} onClick={() => setRating(n)} aria-label={`${n} stars`}>
                ★
              </button>
            ))}
          </div>
          <input value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Feedback (required for changes)" aria-label="Feedback" />
          <Button small variant="primary" disabled={act.busy} onClick={() => review('accept')}>
            Accept
          </Button>
          <Button small disabled={act.busy || !feedback.trim()} onClick={() => review('changes')}>
            Request changes
          </Button>
          <Button small variant="danger" disabled={act.busy} onClick={() => review('reject')}>
            Reject
          </Button>
          <ErrorBox error={act.error} />
        </div>
      ) : d.owner_feedback ? (
        <p className="small muted">Owner feedback: {d.owner_feedback}</p>
      ) : null}
    </article>
  );
}

function EditTask({ task, employees, onClose }: { task: Task; employees: Employee[]; onClose: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ title: task.title, description: task.description, acceptance_criteria: task.acceptance_criteria, assignee_id: task.assignee_id ?? '', reviewer_id: task.reviewer_id ?? '', priority: task.priority, deadline: task.deadline?.slice(0, 10) ?? '' });
  const act = useAction();
  return (
    <Modal title={t.common.edit} onClose={onClose} wide>
      <div className="form">
        <Field label="Title">
          <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label="Description">
          <textarea rows={5} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Acceptance criteria">
          <textarea rows={3} value={f.acceptance_criteria} onChange={(e) => setF({ ...f, acceptance_criteria: e.target.value })} />
        </Field>
        <div className="grid-2">
          <Field label="Assignee (reassign)">
            <EmployeeSelect value={f.assignee_id} onChange={(v) => setF({ ...f, assignee_id: v })} employees={employees} allowEmpty={t.common.unassigned} />
          </Field>
          <Field label="Reviewer">
            <EmployeeSelect value={f.reviewer_id} onChange={(v) => setF({ ...f, reviewer_id: v })} employees={employees} allowEmpty="—" exclude={f.assignee_id} />
          </Field>
          <Field label="Priority">
            <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              {Object.entries(t.priority).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Deadline">
            <input type="date" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} />
          </Field>
        </div>
        <ErrorBox error={act.error} />
        <div className="row end gap-2">
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button
            variant="primary"
            disabled={act.busy}
            onClick={async () => {
              const body: Record<string, unknown> = { title: f.title, description: f.description, acceptance_criteria: f.acceptance_criteria, priority: f.priority, deadline: f.deadline || null, reviewer_id: f.reviewer_id || null };
              if ((f.assignee_id || null) !== task.assignee_id) body.assignee_id = f.assignee_id || null;
              if (await act.run(() => api(`/tasks/${task.id}`, { method: 'PATCH', body }))) onClose();
            }}
          >
            {t.common.save}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AttachDialog({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [f, setF] = useState({ name: '', content: '' });
  const act = useAction();
  return (
    <Modal title="Add a text attachment" onClose={onClose}>
      <div className="form">
        <Field label="Name">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="File" hint="Text files only (up to 50,000 characters). Sent to the assignee as untrusted input.">
          <input
            type="file"
            accept=".txt,.md,.csv,.json,.xml,text/*"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) setF({ name: f.name || file.name, content: (await file.text()).slice(0, 50_000) });
            }}
          />
        </Field>
        <Field label="Or paste text">
          <textarea rows={6} value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} />
        </Field>
        <ErrorBox error={act.error} />
        <Button variant="primary" disabled={!f.name || !f.content || act.busy} onClick={async () => (await act.run(() => api(`/tasks/${taskId}/attachments`, { body: { name: f.name, content: f.content } }))) !== undefined && onClose()}>
          Attach
        </Button>
      </div>
    </Modal>
  );
}

function RunLog({ id, onClose }: { id: string; onClose: () => void }) {
  const r = useApi<{ log: { t: string; type: string; [k: string]: unknown }[]; error: string | null; model: string }>(`/runs/${id}`);
  return (
    <Modal title="Execution log" onClose={onClose} wide>
      {r.data ? (
        <ol className="run-log">
          {r.data.log.map((l, i) => (
            <li key={i} className={`log-${l.type}`}>
              <span className="small muted">{new Date(l.t).toLocaleTimeString()}</span> <strong>{l.type}</strong>{' '}
              {l.type === 'model' ? (
                <span>
                  stop: {String(l.stop)} · {(l.usage as { input: number; output: number })?.input} in / {(l.usage as { output: number })?.output} out · {String(l.ms)} ms
                  {(l.tools as string[])?.length ? ` · tools: ${(l.tools as string[]).join(', ')}` : ''}
                  {l.text ? <div className="pre small">{String(l.text)}</div> : null}
                </span>
              ) : l.type === 'tool' ? (
                <span>
                  {String(l.tool)} {l.ok ? '✓' : '✗'} {l.error ? <span className="bad">{String(l.error)}</span> : null}
                  {l.input ? <div className="pre small">{JSON.stringify(l.input)}</div> : null}
                  {l.output ? <div className="pre small muted">{String(l.output)}</div> : null}
                </span>
              ) : (
                <span>{String(l.error ?? l.note ?? '')}</span>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <Loading />
      )}
    </Modal>
  );
}
