import type { AdminReport, ReportStatus } from '@riflo/core';
import { Button, Chip, EmptyState, ErrorState, Skeleton, useAsync, type ChipTone } from '@riflo/ui';
import { useState } from 'react';
import { AdminShell } from '../../app/AdminShell';
import { useServices } from '../../app/services';
import { ar as t } from '../../i18n/ar';

type Tab = 'open' | 'resolved' | 'rejected';
const TONE: Record<ReportStatus, ChipTone> = { new: 'danger', in_review: 'busy', reopened: 'danger', resolved: 'open', rejected: 'closed' };
const day = (iso: string) => new Date(iso).toLocaleDateString('ar-SA-u-nu-latn-ca-gregory', { day: 'numeric', month: 'long' });

/** Reports are handled one by one, and closing one needs a reason (audit 5.5). */
export function ReportsPage() {
  const { api, notify } = useServices();
  const [tab, setTab] = useState<Tab>('open');
  const { state, reload, set } = useAsync(() => api.listReports(tab), [tab]);
  const [closing, setClosing] = useState<{ id: string; status: 'resolved' | 'rejected' } | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState(false);

  async function change(r: AdminReport, status: ReportStatus, reason?: string) {
    try {
      const next = await api.updateReport(r.id, status, reason);
      if (state.status === 'ready') {
        const stillHere = tab === 'open' ? ['new', 'in_review', 'reopened'].includes(next.status) : next.status === tab;
        set(stillHere ? state.data.map((x) => (x.id === r.id ? next : x)) : state.data.filter((x) => x.id !== r.id));
      }
      setClosing(null);
      setNote('');
      notify(t.common.saved);
    } catch {
      notify(t.common.saveFailed);
    }
  }

  return (
    <AdminShell title={t.reports.title} subtitle={t.city}>
      <div className="toolbar" role="tablist">
        {(Object.keys(t.reports.tabs) as Tab[]).map((k) => (
          <Button key={k} small role="tab" aria-selected={tab === k} variant={tab === k ? 'solid' : 'secondary'} onClick={() => setTab(k)}>{t.reports.tabs[k]}</Button>
        ))}
      </div>
      {state.status === 'loading' && <Skeleton height={200} />}
      {state.status === 'error' && <ErrorState title={t.common.loadError} body="" retryLabel={t.common.retry} onRetry={reload} />}
      {state.status === 'ready' && state.data.length === 0 && <EmptyState icon="flag" title={t.reports.empty} />}
      {state.status === 'ready' && state.data.length > 0 && (
        <section className="panel">
          {state.data.map((r) => (
            <article key={r.id} className="decide-row" style={{ alignItems: 'flex-start' }}>
              <div style={{ display: 'grid', gap: 4, flex: '1 1 320px', minWidth: 0 }}>
                <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <Chip tone={TONE[r.status]}>{t.reports.statuses[r.status]}</Chip>
                  <Chip tone="closed">{t.reports.kinds[r.kind]}</Chip>
                  <span className="t-label">{r.placeName}</span>
                  <span className="t-cap muted">{day(r.createdAt)}</span>
                </span>
                <span className="t-sm">{r.message || <span className="muted">{t.reports.noMessage}</span>}</span>
                {r.resolutionNote && <span className="t-cap muted">{t.reports.resolution} {r.resolutionNote}</span>}
                {closing?.id === r.id && (
                  <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                    <label className="form-field">
                      <span>{t.reports.notePrompt}</span>
                      <textarea rows={2} value={note} placeholder={t.reports.notePlaceholder} onChange={(e) => { setNote(e.target.value); setNoteError(false); }} aria-invalid={noteError} />
                      {noteError && <span className="err" role="alert">{t.reports.notePrompt}</span>}
                    </label>
                    <div className="row">
                      <Button small variant="solid" onClick={() => (note.trim() ? change(r, closing.status, note.trim()) : setNoteError(true))}>{t.reports.confirm}</Button>
                      <Button small variant="ghost" onClick={() => setClosing(null)}>{t.common.cancel}</Button>
                    </div>
                  </div>
                )}
              </div>
              {closing?.id !== r.id && (
                <div className="row" style={{ gap: 4 }}>
                  {(r.status === 'new' || r.status === 'reopened') && <Button small onClick={() => change(r, 'in_review')}>{t.reports.review}</Button>}
                  {tab === 'open' && <Button small onClick={() => setClosing({ id: r.id, status: 'resolved' })}>{t.reports.resolve}</Button>}
                  {tab === 'open' && <Button small variant="ghost" onClick={() => setClosing({ id: r.id, status: 'rejected' })}>{t.reports.reject}</Button>}
                  {tab !== 'open' && <Button small variant="ghost" onClick={() => change(r, 'reopened')}>{t.reports.reopen}</Button>}
                </div>
              )}
            </article>
          ))}
        </section>
      )}
    </AdminShell>
  );
}
