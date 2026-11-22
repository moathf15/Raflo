import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../App';
import { Button, Card, Empty, ErrorBox, Loading, Pill } from '../components/ui';
import { api, useAction, useApi } from '../lib/api';
import { fmtDateTime, fmtUsd } from '../lib/format';
import { useI18n } from '../lib/i18n';

interface Report {
  id: string;
  kind: string;
  title: string;
  created_at: string;
  facts: {
    completed: { title: string; assignee: string | null; summary: string | null }[];
    started: { title: string; assignee: string | null }[];
    blocked: { title: string; assignee: string | null; reason: string | null }[];
    overdue: { title: string; assignee: string | null; deadline: string }[];
    pendingApprovals: { title: string; kind: string }[];
    meetings: { title: string; status: string; summary: string | null }[];
    inProgress: number;
    failedRuns: number;
    spend: { today: number; month: number };
  };
  content: null | { headline: string; what_happened: string; completed: string[]; delayed_or_blocked: string[]; needs_ceo_decision: string[]; next_steps: string[] };
}

/** Executive briefings: stored facts from the database, with the Chief of Staff's summary when a provider is configured. */
export function ReportsPage() {
  const { lang } = useI18n();
  const list = useApi<{ id: string; kind: string; title: string; written: boolean; created_at: string }[]>('/reports');
  const [open, setOpen] = useState<string | null>(null);
  const act = useAction();
  const current = open ?? list.data?.[0]?.id ?? null;
  const r = useApi<Report>(current ? `/reports/${current}` : null);
  const create = (kind: string) =>
    act.run(() => api<{ id: string }>('/reports', { body: { kind } })).then((x) => {
      if (x) {
        setOpen(x.id);
        void list.reload();
      }
    });
  return (
    <Page
      title="Reports & briefings"
      actions={
        <>
          <Button variant="primary" disabled={act.busy} onClick={() => create('daily_briefing')}>
            {act.busy ? 'The Chief of Staff is writing…' : 'Generate daily briefing'}
          </Button>
          <Button disabled={act.busy} onClick={() => create('weekly_briefing')}>
            Weekly briefing
          </Button>
        </>
      }
    >
      <ErrorBox error={act.error} />
      <div className="split">
        <nav className="split-list">
          {list.data?.length ? (
            list.data.map((x) => (
              <button key={x.id} className={`list-btn${x.id === current ? ' active' : ''}`} onClick={() => setOpen(x.id)}>
                <span>{x.title}</span>
                <span className="small muted">
                  {fmtDateTime(x.created_at, lang)} {x.written ? '' : '· facts only'}
                </span>
              </button>
            ))
          ) : list.data ? (
            <Empty>No briefings yet.</Empty>
          ) : (
            <Loading />
          )}
        </nav>
        <div>
          {r.data ? (
            <>
              {r.data.content ? (
                <Card title={r.data.content.headline}>
                  <p dir="auto">{r.data.content.what_happened}</p>
                  <Section title="Completed" items={r.data.content.completed} />
                  <Section title="Delayed or blocked" items={r.data.content.delayed_or_blocked} />
                  <Section title="Needs your decision" items={r.data.content.needs_ceo_decision} />
                  <Section title="Next" items={r.data.content.next_steps} />
                  <p className="small muted">Written by the Chief of Staff from the facts below.</p>
                </Card>
              ) : (
                <p className="warn-note">No written summary (no AI provider configured when this was generated). The facts below come straight from the database.</p>
              )}
              <Card title="Facts from the database">
                <div className="row gap-2 wrap">
                  <Pill>{r.data.facts.inProgress} in progress</Pill>
                  <Pill tone={r.data.facts.failedRuns ? 'bad' : 'muted'}>{r.data.facts.failedRuns} failed runs</Pill>
                  <Pill>AI today {fmtUsd(r.data.facts.spend.today)}</Pill>
                </div>
                <Section title={`Completed (${r.data.facts.completed.length})`} items={r.data.facts.completed.map((c) => `${c.title} — ${c.assignee ?? ''}`)} />
                <Section title={`Blocked (${r.data.facts.blocked.length})`} items={r.data.facts.blocked.map((c) => `${c.title} — ${c.reason ?? ''}`)} />
                <Section title={`Overdue (${r.data.facts.overdue.length})`} items={r.data.facts.overdue.map((c) => `${c.title} — ${c.assignee ?? ''}`)} />
                <Section title={`Pending approvals (${r.data.facts.pendingApprovals.length})`} items={r.data.facts.pendingApprovals.map((c) => c.title)} />
                <Section title={`Meetings (${r.data.facts.meetings.length})`} items={r.data.facts.meetings.map((c) => `${c.title} (${c.status})`)} />
                <Link to="/approvals">Go to approvals →</Link>
              </Card>
            </>
          ) : current ? (
            <Loading />
          ) : null}
        </div>
      </div>
    </Page>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <>
      <h3>{title}</h3>
      <ul>
        {items.map((x, i) => (
          <li key={i} dir="auto">
            {x}
          </li>
        ))}
      </ul>
    </>
  );
}
