import { rankPlaces, type Passport, type Place, type Trip } from '@riflo/core';
import { Button, Chip, ErrorState, Icon, ImageSlot, Skeleton, useAsync } from '@riflo/ui';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Screen } from '../../app/AppShell';
import { useServices } from '../../app/services';
import { t } from '../../i18n';
import { daysUntil, shortDate, todayIso } from '../../lib/format';
import { PlaceSheet } from '../places/PlaceSheet';

export function HomePage() {
  const { api, user } = useServices();
  const navigate = useNavigate();
  const [openPlace, setOpenPlace] = useState<string | null>(null);
  const { state, reload, refresh } = useAsync(async () => {
    const [trips, passport, places, stats] = await Promise.all([api.listTrips(), api.getPassport(), api.listPlaces('madinah'), api.getPassportStats()]);
    return { trips, passport, places, stats };
  }, [user?.id]);

  return (
    <Screen nav>
      {state.status === 'loading' && <HomeSkeleton />}
      {state.status === 'error' && <ErrorState title={t.common.loadError} body={t.common.loadErrorBody} retryLabel={t.common.retry} onRetry={reload} />}
      {state.status === 'ready' &&
        (state.data.trips.length === 0 ? (
          <Welcome places={state.data.places} onOpen={setOpenPlace} onStart={() => navigate('/plan/new')} />
        ) : (
          <Returning {...state.data} onOpen={setOpenPlace} onStart={() => navigate('/plan/new')} />
        ))}
      <PlaceSheet placeId={openPlace} onClose={() => setOpenPlace(null)} onChanged={refresh} />
    </Screen>
  );
}

function HomeSkeleton() {
  return (
    <div className="page" aria-busy="true">
      <Skeleton width="40%" height={28} />
      <Skeleton height={48} />
      <Skeleton height={110} />
      <Skeleton height={52} />
    </div>
  );
}

function SearchLink() {
  return (
    <Link to="/explore" className="rf-field" style={{ textDecoration: 'none' }}>
      <Icon name="search" size={18} />
      {t.home.searchPlaceholder}
    </Link>
  );
}

function PlaceRow({ places, onOpen }: { places: Place[]; onOpen: (id: string) => void }) {
  return (
    <div className="hscroll">
      {places.map((p) => (
        <button key={p.id} type="button" className="place-tile" onClick={() => onOpen(p.id)}>
          <ImageSlot height={116} style={{ width: '100%' }} />
          <span className="t-label">{p.name}</span>
          <span className="t-cap muted">{t.categories[p.category]} · {p.visitMinutes} د</span>
        </button>
      ))}
    </div>
  );
}

function Welcome({ places, onOpen, onStart }: { places: Place[]; onOpen: (id: string) => void; onStart: () => void }) {
  const icons = ['route', 'wallet', 'passport'] as const;
  return (
    <div className="page" style={{ gap: 22 }}>
      <p className="t-h3" style={{ fontFamily: 'var(--font-display)' }}>{t.brand}</p>
      <div style={{ display: 'grid', gap: 8 }}>
        <h1 className="t-display">{t.home.welcomeTitle}</h1>
        <p className="t-body muted">{t.home.welcomeBody}</p>
      </div>
      <ul className="card" style={{ listStyle: 'none', margin: 0, padding: '6px 16px' }}>
        {t.home.benefits.map((b, i) => (
          <li key={b} className="row" style={{ gap: 12, padding: '12px 0', borderBottom: i < 2 ? '1px solid var(--line)' : 0 }}>
            <Icon name={icons[i]} size={22} color="var(--palm-700)" />
            <span className="t-sm">{b}</span>
          </li>
        ))}
      </ul>
      <Button variant="primary" block icon="plus" onClick={onStart}>{t.home.firstTrip}</Button>
      <section className="section">
        <h2 className="t-h3">{t.home.highlights}</h2>
        <PlaceRow places={places.slice(0, 5)} onOpen={onOpen} />
      </section>
    </div>
  );
}

function Returning({ trips, passport, places, stats, onOpen, onStart }: { trips: Trip[]; passport: Passport; places: Place[]; stats: { trips: number; placesVisited: number }; onOpen: (id: string) => void; onStart: () => void }) {
  const today = todayIso();
  const upcoming = trips.find((tr) => tr.preferences.endDate >= today);
  const past = trips.filter((tr) => tr.preferences.endDate < today);
  const visited = new Set(passport.visits.map((v) => v.placeId));
  const prefs = passport.lastPreferences;
  const suggestions = prefs
    ? rankPlaces(places, { ...prefs, startDate: today, endDate: today }, passport.wishList).filter((p) => !visited.has(p.id)).slice(0, 5)
    : places.slice(0, 5);

  return (
    <div className="page" style={{ gap: 20 }}>
      <div>
        <p className="t-cap muted">{t.greeting(new Date().getHours())}</p>
        <h1 className="t-display">{passport.displayName ?? t.traveller}</h1>
      </div>
      <SearchLink />
      {upcoming && <UpcomingTicket trip={upcoming} />}
      <Button variant="primary" block icon="plus" onClick={onStart}>{t.home.newTrip}</Button>
      <section className="section">
        <div className="between">
          <div>
            <h2 className="t-h3">{t.home.forYou}</h2>
            {prefs && <p className="t-cap muted">{t.home.forYouReason}: {prefs.interests.map((c) => t.categories[c]).join('، ')}</p>}
          </div>
          <Link to="/explore" className="link">{t.home.seeAll}</Link>
        </div>
        <PlaceRow places={suggestions} onOpen={onOpen} />
      </section>
      {past.length > 0 && (
        <section className="section">
          <h2 className="t-h3">{t.home.pastTrips}</h2>
          {past.map((tr) => (
            <div key={tr.id} className="between" style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
              <Link to={`/trips/${tr.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                <p className="t-label">{tr.title}</p>
                <p className="t-cap muted">{shortDate(tr.preferences.startDate)}</p>
              </Link>
              <Link to={`/plan/new?from=${tr.id}`} className="link">{t.home.reuse}</Link>
            </div>
          ))}
        </section>
      )}
      <Link to="/passport" className="card between" style={{ padding: '12px 16px', textDecoration: 'none', color: 'inherit', background: 'var(--sand-200)', borderColor: 'var(--sand-200)' }}>
        <span className="row" style={{ gap: 12 }}>
          <Icon name="passport" size={22} color="var(--palm-700)" />
          <span>
            <span className="t-label" style={{ display: 'block' }}>{t.home.passportCard}</span>
            <span className="t-cap">{t.home.passportLine(stats.placesVisited, stats.trips)}</span>
          </span>
        </span>
        <Icon name="forward" size={18} />
      </Link>
    </div>
  );
}

function UpcomingTicket({ trip }: { trip: Trip }) {
  const n = daysUntil(trip.preferences.startDate);
  const stops = trip.days.reduce((s, d) => s + d.stops.length, 0);
  return (
    <section className="section">
      <h2 className="t-label">{t.home.upcoming}</h2>
      <Link to={`/trips/${trip.id}`} className="rf-stop" style={{ borderRadius: 16 }}>
        <span className="rf-stop__stub" style={{ flexBasis: 84 }}>
          {n > 0 ? (
            <>
              <span>{t.home.inDays}</span>
              <span className="rf-stop__time" style={{ fontSize: 30, lineHeight: '34px' }}>{n}</span>
              <span>{t.home.days}</span>
            </>
          ) : (
            <span className="rf-stop__time">{t.home.today}</span>
          )}
        </span>
        <span className="rf-stop__body" style={{ padding: '14px 16px', gap: 4 }}>
          <span className="t-h3">{trip.title}</span>
          <span className="t-sm muted">{shortDate(trip.preferences.startDate)} – {shortDate(trip.preferences.endDate)} · {trip.preferences.travellers} مسافرين</span>
          <span className="row" style={{ marginTop: 6, gap: 6 }}>
            <Chip tone="open" icon="check">{t.home.planReady}</Chip>
            <Chip tone="closed">{t.home.stopsCount(stops)}</Chip>
          </span>
        </span>
      </Link>
    </section>
  );
}
