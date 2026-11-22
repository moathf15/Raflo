import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, useAction, useApi } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { Department, Employee, Project } from '../lib/types';
import { Button, ErrorBox, Field, Modal } from './ui';

export function EmployeeSelect({ value, onChange, employees, allowEmpty, exclude, label }: { value: string; onChange: (v: string) => void; employees: Employee[]; allowEmpty?: string; exclude?: string; label?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {allowEmpty !== undefined ? <option value="">{allowEmpty}</option> : null}
      {employees
        .filter((e) => e.id !== exclude && !e.archived_at)
        .map((e) => (
          <option key={e.id} value={e.id}>
            {e.name} — {e.title}
          </option>
        ))}
    </select>
  );
}

/** Assign a concrete task to one employee (optionally with an independent reviewer and dependencies). */
export function AssignTaskDialog({ employeeId, onClose, onCreated }: { employeeId?: string; onClose: () => void; onCreated?: (id: string) => void }) {
  const { t } = useI18n();
  const emps = useApi<Employee[]>('/employees');
  const projects = useApi<Project[]>('/projects');
  const [f, setF] = useState({ title: '', description: '', acceptance_criteria: '', assignee_id: employeeId ?? '', reviewer_id: '', project_id: '', priority: 'normal', deadline: '' });
  const act = useAction();
  const submit = async () => {
    const res = await act.run(() =>
      api<{ id: string }>('/tasks', {
        body: { ...f, assignee_id: f.assignee_id || null, reviewer_id: f.reviewer_id || null, project_id: f.project_id || null, deadline: f.deadline || null }
      })
    );
    if (res) {
      onCreated?.(res.id);
      onClose();
    }
  };
  return (
    <Modal title={t.profile.assign} onClose={onClose} wide>
      <div className="form">
        <Field label="Title">
          <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required maxLength={200} />
        </Field>
        <Field label="Description" hint="What should be done, context, links. Markdown is fine.">
          <textarea rows={5} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Acceptance criteria" hint="How the result will be judged. Reviewers check against this.">
          <textarea rows={3} value={f.acceptance_criteria} onChange={(e) => setF({ ...f, acceptance_criteria: e.target.value })} />
        </Field>
        <div className="grid-2">
          <Field label="Assignee">
            <EmployeeSelect value={f.assignee_id} onChange={(v) => setF({ ...f, assignee_id: v })} employees={emps.data ?? []} allowEmpty={`— ${t.common.unassigned} (backlog) —`} />
          </Field>
          <Field label="Independent reviewer" hint="Optional. Verifies the work before it is completed.">
            <EmployeeSelect value={f.reviewer_id} onChange={(v) => setF({ ...f, reviewer_id: v })} employees={emps.data ?? []} allowEmpty="— none —" exclude={f.assignee_id} />
          </Field>
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
          <Button variant="primary" disabled={act.busy || f.title.trim().length < 3} onClick={submit}>
            {f.assignee_id ? t.common.start : t.common.create}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** A natural-language objective for the Chief of Staff. */
export function ObjectiveDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const projects = useApi<Project[]>('/projects');
  const [f, setF] = useState({ objective: '', project_id: '', priority: 'normal', deadline: '' });
  const act = useAction();
  return (
    <Modal title="Give an objective to the Chief of Staff" onClose={onClose} wide>
      <div className="form">
        <p className="muted">
          Noura (Chief of Staff) will break it into subtasks, choose employees and reviewers, and set dependencies. You approve the plan before any work starts (Settings → Permissions), then receive the final report.
        </p>
        <Field label="Objective">
          <textarea rows={5} value={f.objective} placeholder="Analyze Raflo's current user experience and prepare a complete improvement plan." onChange={(e) => setF({ ...f, objective: e.target.value })} />
        </Field>
        <div className="grid-3">
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
            disabled={act.busy || f.objective.trim().length < 10}
            onClick={async () => {
              const r = await act.run(() => api<{ id: string }>('/objectives', { body: { objective: f.objective, project_id: f.project_id || null, priority: f.priority, deadline: f.deadline || null } }));
              if (r) {
                onClose();
                nav(`/tasks/${r.id}`);
              }
            }}
          >
            Send to Chief of Staff
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const TOOL_LABELS: Record<string, string> = {
  'knowledge.read': 'Read company knowledge',
  'knowledge.write': 'Save to company knowledge',
  'comms.send': 'Message colleagues',
  'github.read': 'Read authorised repositories',
  'github.propose': 'Propose code changes (owner approves)',
  'github.issue': 'Request GitHub issues (owner approves)',
  'external.publish': 'Request external publishing (owner approves)'
};

/** Edit an employee: identity, responsibilities, instructions, permissions, model. Also used to hire. */
export function EmployeeDialog({ employee, mode, onClose }: { employee?: Employee; mode: 'responsibilities' | 'permissions' | 'all' | 'create'; onClose: () => void }) {
  const { t } = useI18n();
  const depts = useApi<Department[]>('/departments');
  const emps = useApi<Employee[]>('/employees');
  const providers = useApi<{ id: string; label: string; model: string }[]>('/providers');
  const perms = useApi<string[]>('/tool-permissions');
  const [f, setF] = useState({
    name: employee?.name ?? '',
    title: employee?.title ?? '',
    title_ar: employee?.title_ar ?? '',
    department_id: employee?.department_id ?? 'development',
    manager_id: employee?.manager_id ?? '',
    personality: employee?.personality ?? '',
    skills: (employee?.skills ?? []).join(', '),
    responsibilities: (employee?.responsibilities ?? []).join('\n'),
    instructions: employee?.instructions ?? '',
    role_memory: employee?.role_memory ?? '',
    tools: employee?.tools ?? ['knowledge.read', 'comms.send'],
    provider_id: employee?.provider_id ?? '',
    model_override: employee?.model_override ?? '',
    active: employee?.active ?? true
  });
  const act = useAction();
  const show = (s: 'identity' | 'resp' | 'perm') => mode === 'all' || mode === 'create' || (s === 'resp' && mode === 'responsibilities') || (s === 'perm' && mode === 'permissions');
  const save = async () => {
    const body: Record<string, unknown> = {};
    if (show('identity')) Object.assign(body, { name: f.name, title: f.title, title_ar: f.title_ar, department_id: f.department_id, manager_id: f.manager_id || null, personality: f.personality, skills: f.skills.split(',').map((s) => s.trim()).filter(Boolean) });
    if (show('resp')) Object.assign(body, { responsibilities: f.responsibilities.split('\n').map((s) => s.trim()).filter(Boolean), instructions: f.instructions, role_memory: f.role_memory });
    if (show('perm')) Object.assign(body, { tools: f.tools, provider_id: f.provider_id || null, model_override: f.model_override || null, active: f.active });
    const ok = await act.run(() => (employee ? api(`/employees/${employee.id}`, { method: 'PATCH', body }) : api('/employees', { body })));
    if (ok) onClose();
  };
  const title = mode === 'create' ? 'Hire an AI employee' : mode === 'permissions' ? t.profile.permissions : mode === 'responsibilities' ? t.profile.responsibilities : t.common.edit;
  return (
    <Modal title={`${title}${employee ? ` — ${employee.name}` : ''}`} onClose={onClose} wide>
      <div className="form">
        {show('identity') ? (
          <>
            <div className="grid-2">
              <Field label="Name">
                <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              </Field>
              <Field label="Job title">
                <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
              </Field>
              <Field label="Job title (Arabic)">
                <input dir="rtl" value={f.title_ar} onChange={(e) => setF({ ...f, title_ar: e.target.value })} />
              </Field>
              <Field label="Department">
                <select value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
                  {(depts.data ?? []).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name_en}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t.profile.manager}>
                <EmployeeSelect value={f.manager_id} onChange={(v) => setF({ ...f, manager_id: v })} employees={emps.data ?? []} allowEmpty="— owner —" exclude={employee?.id} />
              </Field>
              <Field label="Skills" hint="Comma separated">
                <input value={f.skills} onChange={(e) => setF({ ...f, skills: e.target.value })} />
              </Field>
            </div>
            <Field label={t.profile.personality}>
              <textarea rows={2} value={f.personality} onChange={(e) => setF({ ...f, personality: e.target.value })} />
            </Field>
          </>
        ) : null}
        {show('resp') ? (
          <>
            <Field label={t.profile.responsibilitiesL} hint="One per line. Part of the employee's role prompt.">
              <textarea rows={6} value={f.responsibilities} onChange={(e) => setF({ ...f, responsibilities: e.target.value })} />
            </Field>
            <Field label="Standing instructions" hint="Rules this employee always follows (tone, standards, constraints).">
              <textarea rows={3} value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} />
            </Field>
            <Field label={t.profile.roleNotes}>
              <textarea rows={3} value={f.role_memory} onChange={(e) => setF({ ...f, role_memory: e.target.value })} />
            </Field>
          </>
        ) : null}
        {show('perm') ? (
          <>
            <fieldset className="perm-list">
              <legend>Tools this employee may use</legend>
              {(perms.data ?? []).map((p) => (
                <label key={p} className="check">
                  <input type="checkbox" checked={f.tools.includes(p)} onChange={(e) => setF({ ...f, tools: e.target.checked ? [...f.tools, p] : f.tools.filter((x) => x !== p) })} />
                  <span>{TOOL_LABELS[p] ?? p}</span> <code>{p}</code>
                </label>
              ))}
              <p className="muted small">Company-wide limits (Settings → Permissions) apply on top. Anything with outside effect always needs your approval.</p>
            </fieldset>
            <div className="grid-2">
              <Field label="AI provider" hint="Default provider unless set.">
                <select value={f.provider_id} onChange={(e) => setF({ ...f, provider_id: e.target.value })}>
                  <option value="">— default —</option>
                  {(providers.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} ({p.model})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Model override" hint="Optional, e.g. claude-sonnet-5-5 for cheaper routine work.">
                <input value={f.model_override} onChange={(e) => setF({ ...f, model_override: e.target.value })} />
              </Field>
            </div>
            <label className="check">
              <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
              <span>Active (inactive employees take no work and appear in the lounge)</span>
            </label>
          </>
        ) : null}
        <ErrorBox error={act.error} />
        <div className="row end gap-2">
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button variant="primary" disabled={act.busy} onClick={save}>
            {mode === 'create' ? t.common.create : t.common.save}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
