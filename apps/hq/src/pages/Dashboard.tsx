import { Link } from 'react-router-dom';
import { Page } from '../App';
import { Card, Empty, ErrorBox, Loading, Stat, StatusPill } from '../components/ui';
import { useApi } from '../lib/api';
import { fmtDate, fmtUsd, timeAgo } from '../lib/format';
import { useI18n } from '../lib/i18n';

interface Dash {
  employees: { total: number; active: number; working: number };
  tasks: Record<string, number>;
  approvals: { id: string; kind: string; title: string; created_at: string; employee_name: string | null }[];
  projects: { id: string; name: string; tasks: number; completed: number; blocked: number }[];
  deadlines: { id: string; title: string; deadline: string; status: string; assignee_name: string | null }[];
  meetings: { id: string; title: string; status: string; created_at: string }[];
  usage: { runs: number; failed: number; tokens: number; cost_usd: number; unpriced_runs: number; today: number; month: number; dailyBudgetUsd: number; monthlyBudgetUsd: number };
  usageByDay: { day: string; runs: number; cost_usd: number; tokens: number }[];
  usageByModel: { model: string; runs: number; cost_usd: number; input: number; output: number; cache_read: number }[];
  departments: { id: string; name_en: string; name_ar: string; color: string; employees: number; completed: number; active: number; blocked: number; accepted: number; cost_usd: number }[];
}

/** Executive dashboard. Every figure is computed by the API from stored records. */
export function DashboardPage() {
  const { t, lang } = useI18n();
  const d = useApi<Dash>('/dashboard', ['task', 'run', 'meeting', 'approvals.changed', 'employee.status']);
  if (!d.data) return d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : <Loading />;
  const x = d.data;
  const now = Date.now();
  return (
    <Page title={t.nav.dashboard} actions={<Link to="/reports" className="btn btn-primary">Daily briefing</Link>}>
      <div className="stats-grid wide">
        <Stat label="Employees" value={x.employees.total} sub={`${x.employees.active} active · ${x.employees.working} working now`} />
        <Stat label={t.taskStatus.in_progress} value={x.tasks.in_progress} sub={`${x.tasks.queued} queued · ${x.tasks.backlog} in backlog`} tone="info" />
        <Stat label={t.taskStatus.completed} value={x.tasks.completed} sub={`${x.tasks.completed_24h} in the last 24h`} tone="good" />
        <Stat label={t.taskStatus.blocked} value={x.tasks.blocked} tone={x.tasks.blocked ? 'bad' : undefined} />
        <Stat label="Pending approvals" value={x.approvals.length} sub={`${x.tasks.waiting} tasks waiting on you`} tone={x.approvals.length ? 'warn' : undefined} />
        <Stat label="AI cost today" value={fmtUsd(x.usage.today)} sub={`budget ${fmtUsd(x.usage.dailyBudgetUsd)} · month ${fmtUsd(x.usage.month)} / ${fmtUsd(x.usage.monthlyBudgetUsd)}`} />
        <Stat label="AI runs" value={x.usage.runs} sub={`${x.usage.failed} failed · ${Number(x.usage.tokens).toLocaleString()} tokens`} />
      </div>
      {x.usage.unpriced_runs ? <p className="warn-note">{x.usage.unpriced_runs} runs used a model without a price in Settings → Pricing; their cost is not counted.</p> : null}
      <div className="grid-dash">
        <Card title="Pending approvals" actions={<Link to="/approvals">All</Link>}>
          {x.approvals.length ? (
            <ul className="list">
              {x.approvals.map((a) => (
                <li key={a.id}>
                  <Link to="/approvals">{a.title}</Link>
                  <span className="muted small"> · {a.employee_name ?? ''} · {timeAgo(a.created_at, lang)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Nothing waiting for you.</Empty>
          )}
        </Card>
        <Card title="Active projects" actions={<Link to="/projects">All</Link>}>
          {x.projects.length ? (
            x.projects.map((p) => (
              <div key={p.id} className="progress-row">
                <div className="row between">
                  <Link to={`/tasks?project=${p.id}`}>{p.name}</Link>
                  <span className="small muted">
                    {p.completed}/{p.tasks} {p.blocked ? `· ${p.blocked} blocked` : ''}
                  </span>
                </div>
                <div className="bar" role="progressbar" aria-valuenow={p.tasks ? Math.round((p.completed / p.tasks) * 100) : 0} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ width: `${p.tasks ? (p.completed / p.tasks) * 100 : 0}%` }} />
                </div>
              </div>
            ))
          ) : (
            <Empty>No active projects.</Empty>
          )}
        </Card>
        <Card title="Upcoming deadlines">
          {x.deadlines.length ? (
            <ul className="list">
              {x.deadlines.map((t2) => (
                <li key={t2.id} className="row between gap-2">
                  <span>
                    <Link to={`/tasks/${t2.id}`}>{t2.title}</Link> <span className="muted small">{t2.assignee_name}</span>
                  </span>
                  <span className={new Date(t2.deadline).getTime() < now ? 'bad small' : 'small'}>{fmtDate(t2.deadline, lang)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No deadlines set.</Empty>
          )}
        </Card>
        <Card title="Recent meetings" actions={<Link to="/meetings">All</Link>}>
          {x.meetings.length ? (
            <ul className="list">
              {x.meetings.map((m) => (
                <li key={m.id} className="row between gap-2">
                  <Link to={`/meetings/${m.id}`}>{m.title}</Link>
                  <StatusPill status={m.status} label={m.status} />
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No meetings yet.</Empty>
          )}
        </Card>
        <Card title="AI usage — last 14 days" className="span-2">
          <UsageChart days={x.usageByDay} />
          {x.usageByModel.length ? (
            <div className="table-wrap">
              <table className="table small">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Runs</th>
                    <th>Input</th>
                    <th>Cached input</th>
                    <th>Output</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {x.usageByModel.map((m) => (
                    <tr key={m.model ?? 'none'}>
                      <td>{m.model ?? '—'}</td>
                      <td>{m.runs}</td>
                      <td>{Number(m.input).toLocaleString()}</td>
                      <td>{Number(m.cache_read).toLocaleString()}</td>
                      <td>{Number(m.output).toLocaleString()}</td>
                      <td>{fmtUsd(m.cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Card>
        <Card title="Department performance" className="span-2">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Department</th>
                  <th>Employees</th>
                  <th>Active tasks</th>
                  <th>Completed</th>
                  <th>Accepted deliverables</th>
                  <th>Blocked</th>
                  <th>AI cost</th>
                </tr>
              </thead>
              <tbody>
                {x.departments.map((dp) => (
                  <tr key={dp.id}>
                    <td>
                      <span className="legend-dot" style={{ background: dp.color }} /> <Link to={`/employees?dept=${dp.id}`}>{lang === 'ar' ? dp.name_ar : dp.name_en}</Link>
                    </td>
                    <td>{dp.employees}</td>
                    <td>{dp.active}</td>
                    <td>{dp.completed}</td>
                    <td>{dp.accepted}</td>
                    <td className={dp.blocked ? 'bad' : ''}>{dp.blocked}</td>
                    <td>{fmtUsd(dp.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </Page>
  );
}

function UsageChart({ days }: { days: Dash['usageByDay'] }) {
  if (!days.length) return <Empty>No AI usage recorded yet.</Empty>;
  const max = Math.max(...days.map((d) => d.cost_usd), 0.0001);
  return (
    <div className="chart" role="img" aria-label="AI cost per day">
      {days.map((d) => (
        <div key={d.day} className="chart-col" title={`${d.day}: ${fmtUsd(d.cost_usd)}, ${d.runs} runs`}>
          <div className="chart-bar" style={{ height: `${Math.max(2, (d.cost_usd / max) * 100)}%` }} />
          <span className="chart-label">{d.day.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}
