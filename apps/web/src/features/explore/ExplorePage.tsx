import { type CategoryId, type Passport, type Place } from '@riflo/core';
import { EmptyState, ErrorState, Icon, ImageSlot, Skeleton, useAsync } from '@riflo/ui';
import { useMemo, useState } from 'react';
import { Screen } from '../../app/AppShell';
import { useServices } from '../../app/services';
import { t } from '../../i18n';
import { PlaceSheet } from '../places/PlaceSheet';
import { costText } from '../places/placeText';

export function ExplorePage() {
  const { api, requireSignIn } = useServices();
  const [openPlace, setOpenPlace] = useState<string | null>(null);
  const { state, reload, refresh, set } = useAsync(async () => {
    const [places, passport] = await Promise.all([api.listPlaces('madinah'), api.getPassport()]);
    return { places, passport };
  }, []);

  return (
    <Screen nav>
      {state.status === 'loading' && <div className="page"><Skeleton height={36} /><Skeleton height={48} />{[0, 1, 2].map((i) => <Skeleton key={i} height={108} />)}</div>}
      {state.status === 'error' && <ErrorState title={t.common.loadError} body={t.common.loadErrorBody} retryLabel={t.common.retry} onRetry={reload} />}
      {state.status === 'ready' && (
        <ExploreView
          {...state.data}
          onOpen={setOpenPlace}
          onToggle={async (id) => {
            if (!(await requireSignIn())) return;
            const wishList = await api.toggleWish(id);
            set({ ...state.data, passport: { ...state.data.passport, wishList } });
          }}
        />
      )}
      <PlaceSheet placeId={openPlace} onClose={() => setOpenPlace(null)} onChanged={refresh} />
    </Screen>
  );
}

function ExploreView({ places, passport, onOpen, onToggle }: { places: Place[]; passport: Passport; onOpen: (id: string) => void; onToggle: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<CategoryId | 'all'>('all');
  const interests = passport.lastPreferences?.interests ?? [];
  const categories = [...new Set(places.map((p) => p.category))];

  const shown = useMemo(() => {
    const q = query.trim();
    return places
      .filter((p) => (cat === 'all' || p.category === cat) && (!q || p.name.includes(q) || p.summary.includes(q)))
      .sort((a, b) => Number(interests.includes(b.category)) - Number(interests.includes(a.category)));
  }, [places, query, cat, interests]);

  return (
    <>
      <div style={{ padding: '20px 16px 12px', background: 'var(--surface)', borderBottom: '1px solid var(--line)', display: 'grid', gap: 12 }}>
        <h1 className="t-display">{t.explore.title}</h1>
        <label className="rf-field" style={{ height: 44 }}>
          <Icon name="search" size={18} />
          <span className="sr-only">{t.explore.search}</span>
          <input type="search" placeholder={t.explore.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="hscroll" role="group" aria-label={t.explore.title}>
          <button type="button" className="rf-pill rf-pill--filter" style={{ height: 36 }} aria-pressed={cat === 'all'} onClick={() => setCat('all')}>{t.explore.all}</button>
          {categories.map((c) => (
            <button key={c} type="button" className="rf-pill rf-pill--filter" style={{ height: 36 }} aria-pressed={cat === c} onClick={() => setCat(c)}>{t.categories[c]}</button>
          ))}
        </div>
      </div>
      <div className="page" style={{ gap: 10, paddingTop: 12 }}>
        {interests.length > 0 && <p className="t-cap muted">{t.explore.sorted}</p>}
        {shown.length === 0 && <EmptyState icon="search" title={t.explore.none} />}
        {shown.map((p) => {
          const saved = passport.wishList.includes(p.id);
          const visited = passport.visits.some((v) => v.placeId === p.id);
          return (
            <div key={p.id} className="list-row">
              <ImageSlot height={84} radius={10} style={{ width: 84 }} />
              <button type="button" onClick={() => onOpen(p.id)} style={{ flex: 1, minWidth: 0, background: 'none', border: 0, padding: 0, textAlign: 'start', cursor: 'pointer', display: 'grid', gap: 2 }}>
                <span className="t-h3" style={{ fontSize: 16, lineHeight: '24px' }}>{p.name}</span>
                <span className="t-cap muted">{t.categories[p.category]} · {p.visitMinutes} د · {costText(p)}</span>
                <span className="t-cap" style={{ color: visited ? 'var(--terracotta-700)' : interests.includes(p.category) ? 'var(--palm-700)' : 'var(--ink-muted)' }}>
                  {visited ? t.trip.visited : interests.includes(p.category) ? t.explore.fits : p.summary}
                </span>
              </button>
              <button type="button" className="rf-icon-btn rf-icon-btn--bare" aria-pressed={saved} aria-label={saved ? t.place.unsave : t.place.save} onClick={() => onToggle(p.id)}>
                <Icon name="bookmark" color={saved ? 'var(--terracotta-600)' : 'currentColor'} />
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
