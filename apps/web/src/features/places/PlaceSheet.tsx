import { ApiError, type Passport, type Place } from '@riflo/core';
import { Button, Chip, ErrorState, Icon, IconButton, ImageSlot, Sheet, Skeleton, Stamp, useAsync } from '@riflo/ui';
import { useState } from 'react';
import { useServices } from '../../app/services';
import { t } from '../../i18n';
import { shortDate, todayIso } from '../../lib/format';
import { costText } from './placeText';

interface Props {
  placeId: string | null;
  tripId?: string | null;
  onClose: () => void;
  /** Called after anything that changes the passport (visit, wish list). */
  onChanged?: () => void;
}

export function PlaceSheet({ placeId, tripId = null, onClose, onChanged }: Props) {
  return (
    <Sheet open={!!placeId} onClose={onClose} label={t.place.logTitle}>
      {placeId && <PlaceSheetBody key={placeId} placeId={placeId} tripId={tripId} onChanged={onChanged} />}
    </Sheet>
  );
}

function PlaceSheetBody({ placeId, tripId, onChanged }: { placeId: string; tripId: string | null; onChanged?: () => void }) {
  const { api, notify } = useServices();
  const { state, reload, set } = useAsync(async () => {
    const [place, passport] = await Promise.all([api.getPlace(placeId), api.getPassport()]);
    return { place, passport };
  }, [placeId]);

  if (state.status === 'loading')
    return (
      <div style={{ display: 'grid', gap: 12 }}>
        <Skeleton height={150} />
        <Skeleton width="60%" height={22} />
        <Skeleton width="85%" />
      </div>
    );
  if (state.status === 'error' || !state.data.place)
    return <ErrorState title={t.common.loadError} body={t.common.loadErrorBody} retryLabel={t.common.retry} onRetry={reload} />;

  const { place, passport } = state.data;
  return <Details place={place} passport={passport} tripId={tripId} onPassport={(p) => { set({ place, passport: p }); onChanged?.(); }} notify={notify} />;
}

function Details({ place, passport, tripId, onPassport, notify }: { place: Place; passport: Passport; tripId: string | null; onPassport: (p: Passport) => void; notify: (m: string) => void }) {
  const { api, requireSignIn } = useServices();
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [justStamped, setJustStamped] = useState(false);
  const visit = passport.visits.find((v) => v.placeId === place.id);
  const wished = passport.wishList.includes(place.id);

  async function toggleWish() {
    if (!(await requireSignIn())) return;
    const wishList = await api.toggleWish(place.id);
    onPassport({ ...passport, wishList });
  }
  async function logVisit() {
    if (!(await requireSignIn())) return;
    setBusy(true);
    try {
      const v = await api.logVisit({ placeId: place.id, tripId, date: todayIso(), rating, note: note.trim() });
      setJustStamped(true);
      onPassport({ ...passport, visits: [...passport.visits, v], wishList: passport.wishList.filter((id) => id !== place.id) });
      notify(t.place.logged);
    } catch (e) {
      notify(e instanceof ApiError && e.message in t.place.errors ? t.place.errors[e.message as keyof typeof t.place.errors] : t.place.errors.generic);
    } finally {
      setBusy(false);
    }
  }
  async function removeVisit() {
    if (!visit) return;
    setBusy(true);
    try {
      await api.deleteVisit(visit.id);
      onPassport({ ...passport, visits: passport.visits.filter((v) => v.id !== visit.id) });
      notify(t.place.removed);
    } catch {
      notify(t.place.errors.generic);
    } finally {
      setBusy(false);
    }
  }
  async function report() {
    await api.reportPlace(place.id, '');
    notify(t.place.reported);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ImageSlot height={150} radius={12} />
      <div className="between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 className="t-h2">{place.name}</h2>
          <p className="t-sm muted">{place.summary}</p>
          <div className="row" style={{ marginTop: 6, gap: 6 }}>
            <Chip tone="closed">{t.categories[place.category]}</Chip>
            {visit && <Chip tone="visited" icon="check">{t.trip.visited}</Chip>}
          </div>
        </div>
        <IconButton icon="bookmark" label={wished ? t.place.unsave : t.place.save} aria-pressed={wished} onClick={toggleWish} style={wished ? { color: 'var(--terracotta-600)', borderColor: 'var(--terracotta-600)' } : undefined} />
      </div>

      <div className="info-grid">
        <div><Icon name="clock" size={18} color="var(--palm-700)" /><span className="t-cap muted">{t.place.duration}</span><span className="t-label">{place.visitMinutes} د</span></div>
        <div><Icon name="sun" size={18} color="var(--palm-700)" /><span className="t-cap muted">{t.place.bestTime}</span><span className="t-label">{t.bestTime[place.bestTime]}</span></div>
        <div><Icon name="wallet" size={18} color="var(--palm-700)" /><span className="t-cap muted">{t.place.cost}</span><span className="t-label">{costText(place)}</span></div>
      </div>
      <p className="t-sm"><b style={{ fontWeight: 500 }}>{t.place.hours}:</b> <span className="muted">{place.openingHours ?? t.place.hoursUnknown}</span></p>
      {place.etiquette && <p className="t-sm"><b style={{ fontWeight: 500 }}>{t.place.etiquette}:</b> <span className="muted">{place.etiquette}</span></p>}
      <p className="t-cap muted" style={{ padding: '10px 14px', background: 'var(--ivory-50)', borderRadius: 10 }}>{t.place.reviewsSoon}</p>

      <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {visit ? (
          <div className="row" style={{ gap: 16 }}>
            <Stamp name={place.name} date={shortDate(visit.date)} press={justStamped} tilt={-6} />
            <div style={{ display: 'grid', gap: 4 }}>
              <p className="t-label">{t.place.alreadyVisited}</p>
              <p className="t-cap muted">{t.place.selfReported}</p>
              <button type="button" className="link" style={{ justifySelf: 'start', fontWeight: 400, fontSize: 13, color: 'var(--danger-700)' }} onClick={removeVisit} disabled={busy}>{t.place.removeVisit}</button>
            </div>
          </div>
        ) : (
          <>
            <h3 className="t-h3">{t.place.logTitle}</h3>
            <div className="stars" role="radiogroup" aria-label={t.place.rating}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} / 5`} onClick={() => setRating(n)}>
                  <Icon name="star" size={30} color={rating !== null && n <= rating ? 'var(--terracotta-600)' : 'var(--sand-300)'} />
                </button>
              ))}
            </div>
            <label className="t-cap muted" style={{ display: 'grid', gap: 4 }}>
              {t.place.note}
              <textarea className="rf-textarea" rows={2} placeholder={t.place.notePlaceholder} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <Button variant="primary" block loading={busy} onClick={logVisit}>{t.place.log}</Button>
          </>
        )}
        <button type="button" className="link" style={{ alignSelf: 'center', fontWeight: 400, fontSize: 13 }} onClick={report}>{t.place.report}</button>
      </div>
    </div>
  );
}
