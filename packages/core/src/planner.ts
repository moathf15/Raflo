import { distanceKm, travelMinutes } from './geo';
import type { PrayerTime } from './prayer';
import type { Break, CategoryId, DayProblem, Place, Stop, Trip, TripDay, TripPreferences, UnscheduledPlace, UnscheduledReason } from './types';

export const DAY_START = 9 * 60;
/** No visit is planned to end after 21:00. */
export const DAY_END = 21 * 60;
export const MAX_DAYS = 7;
const DEFAULT_BREAK = 20;

/** Prayer times for one date. A fixed list is accepted for tests. */
export type PrayerSource = PrayerTime[] | ((isoDate: string) => PrayerTime[]);

export interface PlanInput {
  preferences: TripPreferences;
  places: Place[];
  wishList?: string[];
  prayerTimes?: PrayerSource;
  /** Minutes reserved for each prayer when the traveller asked to plan around prayer. */
  breakMinutes?: number;
  title: string;
}

let seq = 0;
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}`;
const prayersOn = (src: PrayerSource | undefined, date: string) => (!src ? [] : typeof src === 'function' ? src(date) : src);

/** Calendar check for yyyy-mm-dd: rejects 2026-02-30, 2026-99-99, 2025-02-29 (audit 5.3). */
export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function tripDates(start: string, end: string): string[] {
  const out: string[] = [];
  // Date-only maths in UTC so the user's timezone can never shift a day.
  const d = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (d <= last && out.length < MAX_DAYS) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out.length ? out : [start];
}

/**
 * Published places in a balanced order (audit 5.1): the traveller's interests take turns
 * (religious, history, religious, history…) instead of following data order, wish-list places
 * first within each interest; other categories come after.
 */
export function rankPlaces(places: Place[], prefs: TripPreferences, wishList: string[] = []): Place[] {
  const pool = places.filter((p) => p.status === 'published' && p.cityId === prefs.cityId);
  const byWish = (a: Place, b: Place) => Number(wishList.includes(b.id)) - Number(wishList.includes(a.id)) || a.name.localeCompare(b.name, 'ar');
  const queues = prefs.interests.map((c: CategoryId) => pool.filter((p) => p.category === c).sort(byWish));
  const out: Place[] = [];
  while (queues.some((q) => q.length)) for (const q of queues) if (q.length) out.push(q.shift()!);
  const rest = pool.filter((p) => !out.includes(p)).sort(byWish);
  return [...out, ...rest];
}

const routeLength = (r: Place[]) => r.reduce((s, p, i) => (i ? s + distanceKm(r[i - 1].location, p.location) : 0), 0);

/** Short route: nearest neighbour from the first place, then 2-opt improvement (first place fixed). */
export function orderAsRoute(group: Place[]): Place[] {
  if (group.length < 3) return group;
  const [first, ...rest] = group;
  let route = [first];
  const left = [...rest];
  while (left.length) {
    const last = route[route.length - 1];
    left.sort((a, b) => distanceKm(last.location, a.location) - distanceKm(last.location, b.location));
    route.push(left.shift()!);
  }
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < route.length - 1; i++) {
      for (let k = i + 1; k < route.length; k++) {
        const next = [...route.slice(0, i), ...route.slice(i, k + 1).reverse(), ...route.slice(k + 1)];
        if (routeLength(next) + 1e-9 < routeLength(route)) {
          route = next;
          improved = true;
        }
      }
    }
  }
  return route;
}

/** The usable part of a day: the normal day, shortened on the first day by a late start and on the last day by an early end. */
export interface DayWindow {
  start: number;
  end: number;
}

export function dayWindow(date: string, prefs: TripPreferences): DayWindow {
  let start = DAY_START;
  let end = DAY_END;
  if (date === prefs.startDate && prefs.firstDayStart != null) start = Math.max(start, prefs.firstDayStart);
  if (date === prefs.endDate && prefs.lastDayEnd != null) end = Math.min(end, prefs.lastDayEnd);
  return { start, end: Math.max(start, end) };
}

/** Day of week for an ISO date, 0 = Sunday … 6 = Saturday (UTC maths, so the device time zone cannot shift it). */
export const weekdayOf = (date: string) => new Date(date + 'T00:00:00Z').getUTCDay();

/** One block of time in a laid-out day. Prayers that pause a visit (`inVisit`) sit inside it; everything else is sequential. */
export interface Segment {
  kind: 'travel' | 'visit' | 'prayer';
  from: number;
  to: number;
  /** Stop index for travel (to this stop) and visits. */
  stop?: number;
  inVisit?: boolean;
}

export interface DayLayout {
  day: TripDay;
  /** Every block of the day in time order, for checking and display. */
  timeline: Segment[];
  window: DayWindow;
  /** When the last visit ends (window start for an empty day). */
  end: number;
  /** True when every visit is inside its opening hours on that weekday and the day ends inside the window. */
  fits: boolean;
  /** What makes the day not fit (empty when it fits). */
  problems: DayProblem[];
}

/**
 * Lay out one day in the given order (audit 5.1, 5.2; review 4 Nov, section 3):
 * - the day starts at the window start (late arrival on the first day) and must end by the window end;
 * - travel starts when the traveller is free; a prayer due during travel is taken first, then the travel;
 * - arriving before opening means waiting for opening; a prayer due while waiting is taken while waiting;
 * - a prayer due during a visit pauses it (inside the mosque at a mosque, nearby elsewhere) and the visit is
 *   extended by the break — restarting the whole visit after each prayer made long visits impossible;
 * - prayers after the last visit are shown if they end inside the window;
 * - nothing overlaps, nothing starts before the window, every block is in time order.
 */
export function layoutDay(date: string, placeIds: string[], byId: Map<string, Place>, prefs: TripPreferences, prayers: PrayerTime[], breakMinutes = DEFAULT_BREAK): DayLayout {
  const window = dayWindow(date, prefs);
  const weekday = weekdayOf(date);
  const stops: Stop[] = [];
  const breaks: Break[] = [];
  const timeline: Segment[] = [];
  const pending = prefs.aroundPrayerTimes ? [...prayers].filter((p) => p.at >= window.start).sort((a, b) => a.at - b.at) : [];
  let cursor = window.start;
  let prev: Place | null = null;
  const problems: DayProblem[] = [];

  const pray = (p: PrayerTime, from: number, afterStop: number, phase: 'before_travel' | 'waiting' | 'end_of_day') => {
    breaks.push({ kind: 'prayer', prayer: p.prayer, at: from, until: from + breakMinutes, afterStop, atPlace: false, phase });
    timeline.push({ kind: 'prayer', from, to: from + breakMinutes });
    return from + breakMinutes;
  };

  for (const id of placeIds) {
    const place = byId.get(id);
    if (!place) continue;
    const i = stops.length;
    const km = prev ? distanceKm(prev.location, place.location) * 1.3 : null;
    const travel = km === null ? 0 : travelMinutes(km / 1.3);

    // Prayers due before the traveller could arrive: pray where they are, then travel.
    while (pending.length && pending[0].at < cursor + travel) {
      const p = pending.shift()!;
      cursor = pray(p, Math.max(p.at, cursor), i - 1, 'before_travel');
    }
    const arrive = cursor + travel;
    if (travel) timeline.push({ kind: 'travel', from: cursor, to: arrive, stop: i });

    const hours = place.hours;
    const closedToday = !!hours?.closedOn?.includes(weekday);
    let start = hours && !closedToday ? Math.max(arrive, hours.open) : arrive;
    // Prayers due while waiting for opening are taken while waiting.
    while (pending.length && pending[0].at < start) {
      const p = pending.shift()!;
      start = Math.max(start, pray(p, Math.max(p.at, arrive), i - 1, 'waiting'));
    }
    // Prayers due during the visit pause it: inside the mosque for a mosque, nearby elsewhere. The visit is extended by the break.
    let end = start + place.visitMinutes;
    while (pending.length && pending[0].at < end) {
      const p = pending.shift()!;
      const atPlace = place.category === 'religious';
      breaks.push({ kind: 'prayer', prayer: p.prayer, at: p.at, until: p.at + breakMinutes, afterStop: i, atPlace, phase: 'in_visit' });
      timeline.push({ kind: 'prayer', from: p.at, to: p.at + breakMinutes, inVisit: true });
      end += breakMinutes;
    }

    const warning = closedToday ? 'closed_that_day' : !hours ? 'hours_unknown' : start < hours.open || end > hours.close ? 'outside_hours' : undefined;
    if (warning === 'closed_that_day' || warning === 'outside_hours') problems.push({ date, placeId: id, problem: warning });
    stops.push({ id: newId('stop'), placeId: id, start, travelFromPrevious: km === null ? null : travel, distanceFromPreviousKm: km === null ? null : Math.round(km * 10) / 10, ...(warning ? { warning } : {}) });
    timeline.push({ kind: 'visit', from: start, to: end, stop: i });
    cursor = end;
    prev = place;
  }

  const end = cursor;
  if (end > window.end) problems.push({ date, placeId: stops.at(-1)?.placeId, problem: 'past_day_end' });
  // Prayers after the last visit, while the day is still on.
  if (stops.length) {
    let free = cursor;
    for (const p of pending) {
      const from = Math.max(p.at, free);
      if (from + breakMinutes > window.end) break;
      free = pray(p, from, stops.length - 1, 'end_of_day');
    }
  }
  timeline.sort((a, b) => a.from - b.from || Number(!!a.inVisit) - Number(!!b.inVisit));
  return { day: { date, stops, breaks }, timeline, window, end, fits: problems.length === 0, problems };
}

/** Lay out one day (see layoutDay). Kept for callers that only need the day. */
export function scheduleDay(date: string, placeIds: string[], byId: Map<string, Place>, prefs: TripPreferences, prayers: PrayerTime[], breakMinutes = DEFAULT_BREAK): TripDay {
  return layoutDay(date, placeIds, byId, prefs, prayers, breakMinutes).day;
}

/**
 * Why a wanted place is not in the plan: closed (or outside its hours) on every day of the trip,
 * longer than the time any day allows, or it would fit but the days are full.
 */
export function unscheduledReason(place: Place, dates: string[], prefs: TripPreferences, prayersFor: (date: string) => PrayerTime[], breakMinutes = DEFAULT_BREAK): UnscheduledReason {
  const fitsSomeDay = (p: Place) => dates.some((date) => layoutDay(date, [p.id], new Map([[p.id, p]]), prefs, prayersFor(date), breakMinutes).fits);
  if (fitsSomeDay(place)) return 'no_time_left';
  // It does not fit even alone. If it would fit with no opening-hours limits, the hours (or closing days) are the reason.
  return fitsSomeDay({ ...place, hours: null }) ? 'closed_on_trip_days' : 'longer_than_day';
}

/** Interest places and wish-list places are what the traveller asked for; other categories are not added to fill days. */
function wanted(ranked: Place[], prefs: TripPreferences, wishList: string[]) {
  const asked = ranked.filter((p) => prefs.interests.includes(p.category) || wishList.includes(p.id));
  return asked.length ? asked : ranked;
}

const centroid = (ps: Place[]) => ({ lat: ps.reduce((s, p) => s + p.location.lat, 0) / ps.length, lng: ps.reduce((s, p) => s + p.location.lng, 0) / ps.length });

/**
 * Build the trip (review 4 Nov, sections 4–6):
 * 1. one day per date from start to end; each day has its own window (late first day, early last day);
 * 2. wanted places in ranked order (interests take turns, wish list first) are allocated one by one to the day
 *    with the lowest load, where load = time already used ÷ time available that day — so a short day takes fewer stops;
 *    when there are fewer places than days they are spread out (e.g. 2 places in 5 days → days 1 and 3);
 * 3. among days with similar load, the one closest to the place geographically wins, to keep travel short;
 * 4. each insertion is laid out for real (route order, opening hours on that weekday, prayers, day end);
 *    if it does not fit, the next day is tried, so a place closed on day 1 goes to day 2;
 * 5. places that fit nowhere are returned in `unscheduled` with a reason — never squeezed past the day end.
 */
export function generatePlan({ preferences, places, wishList = [], prayerTimes: prayerSrc, breakMinutes = DEFAULT_BREAK, title }: PlanInput): Trip {
  const dates = tripDates(preferences.startDate, preferences.endDate);
  const perDay = preferences.relaxedPace ? 3 : 4;
  const byId = new Map(places.map((p) => [p.id, p]));
  const prayersFor = (date: string) => prayersOn(prayerSrc, date);
  const candidates = wanted(rankPlaces(places, preferences, wishList), preferences, wishList);

  const days = dates.map((date) => {
    const layout = layoutDay(date, [], byId, preferences, prayersFor(date), breakMinutes);
    return { date, chosen: [] as Place[], layout, available: layout.window.end - layout.window.start };
  });
  const load = (d: (typeof days)[number]) => (d.available <= 0 ? Infinity : (d.layout.end - d.layout.window.start) / d.available);
  const sparse = candidates.length < days.length;
  const left: Place[] = [];

  candidates.forEach((place, k) => {
    const preferred = sparse ? Math.floor((k * days.length) / candidates.length) : -1;
    const order = days
      .map((d, i) => ({ d, i, score: load(d) + (d.chosen.length ? distanceKm(centroid(d.chosen), place.location) * 0.004 : 0) }))
      .filter(({ d }) => d.chosen.length < perDay && d.available > 0)
      .sort((a, b) => Number(b.i === preferred) - Number(a.i === preferred) || a.score - b.score || a.i - b.i);

    for (const { d } of order) {
      // Try the shortest route first, then inserting the place at each position of the current order.
      const tries = [orderAsRoute([...d.chosen, place]), ...d.chosen.map((_, at) => [...d.chosen.slice(0, at), place, ...d.chosen.slice(at)]), [...d.chosen, place]];
      const fitting = tries
        .map((route) => ({ route, layout: layoutDay(d.date, route.map((p) => p.id), byId, preferences, prayersFor(d.date), breakMinutes) }))
        .filter((t) => t.layout.fits)
        .sort((a, b) => routeLength(a.route) - routeLength(b.route) || a.layout.end - b.layout.end)[0];
      if (fitting) {
        d.chosen = fitting.route;
        d.layout = fitting.layout;
        return;
      }
    }
    left.push(place);
  });

  // Geography pass: swap two places between two days when that shortens total travel, keeps the same number of
  // stops per day, does not unbalance the days' time load, and both days still fit. Distribution comes first.
  const bestFit = (date: string, list: Place[]) =>
    [orderAsRoute(list), list]
      .map((route) => ({ route, layout: layoutDay(date, route.map((p) => p.id), byId, preferences, prayersFor(date), breakMinutes) }))
      .filter((t) => t.layout.fits)
      .sort((a, b) => routeLength(a.route) - routeLength(b.route))[0];
  const loadOf = (d: (typeof days)[number], end: number) => (end - d.layout.window.start) / d.available;
  for (let round = 0, improved = true; improved && round < 20; round++) {
    improved = false;
    for (let a = 0; a < days.length; a++) {
      for (let b = a + 1; b < days.length; b++) {
        const A = days[a], B = days[b];
        for (const x of [...A.chosen]) {
          for (const y of [...B.chosen]) {
            if (!A.chosen.includes(x) || !B.chosen.includes(y)) continue;
            const nextA = bestFit(A.date, A.chosen.map((p) => (p === x ? y : p)));
            const nextB = bestFit(B.date, B.chosen.map((p) => (p === y ? x : p)));
            if (!nextA || !nextB) continue;
            const gain = routeLength(A.chosen) + routeLength(B.chosen) - routeLength(nextA.route) - routeLength(nextB.route);
            const spreadBefore = Math.abs(load(A) - load(B));
            const spreadAfter = Math.abs(loadOf(A, nextA.layout.end) - loadOf(B, nextB.layout.end));
            if (gain > 0.1 && spreadAfter <= Math.max(spreadBefore, 0.15)) {
              A.chosen = nextA.route;
              A.layout = nextA.layout;
              B.chosen = nextB.route;
              B.layout = nextB.layout;
              improved = true;
            }
          }
        }
      }
    }
  }

  // Same explanation as after a manual edit: a place held back only by the daily stop limit (pace) is "not_added"
  // with the day it would fit on; the others get the reason they cannot fit.
  const unscheduled: UnscheduledPlace[] = explainUnscheduled(left, days.map((d) => d.chosen.map((p) => p.id)), dates, byId, preferences, prayersFor, breakMinutes);
  return { id: newId('trip'), title, preferences, days: days.map((d) => d.layout.day), unscheduled, saved: false, createdAt: new Date().toISOString() };
}

/**
 * Check days as the traveller edited them (manual scheduling ticket, 4 Nov 2026): every day is laid out again
 * and must fit — visits inside opening hours on that weekday and the day ending inside its window — exactly like
 * generated plans. Used by the app before applying an edit, by the API before saving, and by the mock API.
 */
export function validateDays(placeIdsByDay: string[][], dates: string[], byId: Map<string, Place>, prefs: TripPreferences, prayersFor: (date: string) => PrayerTime[], breakMinutes = DEFAULT_BREAK): DayProblem[] {
  return dates.flatMap((date, i) => layoutDay(date, placeIdsByDay[i] ?? [], byId, prefs, prayersFor(date), breakMinutes).problems);
}

/** The shortest-route way to add `place` to one day that still fits, or null. */
export function bestInsertion(place: Place, dayIds: string[], date: string, byId: Map<string, Place>, prefs: TripPreferences, prayers: PrayerTime[], breakMinutes = DEFAULT_BREAK): { placeIds: string[]; layout: DayLayout } | null {
  if (dayIds.includes(place.id)) return null;
  const all = new Map(byId).set(place.id, place);
  const current = dayIds.map((id) => all.get(id)).filter((p): p is Place => !!p);
  const tries = [...current.map((_, at) => [...current.slice(0, at), place, ...current.slice(at)]), [...current, place], current.length ? orderAsRoute([...current, place]) : [place]];
  return (
    tries
      .map((route) => ({ route, layout: layoutDay(date, route.map((p) => p.id), all, prefs, prayers, breakMinutes) }))
      .filter((t) => t.layout.fits)
      .sort((a, b) => routeLength(a.route) - routeLength(b.route) || a.layout.end - b.layout.end)
      .map((t) => ({ placeIds: t.route.map((p) => p.id), layout: t.layout }))[0] ?? null
  );
}

/** The least busy day (by time) where `place` fits as the days are now, optionally skipping one day. */
export function suggestDay(place: Place, placeIdsByDay: string[][], dates: string[], byId: Map<string, Place>, prefs: TripPreferences, prayersFor: (date: string) => PrayerTime[], breakMinutes = DEFAULT_BREAK, skip = -1): { dayIndex: number; placeIds: string[] } | null {
  const options = dates
    .map((date, i) => ({ i, fit: i === skip ? null : bestInsertion(place, placeIdsByDay[i] ?? [], date, byId, prefs, prayersFor(date), breakMinutes) }))
    .filter((o) => o.fit)
    .map((o) => ({ dayIndex: o.i, placeIds: o.fit!.placeIds, load: (o.fit!.layout.end - o.fit!.layout.window.start) / Math.max(1, o.fit!.layout.window.end - o.fit!.layout.window.start) }))
    .sort((a, b) => a.load - b.load || a.dayIndex - b.dayIndex);
  return options[0] ? { dayIndex: options[0].dayIndex, placeIds: options[0].placeIds } : null;
}

/**
 * Rebuild the "could not fit" list after any edit: every wanted place that is not in the trip is listed again,
 * with `not_added` + the day it would fit on if there is one, otherwise the reason it cannot fit.
 * A place leaves the list only by being scheduled in a day that fits.
 */
export function explainUnscheduled(wanted: Place[], placeIdsByDay: string[][], dates: string[], byId: Map<string, Place>, prefs: TripPreferences, prayersFor: (date: string) => PrayerTime[], breakMinutes = DEFAULT_BREAK): UnscheduledPlace[] {
  const scheduled = new Set(placeIdsByDay.flat());
  const seen = new Set<string>();
  return wanted
    .filter((p) => !scheduled.has(p.id) && !seen.has(p.id) && seen.add(p.id))
    .map((p) => {
      const s = suggestDay(p, placeIdsByDay, dates, byId, prefs, prayersFor, breakMinutes);
      return s ? { placeId: p.id, reason: 'not_added' as const, canFitOn: dates[s.dayIndex] } : { placeId: p.id, reason: unscheduledReason(p, dates, prefs, prayersFor, breakMinutes) };
    });
}

/** No place twice on the same day (audit 5.1). Repeating a place on different days is allowed (e.g. the Prophet's Mosque daily). */
export function findDuplicateInDay(days: { placeIds: string[] }[]): string | null {
  for (const d of days) {
    const seen = new Set<string>();
    for (const id of d.placeIds) {
      if (seen.has(id)) return id;
      seen.add(id);
    }
  }
  return null;
}

/** Re-time a day after the user reorders, adds or removes stops. */
export function rescheduleDay(day: TripDay, places: Place[], prefs: TripPreferences, prayers: PrayerSource = [], breakMinutes = DEFAULT_BREAK): TripDay {
  const byId = new Map(places.map((p) => [p.id, p]));
  return scheduleDay(day.date, day.stops.map((s) => s.placeId), byId, prefs, prayersOn(prayers, day.date), breakMinutes);
}

export interface BudgetEstimate {
  /** Known entry costs × travellers. SAR. */
  entry: number;
  /** Estimated transport (sample assumption: 1.5 SAR per road km for the group). SAR. */
  transport: number;
  /** entry + transport. Excludes food, lodging and anything unknown. */
  estimate: number;
  /** Stops whose entry cost is still unknown. */
  unknownCosts: number;
}

export function estimateBudget(trip: Trip, places: Place[]): BudgetEstimate {
  const byId = new Map(places.map((p) => [p.id, p]));
  let entry = 0;
  let transport = 0;
  let unknownCosts = 0;
  for (const day of trip.days) {
    for (const s of day.stops) {
      const p = byId.get(s.placeId);
      if (!p) continue;
      if (p.costPerPerson === null) unknownCosts++;
      else entry += p.costPerPerson * trip.preferences.travellers;
      if (s.distanceFromPreviousKm) transport += s.distanceFromPreviousKm * 1.5;
    }
  }
  return { entry: Math.round(entry), transport: Math.round(transport), estimate: Math.round(entry + transport), unknownCosts };
}
