import { ApiError, bestInsertion, CITIES, dayWindow, DAY_END, DAY_START, estimateBudget, explainUnscheduled, layoutDay, prayerTimes, suggestDay, tripDates, type Break, type DayProblem, type Place, type Trip } from '@riflo/core';
import { Button, EmptyState, ErrorState, Icon, IconButton, Leg, Sheet, Skeleton, StopCard, useAsync } from '@riflo/ui';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Screen, TopBar } from '../../app/AppShell';
import { useServices } from '../../app/services';
import { t } from '../../i18n';
import { clock, money, shortDate, todayIso } from '../../lib/format';
import { PlaceSheet } from '../places/PlaceSheet';
import { placeMeta } from '../places/placeText';
import { DayMap } from './DayMap';

export function TripPage() {
  const { id = '' } = useParams();
  const { api, draft } = useServices();
  const navigate = useNavigate();
  const { state, reload, refresh } = useAsync(async () => {
    const [trip, places, passport] = await Promise.all([id === 'draft' ? Promise.resolve(draft?.trip ?? null) : api.getTrip(id), api.listPlaces('madinah'), api.getPassport()]);
    return { trip, places, visited: new Set(passport.visits.map((v) => v.placeId)) };
  }, [id]);

  if (state.status === 'loading')
    return (
      <Screen>
        <div className="page"><Skeleton width="60%" height={24} /><Skeleton height={140} /><Skeleton height={84} /><Skeleton height={84} /></div>
      </Screen>
    );
  if (state.status === 'error') return <Screen><ErrorState title={t.common.loadError} body={t.common.loadErrorBody} retryLabel={t.common.retry} onRetry={reload} /></Screen>;
  if (!state.data.trip)
    return (
      <Screen nav>
        <EmptyState icon="route" title={t.trip.notFound} action={<Button variant="primary" onClick={() => navigate('/plan/new')}>{t.home.newTrip}</Button>} />
      </Screen>
    );
  return <TripView initial={state.data.trip} places={state.data.places} visited={state.data.visited} onVisited={refresh} />;
}

function TripView({ initial, places, visited, onVisited }: { initial: Trip; places: Place[]; visited: Set<string>; onVisited: () => void }) {
  const { api, draft, setDraft, notify, requireSignIn } = useServices();
  const navigate = useNavigate();
  const [trip, setTrip] = useState(initial);
  const [dayIdx, setDayIdx] = useState(0);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [openPlace, setOpenPlace] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** Why the last edit was refused, and another day where the place fits, if any. */
  const [refusal, setRefusal] = useState<{ text: string; suggestion?: { dayIndex: number; placeIds: string[] } } | null>(null);
  // Reset only when a different trip is shown, so reloading visit data doesn't discard edits.
  useEffect(() => setTrip(initial), [initial.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const byId = useMemo(() => new Map(places.map((p) => [p.id, p])), [places]);
  const budget = estimateBudget(trip, places);
  const day = trip.days[dayIdx];
  const p = trip.preferences;
  const usedIds = new Set(trip.days.flatMap((d) => d.stops.map((s) => s.placeId)));
  const dayWin = dayWindow(day.date, p);
  // A left-out place the traveller has since added to a day is no longer "could not fit".
  const unscheduled = (trip.unscheduled ?? []).filter((u) => !usedIds.has(u.placeId));

  const city = CITIES.find((c) => c.id === p.cityId) ?? CITIES[0];
  const prayersFor = (d: string) => prayerTimes(city.location, city.timezone, d);
  const dates = tripDates(p.startDate, p.endDate);
  /**
   * The trip's chosen places. Saved trips: the server's selection (`trip.selected`), the source of truth.
   * Unsaved plans: what the plan scheduled or left out. Scheduling a place adds it; only "remove from trip" takes it out.
   */
  const selected = trip.selected ?? [...new Set([...trip.days.flatMap((d) => d.stops.map((s) => s.placeId)), ...(trip.unscheduled ?? []).map((u) => u.placeId)])];
  /** Rebuild the left-out list from a selection and days, the same way the server does. */
  const leftOut = (sel: string[], ids: string[][]) => {
    const pending = sel.filter((id) => !ids.flat().includes(id));
    const explained = new Map(explainUnscheduled(pending.filter((id) => byId.has(id)).map((id) => byId.get(id)!), ids, dates, byId, p, prayersFor).map((u) => [u.placeId, u]));
    return pending.map((id) => explained.get(id) ?? { placeId: id, reason: 'unavailable' as const });
  };

  /** Remove a place from the trip (explicit choice). Saved trips: on the server at once; plans: when first saved. */
  async function removeFromTrip(placeId: string) {
    const ids = trip.days.map((d) => d.stops.map((s) => s.placeId));
    if (!trip.saved) {
      const sel = selected.filter((id) => id !== placeId);
      setTrip({ ...trip, selected: undefined, excluded: [...new Set([...(trip.excluded ?? []), placeId])], unscheduled: leftOut(sel, ids).filter((u) => u.placeId !== placeId) });
      setDirty(true);
      return;
    }
    try {
      const res = await api.removeFromTrip(trip.id, placeId);
      setTrip({ ...trip, selected: res.selected, unscheduled: leftOut(res.selected ?? [], ids) });
      notify(t.trip.removedFromTrip);
    } catch (e) {
      notify(e instanceof ApiError && e.message === 'place_scheduled' ? t.trip.saveFirst : t.common.loadError);
    }
  }

  const problemText = (pr: DayProblem) => {
    const name = pr.placeId ? byId.get(pr.placeId)?.name ?? '' : '';
    if (pr.problem === 'past_day_end') {
      const end = dayWindow(pr.date, p).end;
      return t.trip.problems.past_day_end(clock(end).time + ' ' + clock(end).period);
    }
    return t.trip.problems[pr.problem](name);
  };

  /**
   * Apply an edit to one day only if the whole day still fits (opening hours, closed days, prayers, day end).
   * Otherwise refuse with the reason and, when adding a place, offer another day where it fits.
   * Every accepted edit rebuilds the "could not fit" list.
   */
  function changeDayAt(index: number, placeIds: string[], added?: string): boolean {
    const layout = layoutDay(dates[index], placeIds, byId, p, prayersFor(dates[index]));
    if (!layout.fits) {
      const place = added ? byId.get(added) : undefined;
      const others = trip.days.map((d) => d.stops.map((s) => s.placeId));
      const suggestion = place ? suggestDay(place, others, dates, byId, p, prayersFor, undefined, index) ?? undefined : undefined;
      setRefusal({ text: problemText(layout.problems[0]), suggestion });
      return false;
    }
    const days = trip.days.map((d, i) => (i === index ? layout.day : d));
    const ids = days.map((d) => d.stops.map((s) => s.placeId));
    // Scheduling a place chooses it; taking it out of a day keeps it chosen (it shows as left out).
    const sel = [...new Set([...selected, ...ids.flat()])];
    setTrip({ ...trip, days, ...(trip.saved ? { selected: sel } : {}), unscheduled: leftOut(sel, ids) });
    setRefusal(null);
    setDirty(true);
    return true;
  }
  const changeDay = (placeIds: string[], added?: string) => changeDayAt(dayIdx, placeIds, added);
  /** Add a left-out place to the day it fits on, in the best position. */
  function addToDay(placeId: string, index: number) {
    const pl = byId.get(placeId);
    const fit = pl && bestInsertion(pl, trip.days[index].stops.map((s) => s.placeId), dates[index], byId, p, prayersFor(dates[index]));
    if (fit && changeDayAt(index, fit.placeIds)) setDayIdx(index);
  }
  const ids = day.stops.map((s) => s.placeId);
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[i], next[j]] = [next[j], next[i]];
    changeDay(next);
  };

  async function save() {
    if (!(await requireSignIn())) return;
    setSaving(true);
    try {
      const saved = await api.saveTrip(trip, draft?.trip.id === trip.id ? draft.reusedFrom : undefined);
      setDraft(null);
      setDirty(false);
      setEditing(false);
      notify(t.trip.saved);
      navigate(`/trips/${saved.id}`, { replace: true });
    } catch (e) {
      // The server checks every day again; a day it cannot accept is reported, never saved.
      notify(e instanceof ApiError && e.message === 'day_not_executable' ? t.trip.notExecutable : t.common.loadError);
    } finally {
      setSaving(false);
    }
  }

  async function share() {
    const text = `${trip.title}\n` + trip.days.map((d, i) => `${t.trip.day(i + 1)}: ` + d.stops.map((s) => byId.get(s.placeId)?.name).join('، ')).join('\n');
    try {
      await navigator.share({ title: trip.title, text });
    } catch {
      // No Web Share (desktop, embedded preview) or cancelled: fall back to copying.
      try {
        await navigator.clipboard.writeText(text);
        notify(t.trip.shared);
      } catch {
        /* clipboard blocked too: nothing else to do */
      }
    }
  }

  const needsSave = !trip.saved || dirty;
  const footer = needsSave ? (
    <Button variant="primary" block icon="bookmark" loading={saving} onClick={save}>{trip.saved ? t.trip.saveChanges : t.trip.save}</Button>
  ) : undefined;

  return (
    <Screen footer={footer}>
      <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--line)' }}>
        <TopBar title={trip.title} subtitle={`${shortDate(p.startDate)} – ${shortDate(p.endDate)} · ${p.travellers} مسافرين · ${t.tripTypes[p.tripType]}`} onBack={() => navigate('/')}>
          <IconButton icon="share" label={t.trip.share} bare onClick={share} />
          <Button small variant={editing ? 'solid' : 'secondary'} icon={editing ? 'check' : 'edit'} onClick={() => setEditing(!editing)}>{editing ? t.trip.done : t.trip.edit}</Button>
        </TopBar>
        <div style={{ padding: '4px 16px 0' }}>
          <div className="between t-cap">
            <span>{t.trip.budget}</span>
            <span><b className="t-label" style={{ fontSize: 13 }}>{money(budget.estimate)}</b> <span className="muted">{t.trip.of} {money(p.budgetTotal)} {t.common.sar}</span></span>
          </div>
          <div style={{ height: 6, borderRadius: 99, background: 'var(--closed-100)', marginTop: 6, overflow: 'hidden' }} role="progressbar" aria-valuemin={0} aria-valuemax={p.budgetTotal} aria-valuenow={budget.estimate} aria-label={t.trip.budget}>
            <div style={{ width: `${Math.min(100, (budget.estimate / Math.max(1, p.budgetTotal)) * 100)}%`, height: '100%', background: budget.estimate > p.budgetTotal ? 'var(--danger-700)' : 'var(--palm-700)' }} />
          </div>
          <p className="t-cap muted" style={{ marginTop: 4 }}>{t.trip.budgetBreakdown(money(budget.entry), money(budget.transport))}{budget.unknownCosts > 0 && ` · ${t.trip.unknownCosts(budget.unknownCosts)}`}</p>
        </div>
        <div className="tabs" role="tablist" style={{ borderBottom: 0, marginTop: 4 }}>
          {trip.days.map((d, i) => (
            <button key={d.date} role="tab" aria-selected={i === dayIdx} onClick={() => setDayIdx(i)}>
              <span>{t.trip.day(i + 1)}</span>
              <span className="t-cap">{shortDate(d.date)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="page" style={{ gap: 0 }}>
        {day.stops.length > 0 && <DayMap stops={day.stops.map((s) => byId.get(s.placeId)?.location).filter((x): x is NonNullable<typeof x> => !!x)} label={t.trip.map} />}
        <div style={{ height: 16 }} />
        {refusal && (
          <div role="alert" className="list-row" style={{ display: 'grid', gap: 8, borderColor: 'var(--danger-700)', marginBottom: 12 }}>
            <span className="t-label">{t.trip.refused}</span>
            <span className="t-cap">{refusal.text}</span>
            {refusal.suggestion && (
              <Button small variant="secondary" onClick={() => { const s = refusal.suggestion!; if (changeDayAt(s.dayIndex, s.placeIds)) setDayIdx(s.dayIndex); }}>
                {t.trip.addToDay(refusal.suggestion.dayIndex + 1)}
              </Button>
            )}
          </div>
        )}
        {dayWin.start > DAY_START && <p className="t-cap muted" style={{ marginBottom: 8 }}>{t.trip.dayStarts(clock(dayWin.start).time + ' ' + clock(dayWin.start).period)}</p>}
        {day.stops.length === 0 && <EmptyState icon="pin" title={t.trip.emptyDay} />}
        {day.stops.map((s, i) => {
          const place = byId.get(s.placeId);
          if (!place) return null;
          const c = clock(s.start);
          // Shown in time order: prayers before the drive, the drive, prayers while waiting for opening, the visit, prayers during it.
          // Trips saved before break phases existed: a non-mosque break before a stop is shown before the drive.
          const before = day.breaks.filter((b) => b.afterStop === i - 1 && (b.phase ? b.phase === 'before_travel' : !b.atPlace));
          const waiting = day.breaks.filter((b) => b.afterStop === i - 1 && b.phase === 'waiting');
          const during = day.breaks.filter((b) => b.afterStop === i && (b.phase ? b.phase === 'in_visit' : b.atPlace));
          return (
            <Fragment key={s.id}>
              {before.map((b) => <PrayerLeg key={b.prayer} b={b} />)}
              {i > 0 && s.travelFromPrevious !== null && <Leg>{t.trip.drive(s.travelFromPrevious, s.distanceFromPreviousKm ?? 0)}</Leg>}
              {waiting.map((b) => <PrayerLeg key={b.prayer} b={b} />)}
              <StopCard
                time={c.time}
                period={c.period}
                name={place.name}
                status={s.warning === 'outside_hours' ? { tone: 'danger', label: t.trip.outsideHours } : s.warning === 'closed_that_day' ? { tone: 'danger', label: t.trip.closedThatDay } : visited.has(place.id) ? { tone: 'visited', label: t.trip.visited } : { tone: 'closed', label: t.categories[place.category] }}
                description={`${place.summary} · ${t.trip.visitLen(place.visitMinutes)}`}
                meta={s.warning === 'hours_unknown' ? [...placeMeta(place), { icon: 'clock', text: t.trip.hoursUnknown }] : placeMeta(place)}
                onOpen={() => setOpenPlace(place.id)}
                actions={
                  editing ? (
                    <div className="edit-actions">
                      <button type="button" aria-label={t.trip.moveUp} onClick={() => move(i, -1)} disabled={i === 0}><Icon name="up" size={16} /></button>
                      <button type="button" aria-label={t.trip.remove} onClick={() => changeDay(ids.filter((_, k) => k !== i))}><Icon name="trash" size={16} color="var(--danger-700)" /></button>
                      <button type="button" aria-label={t.trip.moveDown} onClick={() => move(i, 1)} disabled={i === ids.length - 1}><Icon name="down" size={16} /></button>
                    </div>
                  ) : undefined
                }
              />
              {during.map((b) => <PrayerLeg key={b.prayer} b={b} />)}
            </Fragment>
          );
        })}
        {day.breaks.filter((b) => b.phase === 'end_of_day').map((b) => <PrayerLeg key={b.prayer} b={b} />)}
        {unscheduled.length > 0 && (
          <section aria-labelledby="unscheduled-title" style={{ marginTop: 24, display: 'grid', gap: 8 }}>
            <h2 id="unscheduled-title" className="t-label">{t.trip.unscheduledTitle(unscheduled.length)}</h2>
            <p className="t-cap muted">{t.trip.unscheduledHint}</p>
            {unscheduled.map((u) => {
              const pl = byId.get(u.placeId);
              return (
                <div key={u.placeId} className="list-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <button type="button" style={{ all: 'unset', cursor: pl ? 'pointer' : 'default', flex: 1, display: 'flex', gap: 8 }} onClick={() => pl && setOpenPlace(pl.id)}>
                    <Icon name="pin" color="var(--ink-500)" />
                    <span style={{ flex: 1 }}>
                      <span className="t-label" style={{ display: 'block' }}>{pl?.name ?? t.trip.unavailablePlace}</span>
                      <span className="t-cap muted">{u.reason === 'not_added' && u.canFitOn ? t.trip.canFitOn(dates.indexOf(u.canFitOn) + 1) : t.trip.reasons[u.reason]}</span>
                    </span>
                  </button>
                  {u.reason === 'not_added' && u.canFitOn && (
                    <Button small variant="secondary" onClick={() => addToDay(u.placeId, dates.indexOf(u.canFitOn!))}>{t.trip.addToDay(dates.indexOf(u.canFitOn) + 1)}</Button>
                  )}
                  <Button small variant="ghost" onClick={() => removeFromTrip(u.placeId)}>{t.trip.removeFromTrip}</Button>
                </div>
              );
            })}
          </section>
        )}
        {dayWin.end < DAY_END && <p className="t-cap muted" style={{ marginTop: 8 }}>{t.trip.dayEnds(clock(dayWin.end).time + ' ' + clock(dayWin.end).period)}</p>}
        {editing && (
          <Button variant="secondary" icon="plus" onClick={() => setAdding(true)} style={{ marginTop: 16 }}>{t.trip.addPlace}</Button>
        )}
      </div>

      {/* A visit is linked to the trip only while the trip is happening (the server enforces the same rule). */}
      <PlaceSheet placeId={openPlace} tripId={trip.saved && p.startDate <= todayIso() && todayIso() <= p.endDate ? trip.id : null} onClose={() => setOpenPlace(null)} onChanged={onVisited} />
      <Sheet open={adding} onClose={() => setAdding(false)} label={t.trip.addTitle}>
        <h2 className="t-h3" style={{ marginBottom: 12 }}>{t.trip.addTitle}</h2>
        <div style={{ display: 'grid', gap: 8 }}>
          {places.filter((pl) => !usedIds.has(pl.id)).map((pl) => (
            <button key={pl.id} type="button" className="list-row" style={{ cursor: 'pointer', textAlign: 'start' }} onClick={() => { const fit = bestInsertion(pl, ids, day.date, byId, p, prayersFor(day.date)); changeDay(fit ? fit.placeIds : [...ids, pl.id], pl.id); setAdding(false); }}>
              <Icon name="plus" color="var(--palm-700)" />
              <span style={{ flex: 1 }}>
                <span className="t-label" style={{ display: 'block' }}>{pl.name}</span>
                <span className="t-cap muted">{t.categories[pl.category]} · {pl.visitMinutes} د</span>
              </span>
            </button>
          ))}
        </div>
      </Sheet>
    </Screen>
  );
}

function PrayerLeg({ b }: { b: Break }) {
  const note = b.phase === 'in_visit' || (!b.phase && b.atPlace) ? (b.atPlace ? t.trip.prayerAtPlace : t.trip.prayerPause) : '';
  return <Leg icon="moon">{t.prayers[b.prayer]} · {clock(b.at).time} {t.trip.prayerSource} {note}</Leg>;
}
