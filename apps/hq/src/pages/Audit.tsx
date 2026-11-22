import { Page } from '../App';
import { ErrorBox, Loading } from '../components/ui';
import { useApi } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useI18n } from '../lib/i18n';

/** Append-only record of owner decisions, configuration changes and agent side effects. */
export function AuditPage() {
  const { lang } = useI18n();
  const log = useApi<{ id: string; actor_type: string; actor_name: string | null; action: string; entity: string; entity_id: string | null; details: Record<string, unknown>; created_at: string }[]>('/audit', ['approvals.changed', 'task']);
  return (
    <Page title="Audit log">
      <ErrorBox error={log.error} onRetry={log.reload} />
      {!log.data ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="table small">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {log.data.map((a) => (
                <tr key={a.id}>
                  <td>{fmtDateTime(a.created_at, lang)}</td>
                  <td>
                    {a.actor_name ?? a.actor_type} <span className="muted">({a.actor_type})</span>
                  </td>
                  <td>
                    <code>{a.action}</code>
                  </td>
                  <td>
                    {a.entity} <span className="muted">{a.entity_id?.slice(0, 8)}</span>
                  </td>
                  <td className="clamp1" title={JSON.stringify(a.details)}>
                    {JSON.stringify(a.details).slice(0, 160)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
