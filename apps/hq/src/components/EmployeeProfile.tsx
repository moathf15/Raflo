import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApi } from '../lib/api';
import { fmtDate, fmtDuration, fmtUsd, timeAgo } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { displayStatus, type Employee } from '../lib/types';
import { STATUS_COLORS } from '../office/Office';
import { Avatar } from './Avatar';
import { AssignTaskDialog, EmployeeDialog } from './dialogs';
import { Button, Empty, ErrorBox, Loading, Pill, Stat, StatusPill, Tabs } from './ui';

interface Profile {
  employee: Employee;
  performance: Record<string, number | string | null> | null;
  tasks: { id: string; title: string; status: string; priority: string; deadline: string | null; project_name: string | null; updated_at: string; as_reviewer: boolean }[];
  deliverables: { id: string; task_id: string; task_title: string; version: number; summary: string; review_status: string; owner_rating: number | null; created_at: string }[];
  runs: { id: string; kind: string; status: string; model: string | null; input_tokens: number; output_tokens: number; cost_usd: string | null; error: string | null; started_at: string; finished_at: string | null }[];
  messages: { id: string; body: string; author_type: string; channel_name: string; channel_kind: string; created_at: string }[];
  meetings: { id: string; title: string; status: string; created_at: string }[];
  knowledge: { id: string; title: string; kind: string }[];
  projects: { id: string; name: string }[];
  directChannelId: string | null;
}

type Tab = 'overview' | 'work' | 'performance' | 'memory' | 'comms';

/** The employee window: everything about one AI employee, from stored data, plus the owner's actions. */
export function EmployeeProfile({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const p = useApi<Profile>(`/employees/${id}`, (e) => (e.type === 'employee.status' && (e.employee as { id: string }).id === id) || ['task', 'employees.changed', 'run'].includes(e.type));
  const [tab, setTab] = useState<Tab>('overview');
  const [dialog, setDialog] = useState<null | 'assign' | 'responsibilities' | 'permissions' | 'all'>(null);
  const e = p.data?.employee;
  const st = e ? displayStatus(e) : 'idle';
  const pending = p.data?.tasks.filter((x) => !['completed', 'cancelled', 'rejected'].includes(x.status)) ?? [];
  const done = p.data?.tasks.filter((x) => x.status === 'completed') ?? [];
  const perf = p.data?.performance;
  const n = (k: string) => Number(perf?.[k] ?? 0);

  return (
    <aside className="drawer" role="dialog" aria-label={e?.name ?? 'Employee'}>
      <header className="drawer-head">
        <button className="icon-btn" onClick={onClose} aria-label={t.common.close}>
          ×
        </button>
      </header>
      {p.loading && !p.data ? <Loading /> : null}
      <ErrorBox error={p.error} onRetry={p.reload} />
      {e ? (
        <>
          <div className="profile-hero">
            <div className="profile-avatar" style={{ boxShadow: `0 0 0 4px ${STATUS_COLORS[st]}` }}>
              <Avatar spec={e.avatar} size={84} />
            </div>
            <div>
              <h2>{e.name}</h2>
              <p className="muted">{lang === 'ar' && e.title_ar ? e.title_ar : e.title}</p>
              <div className="row gap-2 wrap">
                <span className="status-chip" style={{ background: STATUS_COLORS[st] }}>
                  {t.status[st]}
                </span>
                <Pill>{t.rooms[e.department_id] ?? e.department_id}</Pill>
              </div>
              {e.status_detail && st !== 'idle' ? <p className="small muted">{e.status_detail}</p> : null}
            </div>
          </div>
          <div className="profile-actions">
            <Button variant="primary" small onClick={() => setDialog('assign')} disabled={!e.active}>
              {t.profile.assign}
            </Button>
            <Button small onClick={() => nav(`/messages?channel=${p.data!.directChannelId}`)}>
              {t.profile.talk}
            </Button>
            <Button small onClick={() => nav(`/meetings/new?invite=${e.id}`)}>
              {t.profile.invite}
            </Button>
            <Button small onClick={() => setTab('work')}>
              {t.profile.review}
            </Button>
            <Button small onClick={() => setTab('performance')}>
              {t.profile.reports}
            </Button>
            <Button small onClick={() => setDialog('responsibilities')}>
              {t.profile.responsibilities}
            </Button>
            <Button small onClick={() => setDialog('permissions')}>
              {t.profile.permissions}
            </Button>
          </div>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'overview', label: t.profile.overview },
              { id: 'work', label: `${t.profile.work} (${pending.length})` },
              { id: 'performance', label: t.profile.performance },
              { id: 'memory', label: t.profile.memory },
              { id: 'comms', label: t.profile.comms }
            ]}
          />
          <div className="drawer-body">
            {tab === 'overview' ? (
              <>
                <h3>{t.profile.currentTask}</h3>
                {e.current_task_id ? <Link to={`/tasks/${e.current_task_id}`}>{e.status_detail ?? 'Open task'}</Link> : e.current_meeting_id ? <Link to={`/meetings/${e.current_meeting_id}`}>{t.status.in_meeting}</Link> : <p className="muted">{t.common.none}</p>}
                <h3>{t.profile.personality}</h3>
                <p>{e.personality}</p>
                <h3>{t.profile.skills}</h3>
                <div className="row gap-1 wrap">{e.skills.map((s) => <Pill key={s}>{s}</Pill>)}</div>
                <h3>{t.profile.responsibilitiesL}</h3>
                <ul>{e.responsibilities.map((r) => <li key={r}>{r}</li>)}</ul>
                <h3>{t.profile.projects}</h3>
                {p.data!.projects.length ? p.data!.projects.map((x) => <Pill key={x.id}>{x.name}</Pill>) : <p className="muted">{t.common.none}</p>}
                <h3>Tools</h3>
                <div className="row gap-1 wrap">{e.tools.map((s) => <code key={s}>{s}</code>)}</div>
              </>
            ) : null}
            {tab === 'work' ? (
              <>
                <h3>{t.profile.pending}</h3>
                {pending.length ? <TaskList tasks={pending} /> : <Empty>{t.profile.noWork}</Empty>}
                <h3>{t.profile.deliverables}</h3>
                {p.data!.deliverables.length ? (
                  <ul className="list">
                    {p.data!.deliverables.map((d) => (
                      <li key={d.id}>
                        <Link to={`/tasks/${d.task_id}`}>{d.task_title}</Link> <span className="muted small">v{d.version} · {timeAgo(d.created_at, lang)}</span> <StatusPill status={d.review_status} />
                        {d.owner_rating ? <span className="small"> {'★'.repeat(d.owner_rating)}</span> : null}
                        <p className="small muted clamp">{d.summary}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>{t.profile.noWork}</Empty>
                )}
                <h3>{t.profile.completed}</h3>
                {done.length ? <TaskList tasks={done} /> : <Empty>{t.profile.noWork}</Empty>}
              </>
            ) : null}
            {tab === 'performance' ? (
              <>
                <p className="muted small">{t.perf.quality}</p>
                <div className="stats-grid">
                  <Stat label={t.perf.accepted} value={n('accepted')} tone="good" />
                  <Stat label={t.perf.rejected} value={n('rejected')} tone={n('rejected') ? 'warn' : undefined} />
                  <Stat label={t.perf.rating} value={perf?.avg_rating ? `${perf.avg_rating} / 5` : '—'} />
                  <Stat label={t.perf.reviews} value={n('reviews_total') ? `${Math.round((n('reviews_passed') / n('reviews_total')) * 100)}%` : '—'} sub={`${n('reviews_passed')} / ${n('reviews_total')}`} />
                  <Stat label={t.perf.completed} value={n('completed')} />
                  <Stat label={t.perf.completion} value={n('finished_or_failed') ? `${Math.round((n('completed') / n('finished_or_failed')) * 100)}%` : '—'} />
                  <Stat label={t.perf.failed} value={`${n('failed_runs')} / ${n('runs')}`} tone={n('failed_runs') ? 'bad' : undefined} />
                  <Stat label={t.perf.avgTime} value={perf?.avg_run_seconds ? fmtDuration(Number(perf.avg_run_seconds)) : '—'} />
                  <Stat label={t.perf.cost} value={fmtUsd(n('cost_usd'))} sub={`${n('tokens').toLocaleString()} tokens`} />
                </div>
                <h3>{t.profile.runs}</h3>
                <RunTable runs={p.data!.runs} />
              </>
            ) : null}
            {tab === 'memory' ? (
              <>
                <h3>{t.profile.roleNotes}</h3>
                {e.role_memory ? <p className="pre">{e.role_memory}</p> : <p className="muted">{t.common.none}</p>}
                <Button small onClick={() => setDialog('responsibilities')}>
                  {t.common.edit}
                </Button>
                <h3>Standing instructions</h3>
                {e.instructions ? <p className="pre">{e.instructions}</p> : <p className="muted">{t.common.none}</p>}
                <h3>{t.profile.knowledge}</h3>
                {p.data!.knowledge.length ? (
                  <ul className="list">
                    {p.data!.knowledge.map((k) => (
                      <li key={k.id}>
                        <Link to={`/knowledge?open=${k.id}`}>{k.title}</Link> <Pill>{k.kind}</Pill>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">{t.common.none}</p>
                )}
                <p className="muted small">Personal task history (last completed tasks) and relevant company knowledge are retrieved automatically for each task.</p>
              </>
            ) : null}
            {tab === 'comms' ? (
              <>
                <h3>{t.profile.messages}</h3>
                {p.data!.messages.length ? (
                  <ul className="list">
                    {p.data!.messages.map((m) => (
                      <li key={m.id}>
                        <span className="muted small">
                          {m.channel_kind === 'direct' ? 'Direct' : `#${m.channel_name}`} · {timeAgo(m.created_at, lang)}
                        </span>
                        <p className="clamp">{m.body}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">{t.common.none}</p>
                )}
                <h3>{t.profile.meetings}</h3>
                {p.data!.meetings.length ? (
                  <ul className="list">
                    {p.data!.meetings.map((m) => (
                      <li key={m.id}>
                        <Link to={`/meetings/${m.id}`}>{m.title}</Link> <StatusPill status={m.status} /> <span className="muted small">{fmtDate(m.created_at, lang)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">{t.common.none}</p>
                )}
              </>
            ) : null}
          </div>
          {dialog === 'assign' ? <AssignTaskDialog employeeId={e.id} onClose={() => setDialog(null)} onCreated={() => p.reload()} /> : null}
          {dialog === 'responsibilities' || dialog === 'permissions' || dialog === 'all' ? (
            <EmployeeDialog
              employee={e}
              mode={dialog}
              onClose={() => {
                setDialog(null);
                void p.reload();
              }}
            />
          ) : null}
        </>
      ) : null}
    </aside>
  );
}

function TaskList({ tasks }: { tasks: Profile['tasks'] }) {
  const { lang } = useI18n();
  return (
    <ul className="list">
      {tasks.map((x) => (
        <li key={x.id} className="row between gap-2">
          <span>
            <Link to={`/tasks/${x.id}`}>{x.title}</Link>
            {x.as_reviewer ? <span className="muted small"> (reviewer)</span> : null}
            {x.project_name ? <span className="muted small"> · {x.project_name}</span> : null}
            {x.deadline ? <span className="muted small"> · {fmtDate(x.deadline, lang)}</span> : null}
          </span>
          <StatusPill status={x.status} />
        </li>
      ))}
    </ul>
  );
}

export function RunTable({ runs }: { runs: Profile['runs'] }) {
  const { lang } = useI18n();
  if (!runs.length) return <Empty>No AI runs yet.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table small">
        <thead>
          <tr>
            <th>When</th>
            <th>Kind</th>
            <th>Status</th>
            <th>Model</th>
            <th>Tokens in/out</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} title={r.error ?? ''}>
              <td>{timeAgo(r.started_at, lang)}</td>
              <td>{r.kind}</td>
              <td>
                <StatusPill status={r.status} label={r.status} />
              </td>
              <td>{r.model}</td>
              <td>
                {r.input_tokens.toLocaleString()} / {r.output_tokens.toLocaleString()}
              </td>
              <td>{r.cost_usd == null ? '—' : fmtUsd(Number(r.cost_usd))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
