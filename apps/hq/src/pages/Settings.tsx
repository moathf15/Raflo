import { useEffect, useState } from 'react';
import { Page } from '../App';
import { Button, Card, ErrorBox, Field, Loading, Modal, Pill, Tabs } from '../components/ui';
import { api, useAction, useApi } from '../lib/api';
import { fmtDateTime } from '../lib/format';

interface Provider {
  id: string;
  kind: 'anthropic' | 'openai';
  label: string;
  model: string;
  base_url: string | null;
  temperature: number | null;
  max_tokens: number;
  effort: string | null;
  is_default: boolean;
  enabled: boolean;
  last_check: { ok: boolean; error?: string; at: string } | null;
  api_key: string;
}
type Settings = {
  limits: Record<string, number>;
  policy: { planRequiresApproval: boolean; githubRead: boolean; githubWriteBranches: boolean; githubPullRequests: boolean; githubMerge: boolean; confidentialToProvider: boolean; protectedBranches: string[] };
  pricing: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>;
  company: { name: string; mission: string };
};

type Tab = 'providers' | 'limits' | 'permissions' | 'pricing' | 'company';

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('providers');
  const s = useApi<Settings>('/settings');
  return (
    <Page title="Settings">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'providers', label: 'AI providers' },
          { id: 'limits', label: 'Limits & budget' },
          { id: 'permissions', label: 'Permissions' },
          { id: 'pricing', label: 'Pricing' },
          { id: 'company', label: 'Company' }
        ]}
      />
      {tab === 'providers' ? <Providers /> : null}
      {!s.data ? s.error ? <ErrorBox error={s.error} /> : tab !== 'providers' ? <Loading /> : null : null}
      {s.data && tab === 'limits' ? <LimitsForm value={s.data.limits} onSaved={s.reload} /> : null}
      {s.data && tab === 'permissions' ? <PolicyForm value={s.data.policy} onSaved={s.reload} /> : null}
      {s.data && tab === 'pricing' ? <PricingForm value={s.data.pricing} onSaved={s.reload} /> : null}
      {s.data && tab === 'company' ? <CompanyForm value={s.data.company} onSaved={s.reload} /> : null}
    </Page>
  );
}

function Providers() {
  const list = useApi<Provider[]>('/providers', ['providers.changed']);
  const [edit, setEdit] = useState<Provider | 'new' | null>(null);
  const act = useAction();
  return (
    <Card title="AI providers" actions={<Button variant="primary" onClick={() => setEdit('new')}>Add provider</Button>}>
      <p className="muted small">
        Employees run on the default provider unless an employee has its own. Keys are encrypted at rest and never shown again. Without a provider, nothing runs: tasks are blocked with a clear reason and no work is simulated.
      </p>
      <ErrorBox error={list.error ?? act.error} />
      {list.data?.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Model</th>
                <th>Key</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.label}</strong> <span className="muted small">{p.kind}</span> {p.is_default ? <Pill tone="good">default</Pill> : null} {!p.enabled ? <Pill tone="muted">disabled</Pill> : null}
                  </td>
                  <td>
                    <code>{p.model}</code>
                    <div className="small muted">
                      max {p.max_tokens} tokens{p.effort ? ` · effort ${p.effort}` : ''}
                      {p.temperature != null ? ` · temperature ${p.temperature}` : ''}
                    </div>
                  </td>
                  <td>
                    <code>{p.api_key}</code>
                  </td>
                  <td>{p.last_check ? <span className={p.last_check.ok ? 'good' : 'bad'}>{p.last_check.ok ? `Connected · ${fmtDateTime(p.last_check.at)}` : p.last_check.error}</span> : <span className="muted small">Not tested</span>}</td>
                  <td className="row gap-1">
                    <Button small disabled={act.busy} onClick={() => act.run(() => api(`/providers/${p.id}/test`, { body: {} })).then(list.reload)}>
                      Test connection
                    </Button>
                    <Button small onClick={() => setEdit(p)}>
                      Edit
                    </Button>
                    <Button small variant="danger" onClick={() => confirm(`Delete ${p.label}?`) && void act.run(() => api(`/providers/${p.id}`, { method: 'DELETE' })).then(list.reload)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : list.data ? (
        <div className="setup-banner">
          <strong>No AI provider configured.</strong> Add an Anthropic or OpenAI key to bring your employees to life.
        </div>
      ) : (
        <Loading />
      )}
      {edit ? <ProviderDialog p={edit === 'new' ? null : edit} onClose={() => (setEdit(null), list.reload())} /> : null}
    </Card>
  );
}

function ProviderDialog({ p, onClose }: { p: Provider | null; onClose: () => void }) {
  const [f, setF] = useState({
    kind: p?.kind ?? 'anthropic',
    label: p?.label ?? 'Claude',
    model: p?.model ?? 'claude-opus-5-5',
    api_key: '',
    base_url: p?.base_url ?? '',
    temperature: p?.temperature?.toString() ?? '',
    max_tokens: p?.max_tokens ?? 16000,
    effort: p?.effort ?? 'medium',
    is_default: p?.is_default ?? false,
    enabled: p?.enabled ?? true
  });
  const act = useAction();
  useEffect(() => {
    if (!p) setF((x) => (x.kind === 'openai' ? { ...x, label: x.label === 'Claude' ? 'OpenAI' : x.label, model: x.model.startsWith('claude') ? '' : x.model, effort: '' } : { ...x, temperature: '' }));
  }, [f.kind, p]);
  return (
    <Modal title={p ? `Edit ${p.label}` : 'Add AI provider'} onClose={onClose}>
      <div className="form">
        {!p ? (
          <Field label="Provider">
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as 'anthropic' | 'openai' })}>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI or OpenAI-compatible</option>
            </select>
          </Field>
        ) : null}
        <div className="grid-2">
          <Field label="Label">
            <input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
          </Field>
          <Field label="Model" hint={f.kind === 'anthropic' ? 'e.g. claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5' : 'The model id from your provider'}>
            <input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} />
          </Field>
        </div>
        <Field label={p ? 'New API key (leave empty to keep)' : 'API key'}>
          <input type="password" autoComplete="off" value={f.api_key} onChange={(e) => setF({ ...f, api_key: e.target.value })} />
        </Field>
        <div className="grid-3">
          <Field label="Max output tokens">
            <input type="number" min={256} max={128000} value={f.max_tokens} onChange={(e) => setF({ ...f, max_tokens: Number(e.target.value) })} />
          </Field>
          {f.kind === 'anthropic' ? (
            <Field label="Effort" hint="Thinking depth and token spend.">
              <select value={f.effort} onChange={(e) => setF({ ...f, effort: e.target.value })}>
                {['', 'low', 'medium', 'high', 'xhigh', 'max'].map((x) => (
                  <option key={x} value={x}>
                    {x || 'model default'}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Temperature" hint="Optional, where the model supports it.">
              <input type="number" step="0.1" min={0} max={2} value={f.temperature} onChange={(e) => setF({ ...f, temperature: e.target.value })} />
            </Field>
          )}
          <Field label="Base URL" hint="Optional (proxies, compatible endpoints).">
            <input value={f.base_url} onChange={(e) => setF({ ...f, base_url: e.target.value })} />
          </Field>
        </div>
        {f.kind === 'anthropic' ? <p className="small muted">Temperature is not offered: current Claude models do not accept it. Claude Opus 5.5 / Sonnet 5.5 requests opt into Anthropic's server-side refusal fallback.</p> : null}
        <label className="check">
          <input type="checkbox" checked={f.is_default} onChange={(e) => setF({ ...f, is_default: e.target.checked })} /> Default provider
        </label>
        <label className="check">
          <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Enabled
        </label>
        <ErrorBox error={act.error} />
        <Button
          variant="primary"
          disabled={act.busy || !f.model || (!p && f.api_key.length < 10)}
          onClick={async () => {
            const body: Record<string, unknown> = {
              label: f.label,
              model: f.model,
              base_url: f.base_url || null,
              max_tokens: f.max_tokens,
              effort: f.kind === 'anthropic' ? f.effort || null : null,
              temperature: f.kind === 'openai' && f.temperature !== '' ? Number(f.temperature) : null,
              is_default: f.is_default,
              enabled: f.enabled
            };
            if (f.api_key) body.api_key = f.api_key;
            if (!p) body.kind = f.kind;
            const r = await act.run(() => (p ? api(`/providers/${p.id}`, { method: 'PATCH', body }) : api<{ id: string }>('/providers', { body })));
            if (r !== undefined) onClose();
          }}
        >
          Save
        </Button>
      </div>
    </Modal>
  );
}

const LIMIT_LABELS: Record<string, [string, string]> = {
  maxConcurrency: ['Concurrent AI runs', 'How many employees may run at the same time. Employees only run when they have work.'],
  dailyBudgetUsd: ['Daily budget (USD)', 'Runs stop before the next model call once reached.'],
  monthlyBudgetUsd: ['Monthly budget (USD)', ''],
  maxToolIterations: ['Max steps per run', 'Model calls in one run before it is stopped.'],
  maxTokensPerRun: ['Max tokens per run', ''],
  runTimeoutSeconds: ['Run timeout (seconds)', ''],
  maxAttempts: ['Attempts per task', 'Automatic retries for transient failures.'],
  maxRevisions: ['Max review revisions', 'Review loops stop and ask you after this many.'],
  maxSubtasks: ['Max subtasks per plan', ''],
  maxDelegationDepth: ['Delegation depth', 'Plans cannot create plans beyond this depth (prevents runaway delegation).'],
  maxMeetingRounds: ['Max discussion rounds per agenda item', ''],
  maxMeetingParticipants: ['Max meeting participants', '']
};

function LimitsForm({ value, onSaved }: { value: Record<string, number>; onSaved: () => void }) {
  const [f, setF] = useState(value);
  const act = useAction();
  return (
    <Card title="Limits & budget">
      <div className="grid-3">
        {Object.entries(LIMIT_LABELS).map(([k, [label, hint]]) => (
          <Field key={k} label={label} hint={hint}>
            <input type="number" step={k.includes('Usd') ? '0.5' : '1'} value={f[k]} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} />
          </Field>
        ))}
      </div>
      <ErrorBox error={act.error} />
      <Button variant="primary" disabled={act.busy} onClick={() => act.run(() => api('/settings/limits', { method: 'PUT', body: f })).then(onSaved)}>
        Save limits
      </Button>
    </Card>
  );
}

function PolicyForm({ value, onSaved }: { value: Settings['policy']; onSaved: () => void }) {
  const [f, setF] = useState(value);
  const act = useAction();
  const item = (k: keyof Settings['policy'], label: string, hint: string, danger = false) => (
    <label className={`check policy${danger ? ' danger' : ''}`}>
      <input type="checkbox" checked={!!f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} />
      <span>
        <strong>{label}</strong>
        <span className="small muted">{hint}</span>
      </span>
    </label>
  );
  return (
    <Card title="Company permissions">
      {item('planRequiresApproval', 'Plans need my approval', 'The Chief of Staff waits for you before delegating any work.')}
      {item('githubRead', 'Agents may read authorised repositories', 'Only employees with the github.read tool, only repositories you authorised.')}
      {item('githubWriteBranches', 'Approved code changes may be committed to new hq/* branches', 'Each change still needs your approval; HQ never writes the default or protected branches.')}
      {item('githubPullRequests', 'Pull requests may be opened', 'Each pull request still needs your explicit click.')}
      {item('githubMerge', 'Pull requests may be merged', 'Each merge needs you to type the PR number. Off by default.', true)}
      {item('confidentialToProvider', 'Confidential knowledge may be sent to the AI provider', 'Off by default: confidential entries are excluded from retrieval.', true)}
      <Field label="Protected branches" hint="Comma separated. Never written, in addition to each repository's default branch.">
        <input value={f.protectedBranches.join(', ')} onChange={(e) => setF({ ...f, protectedBranches: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
      </Field>
      <p className="small muted">Never autonomous, whatever the settings: deleting repository data, deploying to production, sending email or publishing externally. The security engineer only performs passive, read-only analysis.</p>
      <ErrorBox error={act.error} />
      <Button variant="primary" disabled={act.busy} onClick={() => act.run(() => api('/settings/policy', { method: 'PUT', body: f })).then(onSaved)}>
        Save permissions
      </Button>
    </Card>
  );
}

function PricingForm({ value, onSaved }: { value: Settings['pricing']; onSaved: () => void }) {
  const [rows, setRows] = useState(Object.entries(value).map(([model, p]) => ({ model, ...p })));
  const act = useAction();
  return (
    <Card title="Model pricing (USD per million tokens)">
      <p className="small muted">Used to estimate cost from recorded token counts. Claude prices are Anthropic's list prices; add any other model you use, or its cost is not counted toward budgets.</p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Input</th>
              <th>Output</th>
              <th>Cache read</th>
              <th>Cache write</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {(['model', 'input', 'output', 'cacheRead', 'cacheWrite'] as const).map((k) => (
                  <td key={k}>
                    <input
                      aria-label={k}
                      type={k === 'model' ? 'text' : 'number'}
                      step="0.01"
                      value={(r[k] as string | number | undefined) ?? ''}
                      onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, [k]: k === 'model' ? e.target.value : e.target.value === '' ? undefined : Number(e.target.value) } : x)))}
                    />
                  </td>
                ))}
                <td>
                  <Button small variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    ×
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row gap-2">
        <Button onClick={() => setRows([...rows, { model: '', input: 0, output: 0 }])}>Add model</Button>
        <Button variant="primary" disabled={act.busy} onClick={() => act.run(() => api('/settings/pricing', { method: 'PUT', body: Object.fromEntries(rows.filter((r) => r.model).map(({ model, ...p }) => [model, p])) })).then(onSaved)}>
          Save pricing
        </Button>
      </div>
      <ErrorBox error={act.error} />
    </Card>
  );
}

function CompanyForm({ value, onSaved }: { value: Settings['company']; onSaved: () => void }) {
  const [f, setF] = useState(value);
  const act = useAction();
  return (
    <Card title="Company">
      <Field label="Company name">
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <Field label="Mission and priorities" hint="Included in every employee's role prompt. Keep it short and stable.">
        <textarea rows={5} value={f.mission} onChange={(e) => setF({ ...f, mission: e.target.value })} />
      </Field>
      <ErrorBox error={act.error} />
      <Button variant="primary" disabled={act.busy} onClick={() => act.run(() => api('/settings/company', { method: 'PUT', body: f })).then(onSaved)}>
        Save
      </Button>
    </Card>
  );
}
