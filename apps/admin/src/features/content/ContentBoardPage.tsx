import { ApiError, CITIES, isStalePlace, publishProblems, type Place, type PlaceStatus } from '@riflo/core';
import { Button, Chip, ErrorState, ImageSlot, Skeleton, useAsync, type ChipTone } from '@riflo/ui';
import { useMemo, useState } from 'react';
import { AdminShell } from '../../app/AdminShell';
import { useServices } from '../../app/services';
import { ar as t } from '../../i18n/ar';
import { PlaceEditor } from './PlaceEditor';

const COLUMNS: PlaceStatus[] = ['draft', 'review', 'published', 'hidden'];
const TONE: Record<PlaceStatus, ChipTone> = { draft: 'closed', review: 'busy', published: 'open', hidden: 'closed' };

function monthsSince(iso: string) {
  return Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / (864e5 * 30)));
}

export function ContentBoardPage() {
  const { api, notify } = useServices();
  const { state, reload, set } = useAsync(() => api.listPlaces('madinah'), []);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Place | 'new' | null>(null);

  const places = state.status === 'ready' ? state.data : [];
  const filtered = useMemo(() => places.filter((p) => !query.trim() || p.name.includes(query.trim())), [places, query]);

  async function setStatus(p: Place, status: PlaceStatus) {
    let next: Place;
    try {
      next = await api.setStatus(p.id, status);
    } catch (e) {
      // Publishing a place with missing data is refused by the API; say what's missing.
      const missing = publishProblems(p, CITIES.find((c) => c.id === p.cityId));
      notify(e instanceof ApiError && e.message === 'place_incomplete' ? t.content.incomplete(missing.map((m) => t.content.missing[m])) : t.common.saveFailed);
      return;
    }
    set(places.map((x) => (x.id === p.id ? next : x)));
    notify(t.common.saved);
  }
  function onSaved(saved: Place) {
    set(places.some((x) => x.id === saved.id) ? places.map((x) => (x.id === saved.id ? saved : x)) : [...places, saved]);
    setEditing(null);
    notify(t.common.saved);
  }

  return (
    <AdminShell title={t.content.title} subtitle={t.city} actions={<Button variant="solid" icon="plus" onClick={() => setEditing('new')}>{t.content.add}</Button>}>
      <div className="toolbar">
        <label className="rf-field" style={{ height: 40, minWidth: 260 }}>
          <span className="sr-only">{t.content.search}</span>
          <input type="search" placeholder={t.content.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      {state.status === 'loading' && <Skeleton height={320} />}
      {state.status === 'error' && <ErrorState title={t.common.loadError} body="" retryLabel={t.common.retry} onRetry={reload} />}
      {state.status === 'ready' && (
        <div className="board-wrap">
          <div className="board">
            {COLUMNS.map((col) => {
              const items = filtered.filter((p) => p.status === col);
              return (
                <section key={col} className="col" aria-label={t.content.columns[col]}>
                  <h2 className="col__title">{t.content.columns[col]}<span className="muted" style={{ fontWeight: 400 }}>{items.length}</span></h2>
                  {items.length === 0 && <p className="t-cap muted" style={{ padding: '8px 4px' }}>{t.content.empty}</p>}
                  {items.map((p) => <Item key={p.id} place={p} onEdit={() => setEditing(p)} onStatus={(s) => setStatus(p, s)} />)}
                </section>
              );
            })}
          </div>
        </div>
      )}
      {editing && <PlaceEditor place={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={onSaved} />}
    </AdminShell>
  );
}

function Item({ place: p, onEdit, onStatus }: { place: Place; onEdit: () => void; onStatus: (s: PlaceStatus) => void }) {
  const missing = publishProblems(p, CITIES.find((c) => c.id === p.cityId));
  const stale = isStalePlace(p);
  const why =
    p.status !== 'hidden' && missing.length ? t.content.missingLine(missing.map((m) => t.content.missing[m]))
    : p.status === 'hidden' ? t.content.hiddenLine
    : [stale && t.content.staleLine(monthsSince(p.updatedAt)), p.openReports > 0 && t.content.reportsLine(p.openReports)].filter(Boolean).join(' · ') || t.content.upToDate;
  const a = t.content.actions;

  return (
    <article className="item">
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <ImageSlot height={48} radius={6} style={{ width: 48 }} />
        <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 2 }}>
          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
            <Chip tone={TONE[p.status]}>{t.content.chips[p.status]}</Chip>
            {p.openReports > 0 && <Chip tone="danger">{t.content.reportsLine(p.openReports)}</Chip>}
          </div>
          <span className="t-label" style={{ marginTop: 4 }}>{p.name}</span>
          <span className="t-cap muted">{t.categories[p.category]} · {why}</span>
        </div>
      </div>
      <div className="item__actions">
        {p.status === 'draft' && <><Button small onClick={onEdit}>{a.complete}</Button><Button small variant="ghost" onClick={() => onStatus('published')}>{a.publish}</Button></>}
        {p.status === 'review' && <><Button small onClick={onEdit}>{a.update}</Button><Button small variant="ghost" onClick={() => onStatus('published')}>{a.publish}</Button><Button small variant="ghost" onClick={() => onStatus('hidden')}>{a.hide}</Button></>}
        {p.status === 'published' && <><Button small onClick={onEdit}>{a.edit}</Button><Button small variant="ghost" onClick={() => onStatus('hidden')}>{a.hide}</Button></>}
        {p.status === 'hidden' && <Button small onClick={() => onStatus('published')}>{a.republish}</Button>}
      </div>
    </article>
  );
}
