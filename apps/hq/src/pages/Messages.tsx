import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Avatar } from '../components/Avatar';
import { Markdown } from '../components/Markdown';
import { Button, ErrorBox, Loading } from '../components/ui';
import { api, useAction, useApi } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useI18n } from '../lib/i18n';
import type { AvatarSpec } from '../lib/types';

interface Channel {
  id: string;
  kind: 'announcements' | 'department' | 'project' | 'direct';
  name: string;
  employee_avatar: AvatarSpec | null;
  employee_title: string | null;
  last_at: string | null;
  message_count: number;
}
interface Message {
  id: string;
  author_type: string;
  author_name: string | null;
  author_avatar: AvatarSpec | null;
  body: string;
  created_at: string;
  run_id: string | null;
}

/** Company communication: announcements, department and project channels, and direct conversations. */
export function MessagesPage() {
  const { t, lang } = useI18n();
  const [params, setParams] = useSearchParams();
  const channels = useApi<Channel[]>('/channels', ['message']);
  const current = params.get('channel') ?? channels.data?.[0]?.id ?? null;
  const ch = channels.data?.find((c) => c.id === current);
  const msgs = useApi<{ messages: Message[]; pending: { id: string; status: string }[] }>(current ? `/channels/${current}/messages` : null, (e) => e.type === 'message' && (e.message as { channel_id: string }).channel_id === current);
  const [text, setText] = useState('');
  const act = useAction();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'nearest' });
  }, [msgs.data?.messages.length]);
  const groups: [string, Channel['kind'][]][] = [
    ['Company', ['announcements']],
    ['Projects', ['project']],
    ['Departments', ['department']],
    ['Direct', ['direct']]
  ];
  return (
    <div className="messages">
      <nav className="channel-list" aria-label="Channels">
        {groups.map(([label, kinds]) => {
          const list = (channels.data ?? []).filter((c) => kinds.includes(c.kind));
          if (!list.length) return null;
          return (
            <div key={label}>
              <h2 className="side-title">{label}</h2>
              {list.map((c) => (
                <button key={c.id} className={`channel${c.id === current ? ' active' : ''}`} onClick={() => setParams({ channel: c.id })}>
                  {c.kind === 'direct' ? <Avatar spec={c.employee_avatar} size={22} /> : <span className="hash">#</span>}
                  <span className="clamp1">{c.name}</span>
                  {c.message_count ? <span className="small muted">{c.message_count}</span> : null}
                </button>
              ))}
            </div>
          );
        })}
      </nav>
      <section className="chat">
        {ch ? (
          <header className="chat-head">
            <strong>{ch.kind === 'direct' ? ch.name : `# ${ch.name}`}</strong>
            <span className="small muted">
              {ch.kind === 'direct'
                ? `${ch.employee_title} · replies are real AI runs with read-only tools`
                : ch.kind === 'announcements'
                  ? 'Your announcements are saved as company knowledge and reach employees through retrieval.'
                  : 'Task updates and messages between employees.'}
            </span>
          </header>
        ) : null}
        <div className="chat-body" aria-live="polite">
          {msgs.loading && !msgs.data ? <Loading /> : null}
          <ErrorBox error={msgs.error} />
          {msgs.data?.messages.map((m) => (
            <div key={m.id} className={`msg msg-${m.author_type}`}>
              {m.author_type === 'employee' ? <Avatar spec={m.author_avatar} size={30} /> : <span className={`msg-badge ${m.author_type}`}>{m.author_type === 'owner' ? 'CEO' : 'HQ'}</span>}
              <div>
                <div className="small muted">
                  {m.author_type === 'owner' ? 'You' : m.author_type === 'system' ? 'HQ' : m.author_name} · {fmtDateTime(m.created_at, lang)}
                </div>
                <Markdown text={m.body} />
              </div>
            </div>
          ))}
          {msgs.data?.pending.length ? <p className="small muted typing-note">{ch?.name} is typing…</p> : null}
          <div ref={end} />
        </div>
        {ch && ch.kind !== 'department' && ch.kind !== 'project' ? (
          <form
            className="chat-input"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim()) return;
              void act.run(() => api(`/channels/${ch.id}/messages`, { body: { body: text } })).then((r) => {
                if (r !== undefined) {
                  setText('');
                  void msgs.reload();
                }
              });
            }}
          >
            <textarea
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), (e.currentTarget.form as HTMLFormElement).requestSubmit())}
              placeholder={ch.kind === 'direct' ? `Message ${ch.name}…` : 'Write an announcement…'}
              aria-label="Message"
            />
            <Button variant="primary" type="submit" disabled={act.busy || !text.trim()}>
              {t.common.send}
            </Button>
          </form>
        ) : (
          <p className="small muted chat-foot">Channel posts come from task updates and employees; talk to someone directly from the Direct list.</p>
        )}
        <ErrorBox error={act.error} />
      </section>
    </div>
  );
}
