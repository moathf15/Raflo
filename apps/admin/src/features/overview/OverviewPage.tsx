import type { AdminOverview } from '@riflo/core';
import { Button, Chip, ErrorState, Icon, Skeleton, useAsync } from '@riflo/ui';
import { useNavigate } from 'react-router-dom';
import { AdminShell } from '../../app/AdminShell';
import { useServices } from '../../app/services';
import { ar as t } from '../../i18n/ar';

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const num = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-US'));
type MetricKey = keyof AdminOverview['metrics'];
const METRICS: MetricKey[] = ['registeredUsers', 'activeUsers', 'tripsCreated', 'completionRate', 'returnRate'];
const format = (k: MetricKey, m: AdminOverview['metrics']) => (k === 'completionRate' || k === 'returnRate' ? pct(m[k]) : num(m[k]));

export function OverviewPage() {
  const { api } = useServices();
  const navigate = useNavigate();
  const { state, reload } = useAsync(() => api.getOverview('madinah'), []);

  return (
    <AdminShell title={t.overview.title} subtitle={`${t.city} · ${t.overview.period(state.status === 'ready' ? state.data.periodDays : 30)}`}>
      {state.status === 'loading' && <><Skeleton height={180} /><Skeleton height={100} /></>}
      {state.status === 'error' && <ErrorState title={t.common.loadError} body="" retryLabel={t.common.retry} onRetry={reload} />}
      {state.status === 'ready' && (
        <>
          <section className="panel" aria-labelledby="decide">
            <div className="panel__head">
              <h2 id="decide" className="t-h3">{t.overview.decide}</h2>
              <span className="t-cap muted">{t.overview.decideHint}</span>
            </div>
            {state.data.staleCount + state.data.reportCount + state.data.draftCount === 0 && <p className="decide-row muted">{t.overview.allClear}</p>}
            {state.data.reportCount > 0 && (
              <div className="decide-row">
                <span className="row" style={{ gap: 10 }}><Chip tone="danger">{t.nav.reviews}</Chip>{t.overview.reports(state.data.reportCount)}</span>
                <Button small onClick={() => navigate('/reports')}>{t.overview.open}</Button>
              </div>
            )}
            {state.data.staleCount > 0 && (
              <div className="decide-row">
                <span className="row" style={{ gap: 10 }}><Chip tone="busy">{t.content.chips.review}</Chip>{t.overview.stale(state.data.staleCount)}</span>
                <Button small onClick={() => navigate('/content')}>{t.overview.review}</Button>
              </div>
            )}
            {state.data.draftCount > 0 && (
              <div className="decide-row">
                <span className="row" style={{ gap: 10 }}><Chip tone="closed">{t.content.chips.draft}</Chip>{t.overview.drafts(state.data.draftCount)}</span>
                <Button small onClick={() => navigate('/content')}>{t.overview.complete}</Button>
              </div>
            )}
          </section>

          <section className="kpis" aria-label="المؤشرات">
            {METRICS.map((k) => [k, ...t.overview.kpis[k]] as const).map(([k, label, hint]) => (
              <div key={label} className="kpi">
                <span className="t-sm muted">{label}</span>
                <span className="kpi__value">{format(k, state.data.metrics)}</span>
                <span className="t-cap muted">{hint}</span>
              </div>
            ))}
          </section>

          <div className="two-col">
            <section className="panel" style={{ padding: '16px 20px', display: 'grid', gap: 12 }}>
              <div className="between"><h2 className="t-h3">{t.overview.funnelTitle}</h2>{!state.data.funnel?.some((f) => f.count) && <span className="t-cap muted">{t.overview.noData}</span>}</div>
              {(state.data.funnel ?? []).map((f) => {
                const max = Math.max(1, ...(state.data.funnel ?? []).map((x) => x.count));
                return (
                  <div key={f.step} className="funnel-row">
                    <span>{t.overview.funnelSteps[f.step]}</span>
                    <div className="funnel-bar" style={{ position: 'relative', overflow: 'hidden' }}><div style={{ position: 'absolute', insetBlock: 0, insetInlineStart: 0, width: `${(f.count / max) * 100}%`, background: 'var(--palm-700)', borderRadius: 4 }} /></div>
                    <span>{f.count || '—'}</span>
                  </div>
                );
              })}
              {!state.data.funnel && t.overview.funnel.map((s) => <div key={s} className="funnel-row"><span>{s}</span><div className="funnel-bar" /><span className="muted">—</span></div>)}
            </section>
            <section className="panel" style={{ padding: '16px 20px', display: 'grid', gap: 10, alignContent: 'start' }}>
              <h2 className="t-h3">{t.overview.topPlacesTitle}</h2>
              {state.data.topPlaces?.length ? (
                <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid' }}>
                  {state.data.topPlaces.map((p, i) => (
                    <li key={p.placeId} className="between" style={{ padding: '10px 0', borderBottom: '1px solid var(--line)', fontSize: 14 }}>
                      <span className="row" style={{ gap: 10 }}><span className="t-num" style={{ fontSize: 16, width: 18, color: 'var(--ink-muted)' }}>{i + 1}</span>{p.name}</span>
                      <span className="muted">{t.overview.tripsCount(p.trips)}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <div style={{ display: 'grid', placeItems: 'center', textAlign: 'center', gap: 8, padding: '24px 0' }}>
                  <Icon name="chart" size={28} color="#c9b994" />
                  <p className="t-sm muted" style={{ maxWidth: 320 }}>{t.overview.topPlacesEmpty}</p>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </AdminShell>
  );
}
