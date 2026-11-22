import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Page } from '../App';
import { Avatar } from '../components/Avatar';
import { EmployeeProfile } from '../components/EmployeeProfile';
import { EmployeeDialog } from '../components/dialogs';
import { Button, ErrorBox, Loading, Pill } from '../components/ui';
import { api, useApi } from '../lib/api';
import { fmtUsd } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { displayStatus, type Department, type Employee } from '../lib/types';
import { STATUS_COLORS } from '../office/Office';

/** The productivity view of the workforce: a sortable roster with status, work and performance. */
export function EmployeesPage() {
  const { t, lang } = useI18n();
  const [params, setParams] = useSearchParams();
  const dept = params.get('dept') ?? '';
  const archived = params.get('archived') === '1';
  const emps = useApi<Employee[]>(`/employees${archived ? '?archived=true' : ''}`, ['employee.status', 'employees.changed']);
  const depts = useApi<Department[]>('/departments');
  const perf = useApi<{ id: string; completed: number; open: number; accepted: number; avg_rating: string | null; cost_usd: number; failed_runs: number }[]>('/performance', ['task', 'run']);
  const [hire, setHire] = useState(false);
  const [q, setQ] = useState('');
  const open = params.get('employee');
  const list = (emps.data ?? []).filter((e) => (!dept || e.department_id === dept) && (!q || `${e.name} ${e.title} ${e.skills.join(' ')}`.toLowerCase().includes(q.toLowerCase())));
  const p = new Map((perf.data ?? []).map((x) => [x.id, x]));
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    setParams(n);
  };
  return (
    <Page title={t.nav.employees} actions={<Button variant="primary" onClick={() => setHire(true)}>Hire employee</Button>}>
      <div className="toolbar">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`${t.common.search}…`} aria-label={t.common.search} />
        <select value={dept} onChange={(e) => set('dept', e.target.value)} aria-label="Department">
          <option value="">{t.common.all}</option>
          {(depts.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {lang === 'ar' ? d.name_ar : d.name_en}
            </option>
          ))}
        </select>
        <label className="check small">
          <input type="checkbox" checked={archived} onChange={(e) => set('archived', e.target.checked ? '1' : '')} /> Archived
        </label>
      </div>
      <ErrorBox error={emps.error} onRetry={emps.reload} />
      {!emps.data ? <Loading /> : null}
      <div className="table-wrap">
        <table className="table roster">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Department</th>
              <th>Status</th>
              <th>Open / done</th>
              <th>Accepted</th>
              <th>Rating</th>
              <th>AI cost</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((e) => {
              const st = displayStatus(e);
              const x = p.get(e.id);
              return (
                <tr key={e.id}>
                  <td>
                    <button className="roster-btn" onClick={() => set('employee', e.id)}>
                      <Avatar spec={e.avatar} size={34} />
                      <span>
                        <strong>{e.name}</strong>
                        <span className="small muted">{lang === 'ar' && e.title_ar ? e.title_ar : e.title}</span>
                      </span>
                    </button>
                  </td>
                  <td>{t.rooms[e.department_id] ?? e.department_id}</td>
                  <td>
                    <span className="status-chip" style={{ background: STATUS_COLORS[st] }}>
                      {t.status[st]}
                    </span>
                    {e.status_detail && st !== 'idle' ? <div className="small muted clamp1">{e.status_detail}</div> : null}
                  </td>
                  <td>
                    {x?.open ?? 0} / {x?.completed ?? 0}
                  </td>
                  <td>{x?.accepted ?? 0}</td>
                  <td>{x?.avg_rating ?? '—'}</td>
                  <td>{fmtUsd(x?.cost_usd ?? 0)}</td>
                  <td>
                    {archived ? (
                      <Button small onClick={() => void api(`/employees/${e.id}/restore`, { body: {} }).then(emps.reload)}>
                        Restore
                      </Button>
                    ) : (
                      <Button
                        small
                        variant="ghost"
                        onClick={() => confirm(`Archive ${e.name}? History is kept; open tasks return to the backlog.`) && void api(`/employees/${e.id}`, { method: 'DELETE' }).then(emps.reload)}
                      >
                        Archive
                      </Button>
                    )}
                    {!e.active && !archived ? <Pill tone="muted">inactive</Pill> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hire ? <EmployeeDialog mode="create" onClose={() => (setHire(false), emps.reload())} /> : null}
      {open ? <EmployeeProfile id={open} onClose={() => set('employee', '')} /> : null}
    </Page>
  );
}
