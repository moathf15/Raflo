import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Avatar } from '../components/Avatar';
import { EmployeeProfile } from '../components/EmployeeProfile';
import { ObjectiveDialog } from '../components/dialogs';
import { Button } from '../components/ui';
import { useApi } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { onLive } from '../lib/live';
import { displayStatus, type Employee } from '../lib/types';
import { OfficeMap, STATUS_COLORS } from '../office/Office';

interface Feed {
  id: string;
  text: string;
  at: string;
  link?: string | null;
}

/** The headquarters: the office map with a heads-up display of real activity. */
export function OfficePage() {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const selected = params.get('employee');
  const emps = useApi<Employee[]>('/employees', ['employee.status', 'employees.changed', 'meeting']);
  const dash = useApi<{ setup: { providers: number; providerVerified: boolean; github: boolean }; approvals: unknown[] }>('/dashboard', ['providers.changed', 'approvals.changed', 'task']);
  const notes = useApi<{ id: string; title: string; created_at: string; link: string | null }[]>('/notifications', ['notification']);
  const [feed, setFeed] = useState<Feed[]>([]);
  const [objective, setObjective] = useState(false);

  useEffect(
    () =>
      onLive((e) => {
        let text: string | null = null;
        let link: string | null = null;
        if (e.type === 'message') {
          const m = e.message as { author_type: string; body: string; data: { taskId?: string; meetingId?: string } };
          if (m.author_type === 'system') {
            text = m.body;
            link = m.data.taskId ? `/tasks/${m.data.taskId}` : m.data.meetingId ? `/meetings/${m.data.meetingId}` : null;
          }
        } else if (e.type === 'meeting.event') {
          const ev = e.event as { kind: string; content: string; meeting_id: string; employee_id: string | null };
          if (ev.kind === 'speech') {
            const who = emps.data?.find((x) => x.id === ev.employee_id)?.name ?? '';
            text = `${who}: “${ev.content.slice(0, 120)}${ev.content.length > 120 ? '…' : ''}”`;
            link = `/meetings/${ev.meeting_id}`;
          }
        }
        if (text) setFeed((f) => [{ id: `${e.at}-${Math.random()}`, text: text!, at: e.at, link }, ...f].slice(0, 40));
      }),
    [emps.data]
  );

  const people = emps.data ?? [];
  const count = (pred: (s: string) => boolean) => people.filter((p) => pred(displayStatus(p))).length;
  const working = count((s) => ['thinking', 'working', 'reading', 'writing', 'collaborating'].includes(s));
  const meeting = count((s) => s === 'in_meeting');
  const blocked = count((s) => s === 'blocked');
  const setup = dash.data?.setup;
  const combined: Feed[] = [...feed, ...(notes.data ?? []).map((n) => ({ id: n.id, text: n.title, at: n.created_at, link: n.link }))].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 25);

  return (
    <div className="office-page">
      <div className="hud">
        <div className="hud-stats">
          <HudStat label={t.office.working} value={working} color={STATUS_COLORS.working} />
          <HudStat label={t.office.meeting} value={meeting} color={STATUS_COLORS.in_meeting} />
          <HudStat label={t.office.blocked} value={blocked} color={STATUS_COLORS.blocked} />
          <Link to="/approvals" className="hud-stat">
            <span className="hud-num" style={{ color: STATUS_COLORS.waiting_approval }}>
              {dash.data?.approvals.length ?? 0}
            </span>
            <span className="hud-label">{t.office.approvals}</span>
          </Link>
        </div>
        <div className="row gap-2 wrap">
          <Button variant="primary" onClick={() => setObjective(true)}>
            {t.office.objective}
          </Button>
          <Button onClick={() => nav('/meetings/new')}>{t.office.newMeeting}</Button>
          <Button onClick={() => nav('/employees')}>{t.office.listView}</Button>
        </div>
      </div>
      {setup && (!setup.providers || !setup.github) ? (
        <div className="setup-banner" role="note">
          <strong>{t.setup.title}</strong>
          <ul>
            <li className={setup.providers ? 'ok' : ''}>
              {setup.providers ? '✓ ' : ''}
              <Link to="/settings">{t.setup.provider}</Link>
            </li>
            <li className={setup.github ? 'ok' : ''}>
              {setup.github ? '✓ ' : ''}
              <Link to="/github">{t.setup.github}</Link>
            </li>
          </ul>
        </div>
      ) : null}
      <div className="office-layout">
        <OfficeMap
          focusId={selected}
          onSelect={(id) => setParams({ employee: id })}
          onRoom={(r) => {
            if (r.kind === 'meeting') nav(`/meetings/new?room=${r.id}`);
            else if (r.kind === 'projects') nav('/projects');
            else if (r.kind === 'department') nav(`/employees?dept=${r.id}`);
          }}
        />
        <aside className="office-side">
          <section>
            <h2 className="side-title">{t.office.activity}</h2>
            {combined.length ? (
              <ul className="feed">
                {combined.map((f) => (
                  <li key={f.id}>
                    {f.link ? <Link to={f.link}>{f.text}</Link> : <span>{f.text}</span>}
                    <span className="muted small">{timeAgo(f.at, lang)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">{t.office.noActivity}</p>
            )}
          </section>
          <section>
            <h2 className="side-title">{t.office.legend}</h2>
            <ul className="legend">
              {Object.entries(STATUS_COLORS).map(([k, c]) => (
                <li key={k}>
                  <span className="legend-dot" style={{ background: c }} /> {t.status[k]}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="side-title">{t.nav.employees}</h2>
            <ul className="mini-roster">
              {people
                .filter((p) => !['idle', 'on_break'].includes(displayStatus(p)))
                .map((p) => (
                  <li key={p.id}>
                    <button className="roster-btn" onClick={() => setParams({ employee: p.id })}>
                      <Avatar spec={p.avatar} size={26} />
                      <span>
                        <strong>{p.name}</strong>
                        <span className="small muted"> {t.status[displayStatus(p)]}</span>
                        {p.status_detail ? <span className="small muted clamp1">{p.status_detail}</span> : null}
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          </section>
          <p className="muted small">{t.office.hint}</p>
        </aside>
      </div>
      {selected ? <EmployeeProfile id={selected} onClose={() => setParams({})} /> : null}
      {objective ? <ObjectiveDialog onClose={() => setObjective(false)} /> : null}
    </div>
  );
}

function HudStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="hud-stat">
      <span className="hud-num" style={{ color }}>
        {value}
      </span>
      <span className="hud-label">{label}</span>
    </div>
  );
}
