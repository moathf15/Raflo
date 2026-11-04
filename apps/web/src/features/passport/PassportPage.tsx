import { rankPlaces, type Passport, type PassportStats, type Place, type Trip } from '@riflo/core';
import { Button, EmptyState, ErrorState, Skeleton, Stamp, useAsync } from '@riflo/ui';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Screen } from '../../app/AppShell';
import { useServices } from '../../app/services';
import { t } from '../../i18n';
import { shortDate, todayIso } from '../../lib/format';
import { PlaceSheet } from '../places/PlaceSheet';

const TILTS = [-6, 4, -3, 6, -2, 5];

export function PassportPage() {
  const { api, user, requireSignIn, signOut } = useServices();
  const guest = api.auth.requiresAccount && !user;
  const [openPlace, setOpenPlace] = useState<string | null>(null);
  const { state, reload, refresh } = useAsync(async () => {
    const [passport, stats, trips, places] = await Promise.all([api.getPassport(), api.getPassportStats(), api.listTrips(), api.listPlaces('madinah')]);
    return { passport, stats, trips, places };
  }, [user?.id]);

  return (
    <Screen nav>
      {guest && (
        <EmptyState icon="passport" title={t.auth.guestPassportTitle} body={t.auth.guestPassportBody} action={<Button variant="primary" onClick={() => requireSignIn()}>{t.auth.signIn}</Button>} />
      )}
      {!guest && state.status === 'loading' && <div className="page"><Skeleton height={120} /><Skeleton height={200} /></div>}
      {!guest && state.status === 'error' && <ErrorState title={t.common.loadError} body={t.common.loadErrorBody} retryLabel={t.common.retry} onRetry={reload} />}
      {!guest && state.status === 'ready' && <PassportView {...state.data} onOpen={setOpenPlace} onSignOut={api.auth.requiresAccount ? signOut : undefined} />}
      <PlaceSheet placeId={openPlace} onClose={() => setOpenPlace(null)} onChanged={refresh} />
    </Screen>
  );
}

function PassportView({ passport, stats, trips, places, onOpen, onSignOut }: { passport: Passport; stats: PassportStats; trips: Trip[]; places: Place[]; onOpen: (id: string) => void; onSignOut?: () => void }) {
  const [tab, setTab] = useState(0);
  const navigate = useNavigate();
  const name = passport.displayName ?? t.traveller;
  const byId = new Map(places.map((p) => [p.id, p]));
  const visited = new Set(passport.visits.map((v) => v.placeId));
  const prefs = passport.lastPreferences;
  const suggestion = prefs ? rankPlaces(places, { ...prefs, startDate: todayIso(), endDate: todayIso() }, []).find((p) => !visited.has(p.id) && !passport.wishList.includes(p.id)) : undefined;

  return (
    <>
      <header style={{ background: 'var(--sand-200)', padding: '20px 16px 16px' }}>
        <div className="row" style={{ gap: 12 }}>
          <span aria-hidden="true" style={{ width: 52, height: 52, borderRadius: '50%', background: 'var(--palm-700)', color: 'var(--on-dark)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontSize: 20 }}>{name.charAt(0)}</span>
          <div>
            <p className="t-cap">{t.passport.title}</p>
            <h1 className="t-h2">{name}</h1>
          </div>
          {onSignOut && <button type="button" className="link" style={{ marginInlineStart: 'auto', fontWeight: 400, fontSize: 13 }} onClick={onSignOut}>{t.auth.signOut}</button>}
        </div>
        <div className="stats" style={{ marginTop: 16 }}>
          <div><p className="t-num">{stats.trips}</p><p className="t-cap">{t.passport.trips}</p></div>
          <div><p className="t-num">{stats.placesVisited}</p><p className="t-cap">{t.passport.places}</p></div>
          <div><p className="t-num">{stats.travelDays}</p><p className="t-cap">{t.passport.days}</p></div>
        </div>
      </header>
      <div className="tabs" role="tablist">
        {t.passport.tabs.map((label, i) => (
          <button key={label} role="tab" aria-selected={tab === i} onClick={() => setTab(i)}>{label}</button>
        ))}
      </div>
      <div className="page">
        {tab === 0 &&
          (passport.visits.length === 0 ? (
            <EmptyState icon="passport" title={t.passport.noStamps} body={t.passport.noStampsBody} />
          ) : (
            <div className="stamps">
              {passport.visits.map((v, i) => (
                <button key={v.id} type="button" onClick={() => onOpen(v.placeId)} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }}>
                  <Stamp name={byId.get(v.placeId)?.name ?? '—'} date={shortDate(v.date)} tilt={TILTS[i % TILTS.length]} />
                </button>
              ))}
            </div>
          ))}
        {tab === 1 &&
          (trips.length === 0 ? (
            <EmptyState icon="route" title={t.passport.noTrips} action={<Button variant="primary" onClick={() => navigate('/plan/new')}>{t.passport.planNew}</Button>} />
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {trips.map((tr) => (
                <div key={tr.id} className="list-row between">
                  <Link to={`/trips/${tr.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                    <span className="t-label" style={{ display: 'block' }}>{tr.title}</span>
                    <span className="t-cap muted">{shortDate(tr.preferences.startDate)} – {shortDate(tr.preferences.endDate)}</span>
                  </Link>
                  <Link to={`/plan/new?from=${tr.id}`} className="link">{t.home.reuse}</Link>
                </div>
              ))}
            </div>
          ))}
        {tab === 2 &&
          (passport.wishList.length === 0 ? (
            <EmptyState icon="bookmark" title={t.passport.noWish} body={t.passport.noWishBody} action={<Button onClick={() => navigate('/explore')}>{t.nav.explore}</Button>} />
          ) : (
            <div className="stamps">
              {passport.wishList.map((id) => (
                <button key={id} type="button" onClick={() => onOpen(id)} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', display: 'grid', justifyItems: 'center', gap: 6 }}>
                  <Stamp name={byId.get(id)?.name ?? '—'} date="" planned />
                  <span className="t-cap muted">{t.passport.inList}</span>
                </button>
              ))}
            </div>
          ))}
        {suggestion && prefs && (
          <div className="card" style={{ padding: '14px 16px', display: 'grid', gap: 4 }}>
            <p className="t-cap muted">{t.passport.because} {prefs.interests.map((c) => t.categories[c]).join('، ')}</p>
            <button type="button" className="t-h3" style={{ background: 'none', border: 0, padding: 0, textAlign: 'start', cursor: 'pointer', fontSize: 16 }} onClick={() => onOpen(suggestion.id)}>{suggestion.name}</button>
            <Link to="/plan/new" className="link">{t.passport.planNew}</Link>
          </div>
        )}
      </div>
    </>
  );
}
