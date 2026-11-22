import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Page } from '../App';
import { Avatar } from '../components/Avatar';
import { EmployeeSelect } from '../components/dialogs';
import { Button, Card, Empty, ErrorBox, Field, Loading, Pill, StatusPill } from '../components/ui';
import { api, useAction, useApi } from '../lib/api';
import { fmtDateTime, fmtUsd } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { onLive } from '../lib/live';
import type { AvatarSpec, Employee, Project } from '../lib/types';

const ROOMS = ['majlis', 'summit', 'huddle'] as const;
const TYPES = ['brainstorming', 'product_planning', 'technical_review', 'security_review', 'design_review', 'marketing_strategy', 'project_status', 'emergency', 'general'] as const;

interface MeetingRow {
  id: string;
  room: string;
  title: string;
  type: string;
  status: string;
  objective: string;
  created_at: string;
  participant_ids: string[];
  contributions: number;
}

export function MeetingsPage() {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const m = useApi<MeetingRow[]>('/meetings', ['meeting', 'meeting.event']);
  const running = (m.data ?? []).filter((x) => x.status === 'running' || x.status === 'wrapping_up');
  return (
    <Page title={t.nav.meetings} actions={<Button variant="primary" onClick={() => nav('/meetings/new')}>New meeting</Button>}>
      <div className="room-cards">
        {ROOMS.map((r) => {
          const busy = running.find((x) => x.room === r);
          return (
            <button key={r} className={`room-card${busy ? ' busy' : ''}`} onClick={() => nav(busy ? `/meetings/${busy.id}` : `/meetings/new?room=${r}`)}>
              <span className="room-card-title">{t.rooms[r]}</span>
              {busy ? (
                <span>
                  <Pill tone="info">{t.office.roomBusy}</Pill> {busy.title}
                </span>
              ) : (
                <span className="muted small">{t.office.startMeeting}</span>
              )}
            </button>
          );
        })}
      </div>
      <Card title="Meeting history">
        <ErrorBox error={m.error} onRetry={m.reload} />
        {m.data?.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Meeting</th>
                  <th>Type</th>
                  <th>Room</th>
                  <th>Participants</th>
                  <th>Contributions</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {m.data.map((x) => (
                  <tr key={x.id}>
                    <td>
                      <Link to={`/meetings/${x.id}`}>{x.title}</Link>
                    </td>
                    <td>{t.meetingTypes[x.type]}</td>
                    <td>{t.rooms[x.room]}</td>
                    <td>{x.participant_ids?.length ?? 0}</td>
                    <td>{x.contributions}</td>
                    <td>
                      <StatusPill status={x.status} label={x.status.replace('_', ' ')} />
                    </td>
                    <td>{fmtDateTime(x.created_at, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : m.data ? (
          <Empty>No meetings yet.</Empty>
        ) : (
          <Loading />
        )}
      </Card>
    </Page>
  );
}

export function NewMeetingPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const emps = useApi<Employee[]>('/employees');
  const projects = useApi<Project[]>('/projects');
  const settings = useApi<{ limits: { maxMeetingRounds: number; maxMeetingParticipants: number } }>('/settings');
  const [f, setF] = useState({
    room: params.get('room') ?? 'majlis',
    title: '',
    objective: '',
    agenda: '',
    type: 'product_planning',
    expected_output: '',
    project_id: '',
    max_rounds: 2,
    participants: params.get('invite') ? [params.get('invite')!] : ([] as string[])
  });
  const act = useAction();
  const max = settings.data?.limits.maxMeetingParticipants ?? 6;
  const toggle = (id: string) => setF((s) => ({ ...s, participants: s.participants.includes(id) ? s.participants.filter((x) => x !== id) : s.participants.length >= max ? s.participants : [...s.participants, id] }));
  const available = (emps.data ?? []).filter((e) => e.active);
  return (
    <Page title="New meeting">
      <div className="meeting-setup">
        <Card title="Meeting">
          <div className="form">
            <div className="grid-2">
              <Field label="Room">
                <select value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })}>
                  {ROOMS.map((r) => (
                    <option key={r} value={r}>
                      {t.rooms[r]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Type">
                <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
                  {TYPES.map((x) => (
                    <option key={x} value={x}>
                      {t.meetingTypes[x]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Title">
              <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
            </Field>
            <Field label="Objective">
              <textarea rows={3} value={f.objective} onChange={(e) => setF({ ...f, objective: e.target.value })} />
            </Field>
            <Field label="Agenda" hint="One item per line (up to 8). Each item is discussed, then summarised by the moderator.">
              <textarea rows={4} value={f.agenda} onChange={(e) => setF({ ...f, agenda: e.target.value })} />
            </Field>
            <Field label="Expected output">
              <input value={f.expected_output} onChange={(e) => setF({ ...f, expected_output: e.target.value })} placeholder="e.g. a prioritised list and owners" />
            </Field>
            <div className="grid-2">
              <Field label="Project">
                <select value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
                  <option value="">{t.common.noProject}</option>
                  {(projects.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Discussion rounds per item" hint="More rounds = more back-and-forth and more cost.">
                <input type="number" min={1} max={settings.data?.limits.maxMeetingRounds ?? 2} value={f.max_rounds} onChange={(e) => setF({ ...f, max_rounds: Number(e.target.value) })} />
              </Field>
            </div>
          </div>
        </Card>
        <Card title={`Invite employees (${f.participants.length}/${max})`}>
          <p className="muted small">The Project Manager (or Chief of Staff) moderates when invited.</p>
          <div className="invite-grid">
            {available.map((e) => (
              <label key={e.id} className={`invite${f.participants.includes(e.id) ? ' on' : ''}${e.current_meeting_id ? ' disabled' : ''}`}>
                <input type="checkbox" checked={f.participants.includes(e.id)} disabled={!!e.current_meeting_id} onChange={() => toggle(e.id)} />
                <Avatar spec={e.avatar} size={34} />
                <span>
                  <strong>{e.name}</strong>
                  <span className="small muted">{e.title}</span>
                  {e.current_meeting_id ? <span className="small bad">In a meeting</span> : null}
                </span>
              </label>
            ))}
          </div>
        </Card>
      </div>
      <ErrorBox error={act.error} />
      <div className="row end gap-2">
        <Button onClick={() => nav(-1)}>{t.common.cancel}</Button>
        <Button
          variant="primary"
          disabled={act.busy || f.participants.length < 2 || f.title.length < 3 || f.objective.length < 5}
          onClick={async () => {
            const r = await act.run(() =>
              api<{ id: string }>('/meetings', {
                body: {
                  room: f.room,
                  title: f.title,
                  objective: f.objective,
                  agenda: f.agenda.split('\n').map((s) => s.trim()).filter(Boolean),
                  type: f.type,
                  expected_output: f.expected_output,
                  participant_ids: f.participants,
                  project_id: f.project_id || null,
                  max_rounds: f.max_rounds
                }
              })
            );
            if (r) nav(`/meetings/${r.id}`);
          }}
        >
          Start meeting
        </Button>
      </div>
    </Page>
  );
}

interface MeetingDetail {
  meeting: {
    id: string;
    title: string;
    objective: string;
    agenda: string[];
    type: string;
    room: string;
    status: string;
    expected_output: string;
    progress: { item: number; round: number };
    moderator_id: string;
    error: string | null;
    created_at: string;
    ended_at: string | null;
    minutes: null | { executive_summary: string; key_points: string[]; decisions: string[]; disagreements: string[]; unresolved_questions: string[]; action_items: unknown[] };
  };
  participants: { id: string; name: string; title: string; slug: string; avatar: AvatarSpec }[];
  events: { id: string; kind: string; employee_id: string | null; agenda_index: number | null; content: string; data: { stance?: string; addressed_to?: string[]; decisions?: string[]; open_questions?: string[] }; created_at: string }[];
  actionItems: { id: string; title: string; description: string; assignee_id: string | null; assignee_name: string | null; deadline: string | null; task_id: string | null }[];
  usage: { runs: number; cost_usd: number; tokens: number };
}

/** The live meeting room. Every line in the transcript is a stored event from a real model run or the owner. */
export function MeetingRoomPage() {
  const { id } = useParams();
  const { t, lang } = useI18n();
  const d = useApi<MeetingDetail>(`/meetings/${id}`, (e) => (e.type === 'meeting.event' || e.type === 'meeting' || e.type === 'meeting.progress') && e.meetingId === id);
  const emps = useApi<Employee[]>('/employees');
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [text, setText] = useState('');
  const act = useAction();
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      onLive((e) => {
        if (e.type === 'meeting.speaking' && e.meetingId === id) setSpeaking((e.employeeId as string) ?? null);
      }),
    [id]
  );
  // Block body: in current Chromium scrollIntoView returns a Promise, which must not be returned from an effect.
  useEffect(() => {
    void endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [d.data?.events.length]);
  if (!d.data) return d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : <Loading />;
  const { meeting: m, participants, events, actionItems } = d.data;
  const live = m.status === 'running' || m.status === 'wrapping_up';
  const who = new Map(participants.map((p) => [p.id, p]));
  const decisions = events.filter((e) => e.kind === 'item_summary').flatMap((e) => e.data.decisions ?? []);
  const questions = [...events.filter((e) => e.kind === 'speech' && e.data.stance === 'question').map((e) => `${who.get(e.employee_id!)?.name}: ${e.content}`), ...events.filter((e) => e.kind === 'item_summary').flatMap((e) => e.data.open_questions ?? [])];
  const disagreements = events.filter((e) => e.kind === 'speech' && e.data.stance === 'disagree');

  return (
    <div className="page meeting-page">
      <nav className="crumbs small">
        <Link to="/meetings">{t.nav.meetings}</Link>
      </nav>
      <header className="page-head">
        <div>
          <h1>{m.title}</h1>
          <div className="row gap-2 wrap">
            <StatusPill status={m.status} label={m.status.replace('_', ' ')} />
            <Pill>{t.meetingTypes[m.type]}</Pill>
            <Pill>{t.rooms[m.room]}</Pill>
            <span className="small muted">
              {d.data.usage.runs} AI runs · {fmtUsd(d.data.usage.cost_usd)}
            </span>
          </div>
        </div>
        {m.status === 'running' ? (
          <Button variant="danger" onClick={() => act.run(() => api(`/meetings/${m.id}/end`, { body: {} })).then(d.reload)}>
            End and write minutes
          </Button>
        ) : null}
      </header>
      {m.error ? <div className="error-box">{m.error}</div> : null}
      <div className="meeting-grid">
        <aside className="meeting-side">
          <Card title="Participants">
            <ul className="participants">
              {participants.map((p) => (
                <li key={p.id} className={speaking === p.id && live ? 'speaking' : ''}>
                  <Avatar spec={p.avatar} size={36} />
                  <span>
                    <strong>{p.name}</strong>
                    <span className="small muted">
                      {p.title}
                      {p.id === m.moderator_id ? ' · moderator' : ''}
                    </span>
                  </span>
                  {speaking === p.id && live ? (
                    <span className="speaking-dots" aria-label="speaking">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Agenda">
            <p className="small">{m.objective}</p>
            <ol className="agenda">
              {m.agenda.map((a, i) => (
                <li key={i} className={!live || i < m.progress.item ? 'done' : i === m.progress.item ? 'current' : ''}>
                  {a}
                  {live && i === m.progress.item ? <span className="small muted"> · round {m.progress.round + 1}</span> : null}
                </li>
              ))}
            </ol>
          </Card>
        </aside>
        <section className="transcript-col">
          <Card title={live ? `Current topic: ${m.agenda[Math.min(m.progress.item, m.agenda.length - 1)] ?? ''}` : 'Transcript'}>
            <div className="transcript" aria-live="polite">
              {events.map((e) => {
                if (e.kind === 'speech') {
                  const p = who.get(e.employee_id!);
                  return (
                    <div key={e.id} className={`line stance-${e.data.stance}`}>
                      <Avatar spec={p?.avatar} size={30} />
                      <div>
                        <div className="small">
                          <strong>{p?.name}</strong> <Pill tone={e.data.stance === 'disagree' || e.data.stance === 'concern' ? 'warn' : e.data.stance === 'question' ? 'info' : 'muted'}>{e.data.stance}</Pill>
                          {e.data.addressed_to?.length ? <span className="muted"> → {e.data.addressed_to.join(', ')}</span> : null}
                        </div>
                        <p dir="auto">{e.content}</p>
                      </div>
                    </div>
                  );
                }
                if (e.kind === 'owner')
                  return (
                    <div key={e.id} className="line owner">
                      <div className="owner-badge">CEO</div>
                      <p dir="auto">{e.content}</p>
                    </div>
                  );
                if (e.kind === 'topic') return <h3 key={e.id} className="topic">{e.content}</h3>;
                if (e.kind === 'item_summary')
                  return (
                    <div key={e.id} className="item-summary">
                      <strong>Moderator summary:</strong> {e.content}
                    </div>
                  );
                return (
                  <p key={e.id} className="sys small muted">
                    {e.content}
                  </p>
                );
              })}
              {live && speaking ? <p className="small muted">{who.get(speaking)?.name} is preparing a contribution…</p> : null}
              <div ref={endRef} />
            </div>
            {live ? (
              <form
                className="row gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (text.trim()) void act.run(() => api(`/meetings/${m.id}/messages`, { body: { text } })).then(() => setText(''));
                }}
              >
                <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Speak in the meeting as the CEO…" aria-label="Your message" />
                <Button variant="primary" type="submit" disabled={!text.trim() || act.busy}>
                  {t.common.send}
                </Button>
              </form>
            ) : null}
            <ErrorBox error={act.error} />
          </Card>
        </section>
        <aside className="meeting-side">
          {m.minutes ? (
            <Card title="Minutes">
              <h3>Executive summary</h3>
              <p dir="auto">{m.minutes.executive_summary}</p>
              <MinutesList title="Key points" items={m.minutes.key_points} />
              <MinutesList title="Decisions" items={m.minutes.decisions} />
              <MinutesList title="Disagreements" items={m.minutes.disagreements} />
              <MinutesList title="Unresolved questions" items={m.minutes.unresolved_questions} />
            </Card>
          ) : (
            <Card title="So far">
              <MinutesList title="Decisions" items={decisions} />
              <MinutesList title="Questions" items={questions} />
              <MinutesList title="Disagreements" items={disagreements.map((e) => `${who.get(e.employee_id!)?.name}: ${e.content}`)} />
            </Card>
          )}
          <Card title="Action items">
            {actionItems.length ? (
              <ul className="list">
                {actionItems.map((a) => (
                  <ActionItem key={a.id} a={a} employees={emps.data ?? []} onDone={d.reload} />
                ))}
              </ul>
            ) : (
              <Empty>{live ? 'Recorded in the minutes at the end.' : 'None.'}</Empty>
            )}
          </Card>
          <p className="small muted">Started {fmtDateTime(m.created_at, lang)}{m.ended_at ? ` · ended ${fmtDateTime(m.ended_at, lang)}` : ''}</p>
        </aside>
      </div>
    </div>
  );
}

function MinutesList({ title, items }: { title: string; items: string[] }) {
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

function ActionItem({ a, employees, onDone }: { a: MeetingDetail['actionItems'][number]; employees: Employee[]; onDone: () => void }) {
  const [assignee, setAssignee] = useState(a.assignee_id ?? '');
  const act = useAction();
  return (
    <li>
      <strong>{a.title}</strong>
      {a.description ? <p className="small">{a.description}</p> : null}
      <div className="small muted">
        {a.assignee_name ?? 'Unassigned'}
        {a.deadline ? ` · due ${a.deadline}` : ''}
      </div>
      {a.task_id ? (
        <Link to={`/tasks/${a.task_id}`} className="small">
          Open task →
        </Link>
      ) : (
        <div className="row gap-1">
          <EmployeeSelect value={assignee} onChange={setAssignee} employees={employees} allowEmpty="Unassigned" label="Assignee" />
          <Button small variant="primary" disabled={act.busy} onClick={() => act.run(() => api(`/meeting-action-items/${a.id}/task`, { body: { assignee_id: assignee || null } })).then(onDone)}>
            Create task
          </Button>
        </div>
      )}
      <ErrorBox error={act.error} />
    </li>
  );
}
