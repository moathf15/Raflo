/**
 * Manual scheduling ticket (4 Nov 2026): every manual add, move or removal is checked like a generated plan.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { explainUnscheduled, generatePlan, layoutDay, suggestDay, tripDates, validateDays, weekdayOf, type Place, type PrayerTime, type TripPreferences } from '../src';

const PRAYERS: PrayerTime[] = [
  { prayer: 'dhuhr', at: 725 },
  { prayer: 'asr', at: 920 },
  { prayer: 'maghrib', at: 1060 },
  { prayer: 'isha', at: 1150 }
];
let n = 0;
const place = (over: Partial<Place> = {}): Place => ({
  id: `m${++n}`, cityId: 'madinah', name: `م${n}`, summary: 's', category: 'history',
  location: { lat: 24.4672 + (n % 5) * 0.004, lng: 39.6112 + (n % 3) * 0.004 }, visitMinutes: 60, costPerPerson: 0, openingHours: 'x',
  hours: { open: 0, close: 1440 }, source: null, verifiedAt: null, bestTime: 'any', etiquette: null, status: 'published', updatedAt: '2026-10-01', openReports: 0, ...over
});
const prefs = (days: number, over: Partial<TripPreferences> = {}): TripPreferences => ({
  cityId: 'madinah', startDate: '2026-12-06', endDate: new Date(Date.UTC(2026, 11, 5 + days)).toISOString().slice(0, 10),
  travellers: 2, tripType: 'family', budgetTotal: 1000, interests: ['history'], aroundPrayerTimes: true, relaxedPace: false, ...over
});
const P = () => PRAYERS;

describe('manual edits are validated like generated plans', () => {
  it('adding a place to a full day is refused, and another day that fits is suggested', () => {
    const full = Array.from({ length: 4 }, () => place({ visitMinutes: 150 }));
    const extra = place({ visitMinutes: 90 });
    const all = [...full, extra];
    const byId = new Map(all.map((x) => [x.id, x]));
    const p = prefs(2);
    const dates = tripDates(p.startDate, p.endDate);
    const days = [full.map((x) => x.id), []];
    assert.deepEqual(validateDays(days, dates, byId, p, P), [], 'the full day itself fits');
    const problems = validateDays([[...days[0], extra.id], []], dates, byId, p, P);
    assert.deepEqual(problems.map((x) => x.problem), ['past_day_end']);
    assert.deepEqual(suggestDay(extra, days, dates, byId, p, P, 20, 0), { dayIndex: 1, placeIds: [extra.id] });
  });

  it('a long visit that cannot end before the end of the day is refused', () => {
    const long = place({ visitMinutes: 600 });
    const p = prefs(1, { firstDayStart: 12 * 60 });
    const problems = validateDays([[long.id]], [p.startDate], new Map([[long.id, long]]), p, P);
    assert.deepEqual(problems, [{ date: p.startDate, placeId: long.id, problem: 'past_day_end' }]);
  });

  it('a visit outside opening hours, or on a closed weekday, is refused with the place named', () => {
    const p = prefs(1, { firstDayStart: 15 * 60 });
    const morning = place({ hours: { open: 8 * 60, close: 13 * 60 } });
    const closed = place({ hours: { open: 0, close: 1440, closedOn: [weekdayOf(p.startDate)] } });
    const byId = new Map([morning, closed].map((x) => [x.id, x]));
    assert.deepEqual(validateDays([[morning.id, closed.id]], [p.startDate], byId, p, P).map((x) => [x.placeId, x.problem]), [[morning.id, 'outside_hours'], [closed.id, 'closed_that_day']]);
  });

  it('reordering that breaks a day is caught too', () => {
    // B closes at 11:00: fine first, not after a 2-hour visit.
    const a = place({ visitMinutes: 120 });
    const b = place({ hours: { open: 9 * 60, close: 11 * 60 }, visitMinutes: 60 });
    const byId = new Map([a, b].map((x) => [x.id, x]));
    const p = prefs(1);
    assert.deepEqual(validateDays([[b.id, a.id]], [p.startDate], byId, p, P), []);
    assert.deepEqual(validateDays([[a.id, b.id]], [p.startDate], byId, p, P).map((x) => x.problem), ['outside_hours']);
  });

  it('the left-out list is rebuilt after each edit; a place leaves it only once it is really scheduled', () => {
    const ps = Array.from({ length: 3 }, () => place());
    const byId = new Map(ps.map((x) => [x.id, x]));
    const p = prefs(2);
    const dates = tripDates(p.startDate, p.endDate);
    const t = generatePlan({ preferences: p, places: ps, prayerTimes: PRAYERS, title: 't' });
    assert.deepEqual(t.unscheduled, []);
    // The traveller removes one place: it comes back to the list, offered for a day where it fits.
    const days = t.days.map((d) => d.stops.map((s) => s.placeId));
    const removed = days[0].shift()!;
    const after = explainUnscheduled(ps, days, dates, byId, p, P);
    assert.equal(after.length, 1);
    assert.equal(after[0].placeId, removed);
    assert.equal(after[0].reason, 'not_added');
    assert.ok(layoutDay(after[0].canFitOn!, [...days[dates.indexOf(after[0].canFitOn!)], removed], byId, p, PRAYERS).fits);
    // Added back: gone from the list.
    days[1].push(removed);
    assert.deepEqual(validateDays(days, dates, byId, p, P), []);
    assert.deepEqual(explainUnscheduled(ps, days, dates, byId, p, P), []);
  });

  it('a place that fits nowhere stays listed with its reason', () => {
    const closed = place({ hours: { open: 8 * 60, close: 20 * 60, closedOn: [0, 1, 2, 3, 4, 5, 6] } });
    const p = prefs(2);
    const dates = tripDates(p.startDate, p.endDate);
    assert.deepEqual(explainUnscheduled([closed], [[], []], dates, new Map([[closed.id, closed]]), p, P), [{ placeId: closed.id, reason: 'closed_on_trip_days' }]);
  });
});
