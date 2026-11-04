import { isStalePlace, publishProblems, todayIn } from '../content';
import { CITIES, SAMPLE_PLACES } from '../data/sample';
import { explainUnscheduled, generatePlan, newId, scheduleDay, tripDates, validateDays } from '../planner';
import { prayerTimes } from '../prayer';
import type { AdminOverview, AdminReport, Passport, Place, PlaceStatus, Trip, UnscheduledPlace, Visit } from '../types';
import { ApiError, type AdminApi, type AuthApi, type UserApi } from './contract';
import { createStore } from './storage';

/**
 * In-browser implementation for the shareable previews and offline UI work.
 * It applies the same content and visit rules as the API so the previews don't hide problems.
 * The apps refuse to use it in a production build unless VITE_ALLOW_MOCK=true (audit 6.1).
 */
export interface MockOptions {
  /** Simulated network delay in ms. */
  latency?: number;
  /** Make the next createPlan call fail, to exercise error states (`?fail=plan`). */
  failPlan?: boolean;
}

// v2: places gained structured hours; older preview data is ignored rather than mis-read.
const store = createStore('riflo.v2');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const city = (id: string) => CITIES.find((c) => c.id === id) ?? CITIES[0];

const places = () => store.read<Place[]>('places', SAMPLE_PLACES);

/** Left-out list from a trip's selection and days, as the server computes it (unpublished choices: unavailable). */
function mockLeftOut(p: Trip['preferences'], ids: string[][], selected: string[]): UnscheduledPlace[] {
  const c = CITIES.find((x) => x.id === p.cityId) ?? CITIES[0];
  const prayersFor = (d: string) => prayerTimes(c.location, c.timezone, d);
  const published = places().filter((x) => x.status === 'published' && x.cityId === p.cityId);
  const byId = new Map(published.map((x) => [x.id, x]));
  const pending = selected.filter((id) => !ids.flat().includes(id));
  const explained = new Map(explainUnscheduled(pending.filter((id) => byId.has(id)).map((id) => byId.get(id)!), ids, tripDates(p.startDate, p.endDate), byId, p, prayersFor).map((u) => [u.placeId, u]));
  return pending.map((id) => explained.get(id) ?? { placeId: id, reason: 'unavailable' as const });
}
const passport = () => store.read<Passport>('passport', { displayName: null, visits: [], wishList: [], lastPreferences: null });
const trips = () => store.read<Trip[]>('trips', []);
const reports = () => store.read<AdminReport[]>('reports', []);
const openReportCount = (placeId: string) => reports().filter((r) => r.placeId === placeId && ['new', 'in_review', 'reopened'].includes(r.status)).length;
const withReports = (p: Place): Place => ({ ...p, openReports: openReportCount(p.id) });

/** The mock has no accounts: everything belongs to one local, on-device traveller. */
function localAuth(role: 'user' | 'admin'): AuthApi {
  const user = { id: 'local', email: null, displayName: null, role };
  return { requiresAccount: false, current: async () => user, requestCode: async () => ({}), verify: async () => user, signOut: async () => undefined };
}

export function createMockApi(opts: MockOptions = {}): UserApi {
  const latency = opts.latency ?? 250;
  let failPlan = !!opts.failPlan;

  return {
    auth: localAuth('user'),
    startPlanSession: () => undefined,
    track: () => undefined,
    async listPlaces(cityId) {
      await wait(latency);
      return clone(places().filter((p) => p.cityId === cityId && p.status === 'published').map(withReports));
    },
    async getPlace(id) {
      await wait(latency / 2);
      const p = places().find((x) => x.id === id && x.status === 'published');
      return p ? clone(withReports(p)) : null;
    },
    async createPlan(preferences, title) {
      await wait(latency * 6);
      if (failPlan) {
        failPlan = false;
        throw new ApiError('plan_failed', 'network');
      }
      const pp = passport();
      const { startDate: _s, endDate: _e, ...remembered } = preferences;
      store.write('passport', { ...pp, lastPreferences: remembered });
      const c = city(preferences.cityId);
      return generatePlan({ preferences, places: places(), wishList: pp.wishList, prayerTimes: (d) => prayerTimes(c.location, c.timezone, d), title });
    },
    async getTrip(id) {
      await wait(latency);
      return clone(trips().find((t) => t.id === id) ?? null);
    },
    async listTrips() {
      await wait(latency);
      return clone(trips()).sort((a, b) => a.preferences.startDate.localeCompare(b.preferences.startDate));
    },
    async saveTrip(trip) {
      await wait(latency);
      // Same rules as the server: every day must fit, times are recomputed, the left-out list is rebuilt.
      const p = trip.preferences;
      const c = CITIES.find((x) => x.id === p.cityId) ?? CITIES[0];
      const prayersFor = (d: string) => prayerTimes(c.location, c.timezone, d);
      const published = places().filter((x) => x.status === 'published' && x.cityId === p.cityId);
      const byId = new Map(published.map((x) => [x.id, x]));
      const dates = tripDates(p.startDate, p.endDate);
      const ids = dates.map((_, i) => (trip.days[i]?.stops ?? []).map((s) => s.placeId).filter((id) => byId.has(id)));
      if (validateDays(ids, dates, byId, p, prayersFor).length) throw new ApiError('day_not_executable', 'invalid');
      // Same selection rules as the server: chosen once at creation, then changed only by scheduling or explicit removal.
      const stored = trips().find((x) => x.id === trip.id);
      const scheduled = ids.flat();
      let selected: string[];
      if (stored?.saved && stored.selected) selected = [...new Set([...stored.selected, ...scheduled])];
      else {
        const wish = new Set(passport().wishList);
        const excluded = new Set((trip.excluded ?? []).filter((id) => !scheduled.includes(id)));
        const hinted = (trip.unscheduled ?? []).map((u) => u.placeId);
        selected = [...new Set([...published.filter((x) => p.interests.includes(x.category)).map((x) => x.id), ...[...wish].filter((id) => byId.has(id)), ...scheduled, ...hinted.filter((id) => byId.has(id))])].filter((id) => !excluded.has(id));
      }
      const days = dates.map((d, i) => scheduleDay(d, ids[i], byId, p, prayersFor(d)));
      const saved: Trip = { ...trip, days, selected, excluded: undefined, unscheduled: mockLeftOut(p, ids, selected), saved: true };
      store.write('trips', [...trips().filter((t) => t.id !== trip.id), saved]);
      return clone(saved);
    },
    async removeFromTrip(tripId, placeId) {
      await wait(latency);
      const trip = trips().find((t) => t.id === tripId);
      if (!trip) throw new ApiError('not_found', 'not_found');
      const ids = trip.days.map((d) => d.stops.map((s) => s.placeId));
      if (ids.flat().includes(placeId)) throw new ApiError('place_scheduled', 'conflict');
      const selected = (trip.selected ?? []).filter((id) => id !== placeId);
      const next = { ...trip, selected, unscheduled: mockLeftOut(trip.preferences, ids, selected) };
      store.write('trips', trips().map((t) => (t.id === tripId ? next : t)));
      return clone(next);
    },
    async deleteTrip(id) {
      await wait(latency);
      store.write('trips', trips().filter((t) => t.id !== id));
    },
    async getPassport() {
      await wait(latency);
      return clone(passport());
    },
    async getPassportStats() {
      await wait(latency);
      const saved = trips();
      const visits = passport().visits;
      return {
        trips: saved.length,
        placesVisited: new Set(visits.map((v) => v.placeId)).size,
        visits: visits.length,
        travelDays: saved.reduce((n, t) => n + tripDates(t.preferences.startDate, t.preferences.endDate).length, 0)
      };
    },
    async logVisit(v) {
      await wait(latency);
      const today = todayIn(city('madinah').timezone);
      if (v.date > today) throw new ApiError('visit_in_future', 'invalid');
      if (v.tripId) {
        const trip = trips().find((t) => t.id === v.tripId);
        if (!trip?.days.some((d) => d.stops.some((s) => s.placeId === v.placeId))) throw new ApiError('place_not_in_trip', 'invalid');
      }
      const pp = passport();
      if (pp.visits.some((x) => x.placeId === v.placeId && x.date === v.date)) throw new ApiError('already_logged', 'conflict');
      const visit: Visit = { ...v, id: newId('visit'), source: 'self_reported' };
      store.write('passport', { ...pp, visits: [...pp.visits, visit], wishList: pp.wishList.filter((id) => id !== v.placeId) });
      return visit;
    },
    async updateVisit(id, changes) {
      await wait(latency);
      const pp = passport();
      const found = pp.visits.find((v) => v.id === id);
      if (!found) throw new ApiError('not_found', 'not_found');
      const next = { ...found, ...changes };
      store.write('passport', { ...pp, visits: pp.visits.map((v) => (v.id === id ? next : v)) });
      return next;
    },
    async deleteVisit(id) {
      await wait(latency);
      const pp = passport();
      store.write('passport', { ...pp, visits: pp.visits.filter((v) => v.id !== id) });
    },
    async toggleWish(placeId) {
      await wait(latency / 2);
      const pp = passport();
      const wishList = pp.wishList.includes(placeId) ? pp.wishList.filter((id) => id !== placeId) : [...pp.wishList, placeId];
      store.write('passport', { ...pp, wishList });
      return wishList;
    },
    async reportPlace(placeId, message) {
      await wait(latency);
      const place = places().find((p) => p.id === placeId);
      if (!place) throw new ApiError('not_found', 'not_found');
      const r: AdminReport = { id: newId('report'), placeId, placeName: place.name, kind: 'wrong_info', message, status: 'new', resolutionNote: null, createdAt: new Date().toISOString() };
      store.write('reports', [...reports(), r]);
    }
  };
}

export function createMockAdminApi(opts: MockOptions = {}): AdminApi {
  const latency = opts.latency ?? 250;
  const today = new Date();

  return {
    auth: localAuth('admin'),
    async listPlaces(cityId) {
      await wait(latency);
      return clone(places().filter((p) => p.cityId === cityId).map(withReports));
    },
    async savePlace(place) {
      await wait(latency);
      if (!place.name.trim()) throw new ApiError('name_required', 'invalid');
      if (place.status === 'published' && publishProblems(place, city(place.cityId)).length) throw new ApiError('place_incomplete', 'invalid');
      const next = { ...place, updatedAt: today.toISOString().slice(0, 10) };
      const all = places();
      store.write('places', all.some((p) => p.id === place.id) ? all.map((p) => (p.id === place.id ? next : p)) : [...all, next]);
      return clone(withReports(next));
    },
    async setStatus(id, status: PlaceStatus) {
      await wait(latency);
      const all = places();
      const found = all.find((p) => p.id === id);
      if (!found) throw new ApiError('not_found', 'not_found');
      if (status === 'published' && publishProblems(found, city(found.cityId)).length) throw new ApiError('place_incomplete', 'invalid');
      const next = { ...found, status };
      store.write('places', all.map((p) => (p.id === id ? next : p)));
      return clone(withReports(next));
    },
    async getOverview(cityId): Promise<AdminOverview> {
      await wait(latency);
      const ps = places().filter((p) => p.cityId === cityId);
      return {
        staleCount: ps.filter((p) => p.status !== 'hidden' && isStalePlace(p)).length,
        reportCount: ps.reduce((n, p) => n + openReportCount(p.id), 0),
        draftCount: ps.filter((p) => p.status === 'draft').length,
        periodDays: 30,
        metrics: { registeredUsers: null, activeUsers: null, tripsCreated: null, completionRate: null, returnRate: null }
      };
    },
    async listReports(status) {
      await wait(latency);
      const wanted = status === 'open' ? ['new', 'in_review', 'reopened'] : [status];
      return clone(reports().filter((r) => wanted.includes(r.status)));
    },
    async updateReport(id, status, note) {
      await wait(latency);
      if ((status === 'resolved' || status === 'rejected') && !note?.trim()) throw new ApiError('note_required', 'invalid');
      const all = reports();
      const found = all.find((r) => r.id === id);
      if (!found) throw new ApiError('not_found', 'not_found');
      const next = { ...found, status, resolutionNote: note?.trim() || found.resolutionNote };
      store.write('reports', all.map((r) => (r.id === id ? next : r)));
      return next;
    }
  };
}

export { CITIES };
