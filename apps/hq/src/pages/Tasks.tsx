import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Page } from '../App';
import { Avatar } from '../components/Avatar';
import { AssignTaskDialog, ObjectiveDialog } from '../components/dialogs';
import { Button, Empty, ErrorBox, Loading, Pill, StatusPill, Tabs } from '../components/ui';
import { api, useApi } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useI18n } from '../lib/i18n';
import type { Employee, Project, Task } from '../lib/types';

const COLUMNS = ['backlog', 'assigned', 'in_progress', 'under_review', 'blocked', 'waiting_approval', 'completed', 'rejected'] as const;

export function TasksPage() {
  const { t, lang } = useI18n();
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') as 'kanban' | 'timeline' | 'list') ?? 'kanban';
  const project = params.get('project') ?? '';
  const assignee = params.get('assignee') ?? '';
  const q = new URLSearchParams();
  if (project) q.set('project_id', project);
  if (assignee) q.set('assignee_id', assignee);
  const tasks = useApi<Task[]>(`/tasks?${q}`, ['task', 'tasks.changed']);
  const projects = useApi<Project[]>('/projects');
  const emps = useApi<Employee[]>('/employees');
  const [dialog, setDialog] = useState<'task' | 'objective' | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p);
  };
  const list = (tasks.data ?? []).filter((x) => showCancelled || x.status !== 'cancelled');

  return (
    <Page
      title={t.nav.tasks}
      actions={
        <>
          <Button onClick={() => setDialog('task')}>New task</Button>
          <Button variant="primary" onClick={() => setDialog('objective')}>
            Give an objective
          </Button>
        </>
      }
    >
      <div className="toolbar">
        <Tabs value={view} onChange={(v) => set('view', v)} tabs={[{ id: 'kanban', label: 'Kanban' }, { id: 'timeline', label: 'Timeline' }, { id: 'list', label: 'List' }]} />
        <select value={project} onChange={(e) => set('project', e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={assignee} onChange={(e) => set('assignee', e.target.value)} aria-label="Assignee">
          <option value="">Everyone</option>
          {(emps.data ?? []).map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <label className="check small">
          <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> Show cancelled
        </label>
      </div>
      <ErrorBox error={tasks.error} onRetry={tasks.reload} />
      {tasks.loading && !tasks.data ? <Loading /> : null}
      {tasks.data && !list.length ? <Empty>No tasks yet. Give the Chief of Staff an objective or assign a task to an employee.</Empty> : null}
      {view === 'kanban' && list.length ? (
        <div className="kanban">
          {COLUMNS.map((c) => {
            const col = list.filter((x) => x.status === c);
            return (
              <section key={c} className="kanban-col" aria-label={t.taskStatus[c]}>
                <h2>
                  {t.taskStatus[c]} <span className="muted">{col.length}</span>
                </h2>
                {col.map((x) => (
                  <TaskCard key={x.id} task={x} lang={lang} onMove={tasks.reload} />
                ))}
              </section>
            );
          })}
        </div>
      ) : null}
      {view === 'timeline' && list.length ? <Timeline tasks={list} /> : null}
      {view === 'list' && list.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Status</th>
                <th>Assignee</th>
                <th>Priority</th>
                <th>Project</th>
                <th>Deadline</th>
              </tr>
            </thead>
            <tbody>
              {list.map((x) => (
                <tr key={x.id}>
                  <td>
                    <Link to={`/tasks/${x.id}`}>{x.title}</Link>
                    {x.kind !== 'work' ? <Pill tone="violet">{x.kind}</Pill> : null}
                  </td>
                  <td>
                    <StatusPill status={x.status} />
                  </td>
                  <td>{x.assignee_name ?? '—'}</td>
                  <td>{t.priority[x.priority]}</td>
                  <td>{x.project_name ?? '—'}</td>
                  <td>{fmtDate(x.deadline, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {dialog === 'task' ? <AssignTaskDialog onClose={() => setDialog(null)} onCreated={() => tasks.reload()} /> : null}
      {dialog === 'objective' ? <ObjectiveDialog onClose={() => setDialog(null)} /> : null}
    </Page>
  );
}

function TaskCard({ task, lang, onMove }: { task: Task; lang: string; onMove: () => void }) {
  const { t } = useI18n();
  const overdue = task.deadline && new Date(task.deadline).getTime() < Date.now() && task.status !== 'completed';
  return (
    <article className={`task-card prio-${task.priority}`}>
      <Link to={`/tasks/${task.id}`} className="task-title">
        {task.title}
      </Link>
      <div className="row gap-1 wrap small">
        {task.kind !== 'work' ? <Pill tone="violet">{task.kind === 'plan' ? 'Objective' : 'Final report'}</Pill> : null}
        {task.priority !== 'normal' ? <Pill tone={task.priority === 'urgent' ? 'bad' : task.priority === 'high' ? 'warn' : 'muted'}>{t.priority[task.priority]}</Pill> : null}
        {task.open_deps ? <Pill tone="muted">waits on {task.open_deps}</Pill> : null}
        {task.github_issue ? <Pill>#{task.github_issue.number}</Pill> : null}
        {task.revision ? <Pill tone="warn">rev {task.revision}</Pill> : null}
      </div>
      {task.blocked_reason && task.status === 'blocked' ? <p className="small bad clamp">{task.blocked_reason}</p> : null}
      <footer className="row between">
        <span className="row gap-1 small">
          {task.assignee_avatar ? <Avatar spec={task.assignee_avatar} size={20} /> : null}
          {task.assignee_name ?? t.common.unassigned}
        </span>
        {task.deadline ? <span className={`small ${overdue ? 'bad' : 'muted'}`}>{fmtDate(task.deadline, lang)}</span> : null}
      </footer>
      {task.status === 'backlog' && task.assignee_id ? (
        <Button small onClick={() => void api(`/tasks/${task.id}`, { method: 'PATCH', body: { action: 'start' } }).then(onMove)}>
          {t.common.start}
        </Button>
      ) : null}
    </article>
  );
}

/** Timeline: each task as a bar from creation (or start) to completion, deadline or now. */
function Timeline({ tasks }: { tasks: Task[] }) {
  const { t, lang } = useI18n();
  const rows = useMemo(
    () =>
      tasks
        .map((x) => {
          const start = new Date(x.started_at ?? x.created_at).getTime();
          const end = x.completed_at ? new Date(x.completed_at).getTime() : x.deadline ? Math.max(new Date(x.deadline).getTime(), Date.now()) : Date.now();
          return { x, start, end: Math.max(end, start + 3600_000) };
        })
        .sort((a, b) => a.start - b.start),
    [tasks]
  );
  const min = Math.min(...rows.map((r) => r.start));
  const max = Math.max(...rows.map((r) => r.end), Date.now());
  const span = max - min || 1;
  const pct = (v: number) => ((v - min) / span) * 100;
  return (
    <div className="timeline">
      <div className="timeline-scale small muted">
        <span>{fmtDate(new Date(min), lang)}</span>
        <span>{fmtDate(new Date(max), lang)}</span>
      </div>
      {rows.map(({ x, start, end }) => (
        <div key={x.id} className="timeline-row">
          <Link to={`/tasks/${x.id}`} className="timeline-label clamp1">
            {x.title}
          </Link>
          <div className="timeline-track">
            <div className={`timeline-bar st-${x.status}`} style={{ insetInlineStart: `${pct(start)}%`, width: `${Math.max(1.5, pct(end) - pct(start))}%` }} title={`${t.taskStatus[x.status]} · ${x.assignee_name ?? ''}`} />
            {x.deadline ? <div className="timeline-deadline" style={{ insetInlineStart: `${pct(new Date(x.deadline).getTime())}%` }} title={`Deadline ${fmtDate(x.deadline, lang)}`} /> : null}
            <div className="timeline-now" style={{ insetInlineStart: `${pct(Date.now())}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
