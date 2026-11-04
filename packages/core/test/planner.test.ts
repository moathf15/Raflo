/**
 * Planner tests for the review of 4 Nov 2026 (sections 3, 5 and 7).
 * Synthetic places in Madinah so each scenario controls durations, hours, closing days and distances.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bestInsertion,
  DAY_END,
  DAY_START,
  MAX_DAYS,
  dayWindow,
  generatePlan,
  layoutDay,
  rescheduleDay,
  tripDates,
  weekdayOf,
  type DayLayout,
  type Place,
  type PrayerTime,
  type Trip,
  type TripPreferences
} from '../src';

const BREAK = 20;
const PRAYERS: PrayerTime[] = [
  { prayer: 'dhuhr', at: 12 * 60 + 5 },
  { prayer: 'asr', at: 15 * 60 + 20 },
  { prayer: 'maghrib', at: 17 * 60 + 40 },
  { prayer: 'isha', at: 19 * 60 + 10 }
];
const CENTER = { lat: 24.4672, lng: 39.6112 };

let n = 0;
function place(over: Partial<Place> = {}): Place {
  n++;
  return {
    id: over.id ?? `p${n}`,
    cityId: 'madinah',
    name: `مكان ${n}`,
    summary: 's',
    category: 'history',
    location: { lat: CENTER.lat + ((n * 37) % 11) * 0.004, lng: CENTER.lng + ((n * 53) % 13) * 0.004 },
    visitMinutes: 60,
    costPerPerson: 0,
    openingHours: 'x',
    hours: { open: 0, close: 1440 },
    source: null,
    verifiedAt: null,
    bestTime: 'any',
    etiquette: null,
    status: 'published',
    updatedAt: '2026-10-01',
    openReports: 0,
    ...over
  };
}
function prefs(days: number, over: Partial<TripPreferences> = {}): TripPreferences {
  const start = '2026-12-06'; // a Sunday
  const end = new Date(Date.UTC(2026, 11, 6 + days - 1)).toISOString().slice(0, 10);
  return { cityId: 'madinah', startDate: start, endDate: end, travellers: 2, tripType: 'family', budgetTotal: 2000, interests: ['history', 'religious'], aroundPrayerTimes: true, relaxedPace: false, ...over };
}
const plan = (p: TripPreferences, places: Place[], wishList: string[] = []) => generatePlan({ preferences: p, places, wishList, prayerTimes: PRAYERS, breakMinutes: BREAK, title: 't' });
const counts = (t: Trip) => t.days.map((d) => d.stops.length);

/** Every rule from section 5 that can be checked on one laid-out day. */
function assertDayIsExecutable(L: DayLayout, byId: Map<string, Place>, label: string) {
  const seq = L.timeline.filter((s) => !s.inVisit);
  for (const [i, s] of seq.entries()) {
    assert.ok(s.to >= s.from, `${label}: block ends before it starts`);
    assert.ok(s.from >= L.window.start, `${label}: ${s.kind} at ${s.from} starts before the day (${L.window.start})`);
    assert.ok(s.to <= L.window.end, `${label}: ${s.kind} ends at ${s.to}, after the day end ${L.window.end}`);
    if (i) assert.ok(s.from >= seq[i - 1].to, `${label}: ${s.kind}@${s.from} overlaps ${seq[i - 1].kind} ending ${seq[i - 1].to}`);
  }
  const visits = L.timeline.filter((s) => s.kind === 'visit');
  assert.equal(visits.length, L.day.stops.length, `${label}: one visit per stop`);
  for (const [i, stop] of L.day.stops.entries()) {
    const v = visits.find((s) => s.stop === i)!;
    const p = byId.get(stop.placeId)!;
    assert.equal(v.from, stop.start, `${label}: stop start matches its visit`);
    assert.ok(v.to - v.from >= p.visitMinutes, `${label}: visit shorter than its duration`);
    if (p.hours) {
      assert.ok(!p.hours.closedOn?.includes(weekdayOf(L.day.date)), `${label}: ${p.id} scheduled on a closed weekday`);
      assert.ok(v.from >= p.hours.open && v.to <= p.hours.close, `${label}: ${p.id} visited ${v.from}–${v.to} outside ${p.hours.open}–${p.hours.close}`);
    }
    const travel = L.timeline.find((s) => s.kind === 'travel' && s.stop === i);
    if (i === 0) assert.equal(travel, undefined);
    else {
      assert.ok(travel, `${label}: travel to stop ${i} is missing`);
      assert.equal(travel!.to - travel!.from, stop.travelFromPrevious, `${label}: travel block = travel time`);
      assert.ok(travel!.to <= v.from, `${label}: arrives after the visit starts`);
    }
  }
  for (const s of L.timeline.filter((x) => x.inVisit)) {
    const host = visits.find((v) => s.from >= v.from && s.to <= v.to);
    assert.ok(host, `${label}: a prayer that pauses a visit must be inside that visit`);
  }
  for (const b of L.day.breaks) assert.equal(b.atPlace, b.phase === 'in_visit' && byId.get(L.day.stops[b.afterStop].placeId)!.category === 'religious', `${label}: atPlace only inside a mosque`);
  assert.equal(L.day.breaks.length, L.timeline.filter((s) => s.kind === 'prayer').length, `${label}: every break is on the timeline`);
}

/** Re-lay out each day of a plan and check it, plus whole-trip rules. */
function assertPlanIsExecutable(t: Trip, places: Place[], p: TripPreferences, label = 'plan') {
  const byId = new Map(places.map((x) => [x.id, x]));
  assert.deepEqual(t.days.map((d) => d.date), tripDates(p.startDate, p.endDate), `${label}: one day per date, none dropped`);
  for (const d of t.days) {
    const ids = d.stops.map((s) => s.placeId);
    assert.equal(new Set(ids).size, ids.length, `${label}: same place twice in a day`);
    assert.ok(ids.length <= (p.relaxedPace ? 3 : 4), `${label}: more stops than the daily maximum`);
    const L = layoutDay(d.date, ids, byId, p, PRAYERS, BREAK);
    assert.deepEqual(L.day.stops.map((s) => s.start), d.stops.map((s) => s.start), `${label}: plan matches its layout`);
    assert.ok(L.fits, `${label}: day ${d.date} does not fit its hours or window`);
    assertDayIsExecutable(L, byId, `${label} ${d.date}`);
  }
  const scheduled = t.days.flatMap((d) => d.stops.map((s) => s.placeId));
  for (const u of t.unscheduled ?? []) assert.ok(!scheduled.includes(u.placeId), `${label}: ${u.placeId} is both scheduled and unscheduled`);
}

describe('review §7 acceptance: spreading places over the whole trip', () => {
  it('5 days and 5 suitable places: one place per day, not crammed into the first two', () => {
    const places = Array.from({ length: 5 }, () => place());
    const p = prefs(5);
    const t = plan(p, places);
    assert.deepEqual(counts(t), [1, 1, 1, 1, 1]);
    assert.deepEqual(t.unscheduled, []);
    assertPlanIsExecutable(t, places, p);
  });

  it('4 days and 10 places: balanced by real time, not by blind division', () => {
    // Two long visits (4 h) and eight short ones (45 min).
    const long = [place({ visitMinutes: 240 }), place({ visitMinutes: 240 })];
    const short = Array.from({ length: 8 }, () => place({ visitMinutes: 45 }));
    const places = [...long, ...short];
    const p = prefs(4);
    const t = plan(p, places);
    assertPlanIsExecutable(t, places, p);
    assert.deepEqual(t.unscheduled, []);
    assert.equal(counts(t).reduce((a, b) => a + b), 10);
    assert.ok(counts(t).every((c) => c >= 2), `every day is used: ${counts(t)}`);
    const longIds = new Set(long.map((x) => x.id));
    const withLong = t.days.filter((d) => d.stops.some((s) => longIds.has(s.placeId)));
    const withoutLong = t.days.filter((d) => !d.stops.some((s) => longIds.has(s.placeId)));
    assert.equal(withLong.length, 2, 'the two long visits are on different days');
    assert.ok(Math.max(...withLong.map((d) => d.stops.length)) < Math.min(...withoutLong.map((d) => d.stops.length)), `days with a 4-hour visit take fewer stops: ${counts(t)}`);
  });

  it('3 days with a late arrival: the short first day takes fewer stops and the rest is rebalanced', () => {
    const places = Array.from({ length: 9 }, () => place({ visitMinutes: 60 }));
    const p = prefs(3, { firstDayStart: 17 * 60 });
    const t = plan(p, places);
    assertPlanIsExecutable(t, places, p);
    const [first, ...rest] = counts(t);
    assert.ok(first >= 1 && rest.every((c) => c > first), `first day shorter: ${counts(t)}`);
    assert.ok(t.days[0].stops[0].start >= 17 * 60, 'nothing before arrival');
    assert.deepEqual(t.unscheduled, []);
  });

  it('an early departure shortens the last day the same way', () => {
    const places = Array.from({ length: 9 }, () => place({ visitMinutes: 60 }));
    const p = prefs(3, { lastDayEnd: 12 * 60 });
    const t = plan(p, places);
    assertPlanIsExecutable(t, places, p);
    const last = t.days.at(-1)!;
    assert.ok(last.stops.length < t.days[0].stops.length, `${counts(t)}`);
    assert.ok(last.stops.every((s) => s.start + 60 <= 12 * 60));
  });

  it('a place closed on day 1 and open on day 2 is scheduled on day 2, not dropped', () => {
    const p = prefs(2);
    const closedDay1 = place({ id: 'closed-sunday', hours: { open: 8 * 60, close: 22 * 60, closedOn: [weekdayOf(p.startDate)] } });
    const others = [place(), place()];
    const t = plan(p, [closedDay1, ...others]);
    assertPlanIsExecutable(t, [closedDay1, ...others], p);
    assert.ok(t.days[1].stops.some((s) => s.placeId === 'closed-sunday'));
    assert.ok(!t.days[0].stops.some((s) => s.placeId === 'closed-sunday'));
  });

  it('a place that closes before a late arrival goes to the next day', () => {
    const p = prefs(2, { firstDayStart: 18 * 60 });
    const morning = place({ id: 'morning-only', hours: { open: 8 * 60, close: 13 * 60 } });
    const other = place();
    const t = plan(p, [morning, other]);
    assert.ok(t.days[1].stops.some((s) => s.placeId === 'morning-only'));
    assertPlanIsExecutable(t, [morning, other], p);
  });

  it('two long visits far apart: no overlap, nothing past the end of the day, the extra one is listed', () => {
    const a = place({ id: 'far-a', visitMinutes: 300, location: { lat: 24.3, lng: 39.4 } });
    const b = place({ id: 'far-b', visitMinutes: 300, location: { lat: 24.65, lng: 39.85 } });
    const p = prefs(1);
    const t = plan(p, [a, b]);
    assertPlanIsExecutable(t, [a, b], p);
    assert.equal(t.days[0].stops.length, 1);
    assert.deepEqual(t.unscheduled, [{ placeId: t.days[0].stops[0].placeId === 'far-a' ? 'far-b' : 'far-a', reason: 'no_time_left' }]);
  });

  it('more places than the whole trip can hold: the rest stay unscheduled with a reason, no extra day, nothing after the day end', () => {
    const places = Array.from({ length: 14 }, () => place({ visitMinutes: 90 }));
    const p = prefs(2);
    const t = plan(p, places);
    assertPlanIsExecutable(t, places, p);
    assert.equal(t.days.length, 2);
    const scheduled = counts(t).reduce((a, b) => a + b);
    assert.equal(scheduled + t.unscheduled!.length, 14, 'every wanted place is either scheduled or listed');
    assert.ok(t.unscheduled!.length > 0);
    // Each entry is honest: "not_added" only when inserting it on that day really fits; otherwise no day can take it.
    const byId = new Map(places.map((x) => [x.id, x]));
    for (const u of t.unscheduled!) {
      const day = t.days.findIndex((d) => d.date === u.canFitOn);
      const fitsSomewhere = t.days.some((d) => bestInsertion(byId.get(u.placeId)!, d.stops.map((s) => s.placeId), d.date, byId, p, PRAYERS, BREAK));
      if (u.reason === 'not_added') assert.ok(day >= 0 && bestInsertion(byId.get(u.placeId)!, t.days[day].stops.map((s) => s.placeId), u.canFitOn!, byId, p, PRAYERS, BREAK));
      else assert.ok(!fitsSomewhere && u.reason === 'no_time_left', JSON.stringify(u));
    }
  });

  it('a place held back only by the relaxed pace is offered for a day, not called "no time"', () => {
    const places = Array.from({ length: 4 }, () => place({ visitMinutes: 30 }));
    const p = prefs(1, { relaxedPace: true });
    const t = plan(p, places);
    assert.equal(t.days[0].stops.length, 3);
    assert.deepEqual(t.unscheduled!.map((u) => [u.reason, u.canFitOn]), [['not_added', p.startDate]]);
  });

  it('fewer places than days: spread out, not used up at the start', () => {
    const places = [place(), place()];
    const p = prefs(5);
    const t = plan(p, places);
    assertPlanIsExecutable(t, places, p);
    const used = t.days.map((d, i) => (d.stops.length ? i : -1)).filter((i) => i >= 0);
    assert.equal(used.length, 2);
    assert.ok(used[1] - used[0] >= 2, `spaced apart: days ${used.map((i) => i + 1)}`);
  });

  it('a one-day trip still gets a full, valid day', () => {
    const places = Array.from({ length: 6 }, () => place());
    const p = prefs(1);
    const t = plan(p, places);
    assertPlanIsExecutable(t, places, p);
    assert.equal(t.days.length, 1);
    assert.equal(t.days[0].stops.length, 4, 'the daily maximum, as before');
    assert.equal(t.unscheduled!.length, 2);
    assert.ok(t.unscheduled!.every((u) => u.reason === 'not_added' || u.reason === 'no_time_left'));
  });

  it(`the longest trip keeps MAX_DAYS (${MAX_DAYS}) and uses every day`, () => {
    const places = Array.from({ length: 20 }, () => place({ visitMinutes: 45 }));
    const p = prefs(MAX_DAYS);
    const t = plan(p, places);
    assertPlanIsExecutable(t, places, p);
    assert.equal(t.days.length, MAX_DAYS);
    assert.ok(counts(t).every((c) => c >= 2), `${counts(t)}`);
    assert.equal(tripDates('2026-12-01', '2026-12-30').length, MAX_DAYS, 'longer ranges are capped (the API rejects them with 400)');
  });

  it('does not add places the traveller did not ask for just to fill a day', () => {
    const asked = [place({ category: 'history' })];
    const filler = [place({ category: 'market' }), place({ category: 'nature' })];
    const t = plan(prefs(3, { interests: ['history'] }), [...asked, ...filler]);
    assert.deepEqual(t.days.flatMap((d) => d.stops.map((s) => s.placeId)), [asked[0].id]);
  });

  it('wish-list places count as asked for, even outside the chosen interests', () => {
    const wish = place({ id: 'wish-market', category: 'market' });
    const t = plan(prefs(2, { interests: ['history'] }), [place(), wish], ['wish-market']);
    assert.ok(t.days.some((d) => d.stops.some((s) => s.placeId === 'wish-market')));
  });

  it('keeps nearby places together when days are equally loaded', () => {
    const north = [place({ location: { lat: 24.55, lng: 39.61 } }), place({ location: { lat: 24.552, lng: 39.612 } })];
    const south = [place({ location: { lat: 24.38, lng: 39.61 } }), place({ location: { lat: 24.382, lng: 39.612 } })];
    const t = plan(prefs(2), [north[0], south[0], north[1], south[1]]);
    const dayOf = (id: string) => t.days.findIndex((d) => d.stops.some((s) => s.placeId === id));
    assert.equal(dayOf(north[0].id), dayOf(north[1].id));
    assert.equal(dayOf(south[0].id), dayOf(south[1].id));
  });
});

describe('review §3 and §7: prayer, travel and opening-hours edges', () => {
  const byIdOf = (ps: Place[]) => new Map(ps.map((x) => [x.id, x]));

  it('a prayer due during travel: pray first at its time, then travel; nothing overlaps', () => {
    // Visit A ends 11:55; the 20+ min drive to B would cross dhuhr at 12:05.
    const a = place({ id: 'ta', location: CENTER, visitMinutes: 175 });
    const b = place({ id: 'tb', location: { lat: CENTER.lat + 0.1, lng: CENTER.lng } });
    const p = prefs(1);
    const L = layoutDay(p.startDate, ['ta', 'tb'], byIdOf([a, b]), p, PRAYERS, BREAK);
    assertDayIsExecutable(L, byIdOf([a, b]), 'travel');
    const dhuhr = L.day.breaks.find((x) => x.prayer === 'dhuhr')!;
    assert.equal(dhuhr.at, 12 * 60 + 5, 'shown at its real time');
    const travel = L.timeline.find((s) => s.kind === 'travel')!;
    assert.equal(dhuhr.phase, 'before_travel');
    assert.equal(travel.from, dhuhr.until, 'travel starts after the prayer');
  });

  it('a prayer due during a visit elsewhere pauses the visit, which then continues', () => {
    const a = place({ id: 'va', visitMinutes: 60, hours: { open: 11 * 60 + 30, close: 22 * 60 } });
    const p = prefs(1, { firstDayStart: 11 * 60 + 30 });
    const L = layoutDay(p.startDate, ['va'], byIdOf([a]), p, PRAYERS, BREAK);
    assertDayIsExecutable(L, byIdOf([a]), 'visit');
    assert.equal(L.day.stops[0].start, 11 * 60 + 30);
    const b = L.day.breaks[0];
    assert.deepEqual([b.prayer, b.at, b.phase, b.atPlace, b.afterStop], ['dhuhr', 12 * 60 + 5, 'in_visit', false, 0]);
    assert.equal(L.end, 11 * 60 + 30 + 60 + BREAK);
  });

  it('a 4-hour visit fits a normal day even with prayers inside it', () => {
    const long = place({ id: 'long', visitMinutes: 240 });
    const p = prefs(1);
    const L = layoutDay(p.startDate, ['long'], byIdOf([long]), p, PRAYERS, BREAK);
    assert.ok(L.fits);
    assertDayIsExecutable(L, byIdOf([long]), 'long');
  });

  it('a prayer during a mosque visit happens inside the visit, which is extended', () => {
    const m = place({ id: 'mosque', category: 'religious', visitMinutes: 60 });
    const p = prefs(1, { firstDayStart: 11 * 60 + 30 });
    const L = layoutDay(p.startDate, ['mosque'], byIdOf([m]), p, PRAYERS, BREAK);
    assertDayIsExecutable(L, byIdOf([m]), 'mosque');
    const visit = L.timeline.find((s) => s.kind === 'visit')!;
    assert.equal(visit.from, 11 * 60 + 30);
    assert.equal(visit.to - visit.from, 60 + BREAK);
    assert.ok(L.day.breaks.find((x) => x.prayer === 'dhuhr')!.atPlace);
  });

  it('prayers after the last stop are shown in place, and only while the day is on', () => {
    const a = place({ id: 'early', visitMinutes: 60 });
    const p = prefs(1);
    const L = layoutDay(p.startDate, ['early'], byIdOf([a]), p, PRAYERS, BREAK);
    assertDayIsExecutable(L, byIdOf([a]), 'after');
    assert.deepEqual(L.day.breaks.map((x) => x.prayer), ['dhuhr', 'asr', 'maghrib', 'isha']);
    const short = prefs(1, { lastDayEnd: 16 * 60 });
    const S = layoutDay(short.startDate, ['early'], byIdOf([a]), short, PRAYERS, BREAK);
    assert.deepEqual(S.day.breaks.map((x) => x.prayer), ['dhuhr', 'asr'], 'no break after the end of the day');
  });

  it('waiting for opening across a prayer: the prayer is taken while waiting, and the visit still starts at opening', () => {
    const a = place({ id: 'opens-1230', hours: { open: 12 * 60 + 30, close: 22 * 60 } });
    const p = prefs(1, { firstDayStart: 12 * 60 });
    const L = layoutDay(p.startDate, ['opens-1230'], byIdOf([a]), p, PRAYERS, BREAK);
    assertDayIsExecutable(L, byIdOf([a]), 'wait');
    assert.equal(L.day.stops[0].start, 12 * 60 + 30);
  });

  it('a break that would push a visit past closing makes the day not fit, so the planner does not use it', () => {
    const a = place({ id: 'closes-1220', visitMinutes: 60, hours: { open: 11 * 60, close: 12 * 60 + 20 } });
    const p = prefs(1, { firstDayStart: 11 * 60 + 30 });
    const L = layoutDay(p.startDate, ['closes-1220'], byIdOf([a]), p, PRAYERS, BREAK);
    assert.equal(L.fits, false);
    assert.equal(L.day.stops[0].warning, 'outside_hours');
    assert.equal(plan(p, [a]).unscheduled![0].reason, 'closed_on_trip_days');
  });

  it('explains why a place was left out', () => {
    const p = prefs(2);
    const alwaysClosed = place({ id: 'closed', hours: { open: 8 * 60, close: 20 * 60, closedOn: [0, 1, 2, 3, 4, 5, 6] } });
    const tooLong = place({ id: 'too-long', visitMinutes: 13 * 60 });
    const t = plan(p, [alwaysClosed, tooLong]);
    assert.deepEqual(new Map(t.unscheduled!.map((u) => [u.placeId, u.reason])), new Map([['closed', 'closed_on_trip_days'], ['too-long', 'longer_than_day']]));
  });

  it('re-laying out one edited day leaves the other days untouched', () => {
    const places = Array.from({ length: 6 }, () => place());
    const p = prefs(3);
    const t = plan(p, places);
    const before = JSON.stringify([t.days[0], t.days[2]]);
    const edited = { ...t.days[1], stops: [...t.days[1].stops].reverse() };
    const day2 = rescheduleDay(edited, places, p, PRAYERS, BREAK);
    assert.deepEqual(day2.stops.map((s) => s.placeId), edited.stops.map((s) => s.placeId));
    assert.equal(JSON.stringify([t.days[0], t.days[2]]), before);
  });

  it('day windows: normal days 09:00–21:00; first and last days follow arrival and departure', () => {
    const p = prefs(3, { firstDayStart: 15 * 60, lastDayEnd: 13 * 60 });
    assert.deepEqual(dayWindow(p.startDate, p), { start: 15 * 60, end: DAY_END });
    assert.deepEqual(dayWindow('2026-12-07', p), { start: DAY_START, end: DAY_END });
    assert.deepEqual(dayWindow(p.endDate, p), { start: DAY_START, end: 13 * 60 });
  });
});

describe('every generated plan is executable (randomized)', () => {
  it('400 random trips: right number of days, no overlaps, inside hours and windows, every wanted place accounted for', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    for (let trial = 0; trial < 400; trial++) {
      const count = 1 + Math.floor(rnd() * 16);
      const places = Array.from({ length: count }, () => {
        const open = pick([0, 6 * 60, 8 * 60, 10 * 60, 13 * 60, 16 * 60]);
        const close = Math.min(1440, open + pick([180, 300, 480, 720, 1440]));
        return place({
          category: pick(['history', 'religious', 'museum'] as const),
          visitMinutes: pick([20, 30, 45, 60, 90, 120, 180, 240]),
          location: { lat: CENTER.lat + (rnd() - 0.5) * 0.3, lng: CENTER.lng + (rnd() - 0.5) * 0.3 },
          hours: rnd() < 0.15 ? null : { open, close, closedOn: rnd() < 0.3 ? [Math.floor(rnd() * 7)] : [] }
        });
      });
      const days = 1 + Math.floor(rnd() * MAX_DAYS);
      const p = prefs(days, {
        interests: rnd() < 0.5 ? ['history', 'religious'] : ['history', 'religious', 'museum'],
        relaxedPace: rnd() < 0.4,
        aroundPrayerTimes: rnd() < 0.8,
        firstDayStart: rnd() < 0.3 ? pick([11 * 60, 14 * 60, 17 * 60, 20 * 60]) : null,
        lastDayEnd: rnd() < 0.3 ? pick([10 * 60, 13 * 60, 16 * 60]) : null
      });
      const t = plan(p, places);
      assertPlanIsExecutable(t, places, p, `trial ${trial}`);
      const wanted = places.filter((x) => p.interests.includes(x.category));
      const scheduled = new Set(t.days.flatMap((d) => d.stops.map((s) => s.placeId)));
      const listed = new Set(t.unscheduled!.map((u) => u.placeId));
      for (const w of wanted) assert.ok(scheduled.has(w.id) !== listed.has(w.id), `trial ${trial}: ${w.id} must be scheduled or listed, exactly once`);
      // Balance: while any wanted place is left over for lack of time, no day may be empty if it could have taken it alone.
      if (t.unscheduled!.some((u) => u.reason === 'no_time_left')) {
        for (const d of t.days) if (!d.stops.length) {
          const byId = new Map(places.map((x) => [x.id, x]));
          const couldFit = t.unscheduled!.filter((u) => u.reason === 'no_time_left').some((u) => layoutDay(d.date, [u.placeId], byId, p, PRAYERS, BREAK).fits);
          assert.ok(!couldFit, `trial ${trial}: day ${d.date} left empty while a place that fits it was left out`);
        }
      }
    }
  });
});
