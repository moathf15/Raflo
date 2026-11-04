import type { AdminOverview, AdminReport, Passport, PassportStats, Place, PlaceStatus, Trip, Visit } from '../types';
import { ApiError, type AdminApi, type ApiErrorCode, type AuthApi, type SessionUser, type UserApi } from './contract';
import { createStore } from './storage';

export interface HttpOptions {
  /** e.g. https://api.riflo.sa (no trailing slash). */
  baseUrl: string;
}

const STATUS_CODE: Record<number, ApiErrorCode> = { 400: 'invalid', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 429: 'rate_limited' };
const store = createStore('riflo.client');
const randomId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, '');

/**
 * The session lives in an HttpOnly cookie set by the API (audit 3.3): page scripts never see it,
 * so a script injection cannot read and steal it. Requests send it with `credentials: 'include'`.
 */
function client({ baseUrl }: HttpOptions) {
  // Only a random, non-identifying id for guest analytics is kept in storage.
  const anonymousId = store.read<string | null>('anon', null) ?? `anon_${randomId()}`;
  store.write('anon', anonymousId);
  let me: SessionUser | null | undefined; // undefined = not checked yet

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(baseUrl + path, {
        method,
        credentials: 'include',
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch {
      throw new ApiError('network', 'network');
    }
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401) me = null; // expired, revoked or suspended: back to guest
      throw new ApiError(data?.error?.code ?? 'error', STATUS_CODE[res.status] ?? 'server');
    }
    return data as T;
  }

  const auth: AuthApi = {
    requiresAccount: true,
    async current() {
      if (me !== undefined) return me;
      me = (await request<{ user: SessionUser | null }>('GET', '/v1/session')).user;
      return me;
    },
    requestCode: (email) => request('POST', '/v1/auth/request-code', { email }),
    async verify(email, code) {
      const r = await request<{ user: SessionUser }>('POST', '/v1/auth/verify', { email, code });
      me = r.user;
      return r.user;
    },
    async signOut() {
      await request('POST', '/v1/auth/logout', {}).catch(() => undefined);
      me = null;
    }
  };

  return { request, auth, anonymousId, signedIn: async () => !!(await auth.current()) };
}

/** The user app against the RIFLO API. Guests get empty trips and passport instead of errors. */
export function createHttpApi(opts: HttpOptions): UserApi {
  const { request, auth, anonymousId, signedIn } = client(opts);
  let sessionId: string | null = null;
  const emptyPassport = (): Passport & { stats: PassportStats } => ({ displayName: null, visits: [], wishList: [], lastPreferences: null, stats: { trips: 0, placesVisited: 0, visits: 0, travelDays: 0 } });
  const passport = async () => ((await signedIn()) ? request<Passport & { stats: PassportStats }>('GET', '/v1/passport') : emptyPassport());
  const toInput = (trip: Trip, reusedFrom?: string) => ({
    title: trip.title,
    preferences: trip.preferences,
    days: trip.days.map((d) => ({ placeIds: d.stops.map((s) => s.placeId) })),
    // Hints for a new trip only (the server ignores them on edits): left-out ids and explicit exclusions.
    ...(trip.saved ? {} : { unscheduled: (trip.unscheduled ?? []).map((u) => u.placeId), excluded: trip.excluded ?? [] }),
    ...(reusedFrom ? { reusedFrom } : {}),
    ...(sessionId ? { sessionId } : {})
  });

  return {
    auth,
    startPlanSession() {
      sessionId = randomId();
    },
    track(name, props = {}) {
      request('POST', '/v1/events', { name, props, anonymousId, ...(sessionId ? { sessionId } : {}) }).catch(() => undefined);
    },
    listPlaces: (cityId) => request('GET', `/v1/cities/${encodeURIComponent(cityId)}/places`),
    async getPlace(id) {
      try {
        return await request<Place>('GET', `/v1/places/${encodeURIComponent(id)}`);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'not_found') return null;
        throw e;
      }
    },
    createPlan: (preferences, title) => request('POST', '/v1/plans', { preferences, title, anonymousId, ...(sessionId ? { sessionId } : {}) }),
    async getTrip(id) {
      if (!(await signedIn())) return null;
      try {
        return await request<Trip>('GET', `/v1/trips/${encodeURIComponent(id)}`);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'not_found') return null;
        throw e;
      }
    },
    listTrips: async () => ((await signedIn()) ? request('GET', '/v1/trips') : []),
    saveTrip: (trip, reusedFrom) => (trip.saved ? request('PUT', `/v1/trips/${encodeURIComponent(trip.id)}`, toInput(trip)) : request('POST', '/v1/trips', toInput(trip, reusedFrom))),
    deleteTrip: (id) => request('DELETE', `/v1/trips/${encodeURIComponent(id)}`),
    removeFromTrip: (tripId, placeId) => request('DELETE', `/v1/trips/${encodeURIComponent(tripId)}/places/${encodeURIComponent(placeId)}`),
    async getPassport() {
      const { stats: _stats, ...p } = await passport();
      return p;
    },
    getPassportStats: async () => (await passport()).stats,
    logVisit: (v) => request<Visit>('POST', '/v1/visits', { placeId: v.placeId, tripId: v.tripId, date: v.date, rating: v.rating, note: v.note }),
    updateVisit: (id, changes) => request<Visit>('PATCH', `/v1/visits/${encodeURIComponent(id)}`, changes),
    deleteVisit: (id) => request('DELETE', `/v1/visits/${encodeURIComponent(id)}`),
    async toggleWish(placeId) {
      const { wishList } = await passport();
      const r = await request<{ wishList: string[] }>(wishList.includes(placeId) ? 'DELETE' : 'PUT', `/v1/wishlist/${encodeURIComponent(placeId)}`);
      return r.wishList;
    },
    reportPlace: (placeId, message) => request('POST', `/v1/places/${encodeURIComponent(placeId)}/reports`, { kind: 'wrong_info', message })
  };
}

export function createHttpAdminApi(opts: HttpOptions): AdminApi {
  const { request, auth } = client(opts);
  const body = (p: Place) => ({ cityId: p.cityId, name: p.name, summary: p.summary, category: p.category, location: p.location, visitMinutes: p.visitMinutes, costPerPerson: p.costPerPerson, openingHours: p.openingHours, hours: p.hours, source: p.source, verifiedAt: p.verifiedAt, bestTime: p.bestTime, etiquette: p.etiquette });
  const status = (id: string, s: PlaceStatus) => request<Place>('PATCH', `/v1/admin/places/${encodeURIComponent(id)}/status`, { status: s });
  return {
    auth,
    listPlaces: (cityId) => request('GET', `/v1/admin/cities/${encodeURIComponent(cityId)}/places`),
    async savePlace(p) {
      const saved = !p.updatedAt ? await request<Place>('POST', '/v1/admin/places', body(p)) : await request<Place>('PUT', `/v1/admin/places/${encodeURIComponent(p.id)}`, body(p));
      return p.status !== saved.status ? status(saved.id, p.status) : saved;
    },
    setStatus: status,
    getOverview: (cityId) => request<AdminOverview>('GET', `/v1/admin/overview?cityId=${encodeURIComponent(cityId)}`),
    listReports: (s) => request<AdminReport[]>('GET', `/v1/admin/reports?status=${encodeURIComponent(s)}`),
    updateReport: (id, s, note) => request<AdminReport>('PATCH', `/v1/admin/reports/${encodeURIComponent(id)}`, { status: s, ...(note ? { note } : {}) })
  };
}
