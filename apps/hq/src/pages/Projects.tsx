import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../App';
import { Button, Card, Empty, ErrorBox, Field, Loading, Modal, StatusPill } from '../components/ui';
import { api, useAction, useApi } from '../lib/api';
import type { Project } from '../lib/types';

export function ProjectsPage() {
  const projects = useApi<Project[]>('/projects', ['task', 'tasks.changed']);
  const repos = useApi<{ repos: { full_name: string; allowed: boolean }[] }>('/github/status');
  const [edit, setEdit] = useState<Project | 'new' | null>(null);
  return (
    <Page title="Projects" actions={<Button variant="primary" onClick={() => setEdit('new')}>New project</Button>}>
      <ErrorBox error={projects.error} onRetry={projects.reload} />
      {!projects.data ? <Loading /> : !projects.data.length ? <Empty>No projects yet. A project groups tasks, meetings, knowledge and a repository.</Empty> : null}
      <div className="cards-grid">
        {(projects.data ?? []).map((p) => (
          <Card key={p.id} title={p.name} actions={<StatusPill status={p.status === 'active' ? 'in_progress' : p.status === 'completed' ? 'completed' : 'backlog'} label={p.status} />}>
            <p className="small clamp">{p.description || 'No description.'}</p>
            {p.repo ? <p className="small">Repository: <code>{p.repo}</code></p> : null}
            <div className="bar" aria-hidden>
              <span style={{ width: `${p.tasks ? ((p.completed ?? 0) / p.tasks) * 100 : 0}%` }} />
            </div>
            <p className="small muted">
              {p.completed}/{p.tasks} tasks completed{p.blocked ? ` · ${p.blocked} blocked` : ''}
            </p>
            <div className="row gap-2">
              <Link to={`/tasks?project=${p.id}`} className="btn btn-sm">
                Tasks
              </Link>
              <Button small onClick={() => setEdit(p)}>
                Edit
              </Button>
            </div>
          </Card>
        ))}
      </div>
      {edit ? <ProjectDialog project={edit === 'new' ? null : edit} repos={(repos.data?.repos ?? []).filter((r) => r.allowed).map((r) => r.full_name)} onClose={() => (setEdit(null), projects.reload())} /> : null}
    </Page>
  );
}

function ProjectDialog({ project, repos, onClose }: { project: Project | null; repos: string[]; onClose: () => void }) {
  const [f, setF] = useState({ name: project?.name ?? '', description: project?.description ?? '', status: project?.status ?? 'active', repo: project?.repo ?? '' });
  const act = useAction();
  return (
    <Modal title={project ? 'Edit project' : 'New project'} onClose={onClose}>
      <div className="form">
        <Field label="Name">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Description" hint="Shared with employees working on this project.">
          <textarea rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label="Status" hint="Paused projects run no tasks.">
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            {['active', 'paused', 'completed', 'archived'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Repository" hint="Only repositories authorised in the GitHub screen.">
          <select value={f.repo} onChange={(e) => setF({ ...f, repo: e.target.value })}>
            <option value="">— none —</option>
            {repos.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </Field>
        <ErrorBox error={act.error} />
        <Button
          variant="primary"
          disabled={act.busy || f.name.length < 2}
          onClick={async () => {
            const body = { ...f, repo: f.repo || null };
            if ((await act.run(() => (project ? api(`/projects/${project.id}`, { method: 'PATCH', body }) : api('/projects', { body })))) !== undefined) onClose();
          }}
        >
          Save
        </Button>
      </div>
    </Modal>
  );
}
