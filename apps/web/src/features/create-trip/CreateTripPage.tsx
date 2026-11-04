import { CITIES, tripDates, type BudgetLevel, type CategoryId, type TripPreferences, type TripType } from '@riflo/core';
import { Button, ErrorState, Icon, Skeleton, Stepper, Switch, useAsync } from '@riflo/ui';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Screen, TopBar } from '../../app/AppShell';
import { useServices } from '../../app/services';
import { t } from '../../i18n';
import { addDays, money, shortDate, todayIso } from '../../lib/format';

/** "HH:MM" from an <input type="time"> ↔ minutes from midnight; empty means "not set". */
const toHhmm = (m: number | null | undefined) => (m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
const fromHhmm = (v: string) => (/^\d{2}:\d{2}$/.test(v) ? Number(v.slice(0, 2)) * 60 + Number(v.slice(3)) : null);

const PER_PERSON_DAY: Record<BudgetLevel, number> = { economy: 150, standard: 250, comfort: 450 };
const TRIP_TYPES: TripType[] = ['family', 'friends', 'solo', 'couple'];

function defaults(): TripPreferences {
  const start = addDays(todayIso(), 7);
  return { cityId: 'madinah', startDate: start, endDate: addDays(start, 2), travellers: 2, tripType: 'family', budgetTotal: 1500, interests: ['religious', 'history'], aroundPrayerTimes: true, relaxedPace: false };
}

export function CreateTripPage() {
  const { api, setDraft } = useServices();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const fromTrip = params.get('from');

  const { state, reload } = useAsync(async () => {
    const [passport, places, source] = await Promise.all([api.getPassport(), api.listPlaces('madinah'), fromTrip ? api.getTrip(fromTrip) : Promise.resolve(null)]);
    const remembered = source?.preferences ?? passport.lastPreferences;
    const categories = [...new Set(places.map((p) => p.category))];
    return { remembered, categories };
  }, [fromTrip]);

  const [step, setStep] = useState(1);
  const [prefs, setPrefs] = useState<TripPreferences>(defaults);
  const [prefilled, setPrefilled] = useState(false);
  const [phase, setPhase] = useState<'form' | 'building' | 'error'>('form');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state.status === 'ready' && state.data.remembered && !prefilled) {
      const { startDate: _s, endDate: _e, firstDayStart: _f, lastDayEnd: _l, ...rest } = state.data.remembered as TripPreferences;
      setPrefs((p) => ({ ...p, ...rest }));
      setPrefilled(true);
    }
  }, [state, prefilled]);

  // One planning session per attempt: funnel events, the plan and the saved trip share its id (audit 5.7).
  useEffect(() => {
    api.startPlanSession();
    api.track('plan_started', { cityId: 'madinah' });
  }, [api, fromTrip]);

  const days = tripDates(prefs.startDate, prefs.endDate).length;
  const update = (patch: Partial<TripPreferences>) => {
    setError(null);
    setPrefs((p) => ({ ...p, ...patch }));
  };

  function validateDates() {
    if (prefs.endDate < prefs.startDate) return t.create.errors.dates;
    const span = (new Date(prefs.endDate).getTime() - new Date(prefs.startDate).getTime()) / 864e5 + 1;
    if (span > 7) return t.create.errors.maxDays;
    if (prefs.startDate === prefs.endDate && prefs.firstDayStart != null && prefs.lastDayEnd != null && prefs.firstDayStart >= prefs.lastDayEnd) return t.create.errors.times;
    return null;
  }

  async function build() {
    if (!(prefs.budgetTotal > 0)) return setError(t.create.errors.budget);
    setPhase('building');
    try {
      const trip = await api.createPlan(prefs, t.create.tripTitle(t.tripTypes[prefs.tripType]));
      setDraft({ trip, reusedFrom: fromTrip ?? undefined });
      api.track('plan_step_completed', { step: 3 });
      navigate('/trips/draft', { replace: true });
    } catch {
      setPhase('error');
    }
  }

  const back = () => (phase !== 'form' ? setPhase('form') : step > 0 ? setStep(step - 1) : navigate(-1));
  const subtitle = `${CITIES[0].name} · ${shortDate(prefs.startDate)} – ${shortDate(prefs.endDate)}`;

  if (phase === 'building') return <Building subtitle={subtitle} onBack={back} />;
  if (phase === 'error')
    return (
      <Screen>
        <TopBar title={t.create.title} subtitle={subtitle} onBack={back} />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
          <ErrorState title={t.create.failTitle} body={t.create.failBody} retryLabel={t.common.retry} onRetry={build} extra={<button type="button" className="link" onClick={() => setPhase('form')}>{t.create.editChoices}</button>} />
        </div>
      </Screen>
    );

  const footer =
    step < 2 ? (
      <Button variant="primary" block onClick={() => { const e = step === 1 ? validateDates() : null; if (e) return setError(e); api.track('plan_step_completed', { step: step + 1 }); setStep(step + 1); }}>{t.common.next}</Button>
    ) : (
      <Button variant="primary" block onClick={build}>{t.create.build}</Button>
    );

  return (
    <Screen footer={footer}>
      <TopBar title={t.create.title} subtitle={step > 0 ? subtitle : undefined} onBack={back} />
      <div style={{ padding: '0 16px 12px', background: 'var(--surface)' }}>
        <Stepper steps={t.create.steps.map((label) => ({ label }))} current={step} label={t.create.stepsLabel} />
      </div>
      {state.status === 'loading' && <div className="page"><Skeleton height={48} /><Skeleton height={120} /></div>}
      {state.status === 'error' && <ErrorState title={t.common.loadError} body={t.common.loadErrorBody} retryLabel={t.common.retry} onRetry={reload} />}
      {state.status === 'ready' && (
        <div className="page" style={{ gap: 24 }}>
          {prefilled && step === 2 && (
            <div className="between" style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--palm-100)', color: 'var(--palm-700)' }}>
              <span className="row t-sm"><Icon name="passport" size={18} />{t.create.fromPassport}</span>
            </div>
          )}
          {step === 0 && <Destination />}
          {step === 1 && <When prefs={prefs} days={days} update={update} />}
          {step === 2 && <BudgetAndInterests prefs={prefs} days={days} categories={state.data.categories} update={update} />}
          {error && <p className="field-error" role="alert">{error}</p>}
        </div>
      )}
    </Screen>
  );
}

function Destination() {
  return (
    <section className="section">
      <h2 className="t-display">{t.create.destTitle}</h2>
      <button type="button" className="choice" aria-pressed="true" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px' }}>
        <Icon name="pin" />
        {CITIES[0].name}
      </button>
      <p className="t-cap muted">{t.create.moreCities}</p>
    </section>
  );
}

function When({ prefs, days, update }: { prefs: TripPreferences; days: number; update: (p: Partial<TripPreferences>) => void }) {
  return (
    <>
      <h2 className="t-display">{t.create.whenTitle}</h2>
      <div>
        <div style={{ display: 'flex', gap: 8 }}>
          <label style={{ flex: 1 }}>
            <span className="t-cap muted">{t.create.from}</span>
            <input className="rf-field" type="date" value={prefs.startDate} min={todayIso()} onChange={(e) => e.target.value && update({ startDate: e.target.value, endDate: prefs.endDate < e.target.value ? e.target.value : prefs.endDate })} style={{ width: '100%', color: 'var(--ink)' }} />
          </label>
          <label style={{ flex: 1 }}>
            <span className="t-cap muted">{t.create.to}</span>
            <input className="rf-field" type="date" value={prefs.endDate} min={prefs.startDate} onChange={(e) => e.target.value && update({ endDate: e.target.value })} style={{ width: '100%', color: 'var(--ink)' }} />
          </label>
        </div>
        <p className="t-cap muted" style={{ marginTop: 6 }}>{t.create.daysDerived(days)}</p>
      </div>
      <div>
        <div style={{ display: 'flex', gap: 8 }}>
          <label style={{ flex: 1 }}>
            <span className="t-cap muted">{t.create.arrival}</span>
            <input className="rf-field" type="time" value={toHhmm(prefs.firstDayStart)} onChange={(e) => update({ firstDayStart: fromHhmm(e.target.value) })} style={{ width: '100%', color: 'var(--ink)' }} />
          </label>
          <label style={{ flex: 1 }}>
            <span className="t-cap muted">{t.create.departure}</span>
            <input className="rf-field" type="time" value={toHhmm(prefs.lastDayEnd)} onChange={(e) => update({ lastDayEnd: fromHhmm(e.target.value) })} style={{ width: '100%', color: 'var(--ink)' }} />
          </label>
        </div>
        <p className="t-cap muted" style={{ marginTop: 6 }}>{t.create.timesHint}</p>
      </div>
      <div className="between">
        <div>
          <p className="t-label">{t.create.travellers}</p>
          <p className="t-cap muted">{t.create.travellersHint}</p>
        </div>
        <div className="counter">
          <button type="button" className="rf-icon-btn" aria-label={t.create.decrease} onClick={() => update({ travellers: Math.max(1, prefs.travellers - 1) })}>−</button>
          <span className="t-num" aria-live="polite" style={{ minWidth: 20, textAlign: 'center' }}>{prefs.travellers}</span>
          <button type="button" className="rf-icon-btn" aria-label={t.create.increase} onClick={() => update({ travellers: Math.min(20, prefs.travellers + 1) })}>+</button>
        </div>
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="rf-label">{t.create.tripType}</legend>
        <div className="choice-grid">
          {TRIP_TYPES.map((tt) => (
            <button key={tt} type="button" className="choice" aria-pressed={prefs.tripType === tt} onClick={() => update({ tripType: tt })}>{t.tripTypes[tt]}</button>
          ))}
        </div>
      </fieldset>
    </>
  );
}

function BudgetAndInterests({ prefs, days, categories, update }: { prefs: TripPreferences; days: number; categories: CategoryId[]; update: (p: Partial<TripPreferences>) => void }) {
  const perPersonDay = Math.round(prefs.budgetTotal / Math.max(1, prefs.travellers * days));
  const toggle = (c: CategoryId) => update({ interests: prefs.interests.includes(c) ? prefs.interests.filter((x) => x !== c) : [...prefs.interests, c] });
  return (
    <>
      <div>
        <label className="rf-label" htmlFor="budget">{t.create.budget}</label>
        <div className="rf-field" style={{ height: 56 }}>
          <input id="budget" inputMode="numeric" value={prefs.budgetTotal ? money(prefs.budgetTotal) : ''} onChange={(e) => update({ budgetTotal: Number(e.target.value.replace(/[^\d]/g, '')) || 0 })} style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 500 }} />
          <span className="t-sm">{t.common.sar}</span>
        </div>
        <div className="wrap" style={{ marginTop: 8 }}>
          {(Object.keys(PER_PERSON_DAY) as BudgetLevel[]).map((lvl) => {
            const total = PER_PERSON_DAY[lvl] * prefs.travellers * days;
            return (
              <button key={lvl} type="button" className="rf-pill rf-pill--filter" style={{ height: 36, fontSize: 13 }} aria-pressed={prefs.budgetTotal === total} onClick={() => update({ budgetTotal: total })}>
                {t.budgetLevels[lvl]}
              </button>
            );
          })}
        </div>
        <p className="t-cap muted" style={{ marginTop: 6 }}>{t.create.perPersonDay(perPersonDay)}</p>
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="rf-label">{t.create.interests}</legend>
        <div className="wrap">
          {categories.map((c) => (
            <button key={c} type="button" className="rf-pill" aria-pressed={prefs.interests.includes(c)} onClick={() => toggle(c)}>
              {prefs.interests.includes(c) && <Icon name="check" size={14} />}
              {t.categories[c]}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="card" style={{ padding: '4px 16px' }}>
        <h3 className="sr-only">{t.create.prefs}</h3>
        <div style={{ borderBottom: '1px solid var(--line)' }}>
          <Switch label={t.create.prayer} icon="moon" checked={prefs.aroundPrayerTimes} onChange={(v) => update({ aroundPrayerTimes: v })} />
        </div>
        <Switch label={t.create.relaxed} icon="clock" checked={prefs.relaxedPace} onChange={(v) => update({ relaxedPace: v })} />
      </div>
    </>
  );
}

function Building({ subtitle, onBack }: { subtitle: string; onBack: () => void }) {
  const [done, setDone] = useState(0);
  useEffect(() => {
    const timers = [500, 1000].map((ms, i) => setTimeout(() => setDone(i + 1), ms));
    return () => timers.forEach(clearTimeout);
  }, []);
  return (
    <Screen>
      <TopBar title={t.create.title} subtitle={subtitle} onBack={onBack} />
      <div className="page" style={{ paddingTop: 32 }} aria-busy="true" aria-live="polite">
        <div style={{ display: 'grid', gap: 6 }}>
          <h2 className="t-display">{t.create.building}</h2>
          <p className="t-body muted">{t.create.buildingBody}</p>
        </div>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 14 }}>
          {t.create.buildSteps.map((s, i) => (
            <li key={s} className="row t-sm" style={{ gap: 12, color: i > done ? 'var(--ink-muted)' : 'var(--ink)' }}>
              {i < done ? <Icon name="check" size={16} color="var(--palm-700)" strokeWidth={2} /> : <span style={{ width: 16, height: 16, borderRadius: '50%', border: i === done ? '2px solid var(--terracotta-600)' : '1.5px solid var(--sand-300)' }} />}
              {s}
            </li>
          ))}
        </ol>
        <div style={{ display: 'grid', gap: 12 }}>
          {[0, 1, 2].map((i) => <Skeleton key={i} height={84} />)}
        </div>
      </div>
    </Screen>
  );
}
