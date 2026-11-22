import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Page } from '../App';
import { Markdown } from '../components/Markdown';
import { Button, Card, Empty, ErrorBox, Field, Loading, Modal, Pill } from '../components/ui';
import { api, useAction, useApi } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useI18n } from '../lib/i18n';
import type { Department, Employee, Project } from '../lib/types';

const KINDS = ['objective', 'documentation', 'decision', 'requirement', 'architecture', 'brand', 'marketing', 'meeting_summary', 'lesson', 'deliverable', 'expertise', 'other'];

interface Entry {
  id: string;
  scope: string;
  project_id: string | null;
  department_id: string | null;
  employee_id: string | null;
  kind: string;
  title: string;
  excerpt?: string;
  body?: string;
  tags: string[];
  confidential: boolean;
  source: Record<string, string>;
  updated_at: string;
}

/** Company memory: what employees retrieve. The owner can inspect, edit and delete every entry. */
export function KnowledgePage() {
  const { lang } = useI18n();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const qs = new URLSearchParams();
  if (q.length > 1) qs.set('q', q);
  if (kind) qs.set('kind', kind);
  const list = useApi<Entry[]>(`/knowledge?${qs}`, ['task', 'meeting']);
  const open = params.get('open');
  const [editing, setEditing] = useState<Entry | 'new' | null>(null);
  return (
    <Page title="Knowledge base" actions={<Button variant="primary" onClick={() => setEditing('new')}>Add knowledge</Button>}>
      <p className="muted small">
        Employees receive only entries relevant to their task (full-text retrieval), limited to company-wide entries and those of their project, department or themselves. Entries marked confidential are never sent to an AI provider unless you allow it in Settings → Permissions.
      </p>
      <div className="toolbar">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search knowledge…" aria-label="Search" />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
          <option value="">All kinds</option>
          {KINDS.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </div>
      <ErrorBox error={list.error} onRetry={list.reload} />
      {!list.data ? <Loading /> : !list.data.length ? <Empty>No knowledge yet. Add company objectives, brand guidelines and architecture notes so employees work with the right context.</Empty> : null}
      <div className="cards-grid">
        {(list.data ?? []).map((k) => (
          <Card key={k.id} title={<button className="link-btn" onClick={() => setParams({ open: k.id })}>{k.title}</button>}>
            <div className="row gap-1 wrap">
              <Pill>{k.kind}</Pill>
              <Pill tone="muted">{k.scope}</Pill>
              {k.confidential ? <Pill tone="bad">confidential</Pill> : null}
              {k.source.employeeId ? <Pill tone="violet">by employee</Pill> : null}
            </div>
            <p className="small clamp">{k.excerpt}</p>
            <span className="small muted">{fmtDate(k.updated_at, lang)}</span>
          </Card>
        ))}
      </div>
      {open ? <EntryView id={open} onClose={() => setParams({})} onEdit={(e) => (setParams({}), setEditing(e))} onDeleted={() => (setParams({}), list.reload())} /> : null}
      {editing ? <EntryDialog entry={editing === 'new' ? null : editing} onClose={() => (setEditing(null), list.reload())} /> : null}
    </Page>
  );
}

function EntryView({ id, onClose, onEdit, onDeleted }: { id: string; onClose: () => void; onEdit: (e: Entry) => void; onDeleted: () => void }) {
  const e = useApi<Entry>(`/knowledge/${id}`);
  const act = useAction();
  return (
    <Modal title={e.data?.title ?? 'Knowledge'} onClose={onClose} wide>
      {e.data ? (
        <>
          <Markdown text={e.data.body ?? ''} />
          <ErrorBox error={act.error} />
          <div className="row gap-2 end">
            <Button variant="danger" onClick={() => confirm('Delete this entry permanently?') && void act.run(() => api(`/knowledge/${id}`, { method: 'DELETE' })).then((r) => r !== undefined && onDeleted())}>
              Delete
            </Button>
            <Button onClick={() => onEdit(e.data!)}>Edit</Button>
          </div>
        </>
      ) : (
        <Loading />
      )}
    </Modal>
  );
}

function EntryDialog({ entry, onClose }: { entry: Entry | null; onClose: () => void }) {
  const full = useApi<Entry>(entry ? `/knowledge/${entry.id}` : null);
  const projects = useApi<Project[]>('/projects');
  const depts = useApi<Department[]>('/departments');
  const emps = useApi<Employee[]>('/employees');
  const [f, setF] = useState<Record<string, unknown> | null>(entry ? null : { title: '', body: '', kind: 'documentation', scope: 'company', project_id: '', department_id: '', employee_id: '', tags: '', confidential: false });
  const act = useAction();
  const v = f ?? (full.data ? { ...full.data, tags: full.data.tags.join(', '), project_id: full.data.project_id ?? '', department_id: full.data.department_id ?? '', employee_id: full.data.employee_id ?? '' } : null);
  if (!v) return <Modal title="Edit knowledge" onClose={onClose}><Loading /></Modal>;
  const set = (k: string, val: unknown) => setF({ ...v, [k]: val });
  return (
    <Modal title={entry ? 'Edit knowledge' : 'Add knowledge'} onClose={onClose} wide>
      <div className="form">
        <Field label="Title">
          <input value={String(v.title)} onChange={(e) => set('title', e.target.value)} />
        </Field>
        <Field label="Content (Markdown)">
          <textarea rows={10} value={String(v.body ?? '')} onChange={(e) => set('body', e.target.value)} />
        </Field>
        <div className="grid-3">
          <Field label="Kind">
            <select value={String(v.kind)} onChange={(e) => set('kind', e.target.value)}>
              {KINDS.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </Field>
          <Field label="Scope">
            <select value={String(v.scope)} onChange={(e) => set('scope', e.target.value)}>
              {['company', 'project', 'department', 'employee'].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </Field>
          {v.scope === 'project' ? (
            <Field label="Project">
              <select value={String(v.project_id)} onChange={(e) => set('project_id', e.target.value)}>
                <option value="">—</option>
                {(projects.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {v.scope === 'department' ? (
            <Field label="Department">
              <select value={String(v.department_id)} onChange={(e) => set('department_id', e.target.value)}>
                <option value="">—</option>
                {(depts.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name_en}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {v.scope === 'employee' ? (
            <Field label="Employee">
              <select value={String(v.employee_id)} onChange={(e) => set('employee_id', e.target.value)}>
                <option value="">—</option>
                {(emps.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>
        <Field label="Tags" hint="Comma separated">
          <input value={String(v.tags)} onChange={(e) => set('tags', e.target.value)} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={!!v.confidential} onChange={(e) => set('confidential', e.target.checked)} />
          <span>Confidential — never sent to AI providers unless allowed in Settings</span>
        </label>
        <ErrorBox error={act.error} />
        <Button
          variant="primary"
          disabled={act.busy}
          onClick={async () => {
            const body = {
              title: v.title,
              body: v.body,
              kind: v.kind,
              scope: v.scope,
              project_id: v.project_id || null,
              department_id: v.department_id || null,
              employee_id: v.employee_id || null,
              tags: String(v.tags).split(',').map((s) => s.trim()).filter(Boolean),
              confidential: !!v.confidential
            };
            if ((await act.run(() => (entry ? api(`/knowledge/${entry.id}`, { method: 'PATCH', body }) : api('/knowledge', { body })))) !== undefined) onClose();
          }}
        >
          Save
        </Button>
      </div>
    </Modal>
  );
}
