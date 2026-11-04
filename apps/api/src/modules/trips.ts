import { explainUnscheduled, findDuplicateInDay, generatePlan, prayerTimes, scheduleDay, tripDates, validateDays, type LatLng, type Place, type Trip, type TripPreferences, type UnscheduledPlace } from '@riflo/core';
import { z } from 'zod';
import { withQuota, QUOTAS, track, type Module } from '../context';
import type { Db } from '../db/client';
import { HttpError, notFound } from '../lib/http';
import { wishListOf } from '../lib/users';
import { toTrip, type DayRow, type StopRow, type TripRow } from '../lib/mappers';
import { anonymousId, placeId, Preferences, sessionId, TripInput } from '../lib/schemas';
import { publishedPlaces } from './places';

interface CityRow {
  id: string;
  lat: number;
  lng: number;
  timezone: string;
}

async function activeCity(db: Db, cityId: string) {
  const [c] = await db.query<CityRow>('SELECT id, lat, lng, timezone FROM cities WHERE id = $1 AND active', [cityId]);
  if (!c) throw new HttpError(400, 'city_unavailable');
  const location: LatLng = { lat: Number(c.lat), lng: Number(c.lng) };
  // Real prayer times for each date, in the city's time zone (audit 5.2).
  return { ...c, prayersOn: (date: string) => prayerTimes(location, c.timezone, date) };
}

/** Published places and prayer times of one city, loaded once per request however many trips use it. */
interface CityData {
  places: Map<string, Place>;
  city: Awaited<ReturnType<typeof activeCity>> | null;
}
function cityLoader(db: Db) {
  const cache = new Map<string, Promise<CityData>>();
  return (cityId: string) => {
    if (!cache.has(cityId))
      cache.set(cityId, (async () => ({ places: new Map((await publishedPlaces(db, cityId)).map((p) => [p.id, p])), city: await activeCity(db, cityId).catch(() => null) }))());
    return cache.get(cityId)!;
  };
}

/**
 * The "could not fit" list, always computed from the saved selection and the actual days (never stored, never
 * taken from the client): chosen places not in any day, with the day they fit on or the reason they cannot;
 * chosen places that are no longer published are listed as unavailable.
 */
function leftOut({ places: byId, city }: CityData, prefs: TripPreferences, days: string[][], selected: string[], breakMinutes: number): UnscheduledPlace[] {
  const scheduled = new Set(days.flat());
  const pending = selected.filter((id) => !scheduled.has(id));
  if (!pending.length) return [];
  const explained = city
    ? new Map(explainUnscheduled(pending.filter((id) => byId.has(id)).map((id) => byId.get(id)!), days, tripDates(prefs.startDate, prefs.endDate), byId, prefs, city.prayersOn, breakMinutes).map((u) => [u.placeId, u]))
    : new Map<string, UnscheduledPlace>();
  return pending.map((id) => explained.get(id) ?? { placeId: id, reason: 'unavailable' as const });
}

const groupBy = <T extends { trip_id: string }>(rows: T[]) => {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(r.trip_id, [...(out.get(r.trip_id) ?? []), r]);
  return out;
};

/**
 * A user's trips with their days, stops, selection and left-out list. One query per table for all trips and one
 * load per city (audit S4: it was about six queries plus a city reload per trip).
 */
async function loadTrips(db: Db, userId: string, breakMinutes: number, only?: string): Promise<Trip[]> {
  const trips = only
    ? await db.query<TripRow>('SELECT * FROM trips WHERE id = $1 AND user_id = $2', [only, userId])
    : await db.query<TripRow>('SELECT * FROM trips WHERE user_id = $1 ORDER BY start_date LIMIT $2', [userId, QUOTAS.tripsTotal]);
  if (!trips.length) return [];
  const ids = trips.map((t) => t.id);
  const days = groupBy(await db.query<DayRow & { trip_id: string }>('SELECT trip_id, day_index, date, breaks FROM trip_days WHERE trip_id = ANY($1::uuid[])', [ids]));
  const stops = groupBy(await db.query<StopRow & { trip_id: string }>('SELECT trip_id, id, day_index, position, place_id, start_minute, travel_minutes, distance_km, warning FROM trip_stops WHERE trip_id = ANY($1::uuid[])', [ids]));
  const chosen = groupBy(await db.query<{ trip_id: string; place_id: string }>('SELECT trip_id, place_id FROM trip_places WHERE trip_id = ANY($1::uuid[]) ORDER BY added_at, place_id', [ids]));
  const cityData = cityLoader(db);
  return Promise.all(
    trips.map(async (t) => {
      const trip = toTrip(t, days.get(t.id) ?? [], stops.get(t.id) ?? []);
      const selected = (chosen.get(t.id) ?? []).map((r) => r.place_id);
      const unscheduled = leftOut(await cityData(t.city_id), trip.preferences, trip.days.map((d) => d.stops.map((s) => s.placeId)), selected, breakMinutes);
      return { ...trip, selected, unscheduled };
    })
  );
}

const loadTrip = async (db: Db, id: string, userId: string, breakMinutes: number): Promise<Trip | null> => (await loadTrips(db, userId, breakMinutes, id))[0] ?? null;

/** Remember a user's last preferences, minus the dates, so the next trip starts pre-filled. */
async function rememberPreferences(db: Db, userId: string, prefs: TripPreferences) {
  const { startDate: _s, endDate: _e, firstDayStart: _f, lastDayEnd: _l, ...remembered } = prefs;
  await db.query(`INSERT INTO user_preferences (user_id, preferences) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET preferences = EXCLUDED.preferences, updated_at = now()`, [userId, JSON.stringify(remembered)]);
}

/** Add places to a trip's selection (no-op for places already chosen). */
async function choose(db: Db, tripId: string, placeIds: string[], origin: 'interest' | 'wishlist' | 'manual') {
  for (const id of placeIds) await db.query('INSERT INTO trip_places (trip_id, place_id, origin) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [tripId, id, origin]);
}
const MAX_SELECTED = 100;

/**
 * Server-side scheduling: the client sends place order, the server owns times, travel and breaks.
 * Every day is laid out again and must fit (manual scheduling ticket): no visit outside its opening hours or on
 * a closed weekday, nothing past the end of the day. Otherwise 400 day_not_executable with the problems.
 */
async function buildDays(db: Db, prefs: TripPreferences, days: { placeIds: string[] }[], breakMinutes: number) {
  const dates = tripDates(prefs.startDate, prefs.endDate);
  if (days.length !== dates.length) throw new HttpError(400, 'days_mismatch', `expected ${dates.length} days`);
  const dup = findDuplicateInDay(days);
  if (dup) throw new HttpError(400, 'duplicate_place', dup);
  const city = await activeCity(db, prefs.cityId);
  const places = await publishedPlaces(db, prefs.cityId);
  const byId = new Map(places.map((p) => [p.id, p]));
  const unknown = days.flatMap((d) => d.placeIds).filter((id) => !byId.has(id));
  if (unknown.length) throw new HttpError(400, 'place_unavailable', unknown.join(','));
  const ids = days.map((d) => d.placeIds);
  const problems = validateDays(ids, dates, byId, prefs, city.prayersOn, breakMinutes);
  if (problems.length) throw new HttpError(400, 'day_not_executable', 'a day does not fit its time or opening hours', { problems });
  return { days: dates.map((date, i) => scheduleDay(date, ids[i], byId, prefs, city.prayersOn(date), breakMinutes)), ids, places };
}

async function writeTrip(db: Db, tripId: string, days: ReturnType<typeof scheduleDay>[]) {
  await db.query('DELETE FROM trip_days WHERE trip_id = $1', [tripId]);
  for (const [i, d] of days.entries()) {
    await db.query('INSERT INTO trip_days (trip_id, day_index, date, breaks) VALUES ($1, $2, $3, $4)', [tripId, i, d.date, JSON.stringify(d.breaks)]);
    for (const [pos, s] of d.stops.entries()) {
      await db.query('INSERT INTO trip_stops (trip_id, day_index, position, place_id, start_minute, travel_minutes, distance_km, warning) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [tripId, i, pos, s.placeId, s.start, s.travelFromPrevious, s.distanceFromPreviousKm, s.warning ?? null]);
    }
  }
}

export const tripsModule: Module = (app, { db, sessions, cfg }) => {
  const breakMinutes = cfg.PRAYER_BREAK_MINUTES;

  /** Generate a plan. Guests allowed; signed-in users get their wish list ranked in and preferences remembered. */
  app.post('/v1/plans', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req) => {
    const user = await sessions.optional(req);
    const body = z.object({ preferences: Preferences, title: z.string().trim().min(1).max(120), anonymousId: anonymousId.optional(), sessionId: sessionId.optional() }).parse(req.body);
    const prefs = body.preferences;
    const city = await activeCity(db, prefs.cityId);
    const places = await publishedPlaces(db, prefs.cityId);
    if (!places.length) throw new HttpError(400, 'city_unavailable');
    let wishList: string[] = [];
    if (user) {
      wishList = await wishListOf(db, user.id);
      await rememberPreferences(db, user.id, prefs);
    }
    const plan = generatePlan({ preferences: prefs, places, wishList, prayerTimes: city.prayersOn, breakMinutes, title: body.title });
    await track(db, 'plan_ready', user?.id ?? null, { cityId: prefs.cityId, days: plan.days.length }, body.anonymousId ?? null, body.sessionId ?? null);
    return plan;
  });

  app.get('/v1/trips', async (req) => {
    const u = await sessions.required(req);
    return loadTrips(db, u.id, breakMinutes);
  });

  app.get('/v1/trips/:id', async (req) => {
    const u = await sessions.required(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const trip = await loadTrip(db, id, u.id, breakMinutes);
    if (!trip) throw notFound();
    return trip;
  });

  app.post('/v1/trips', { config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = await sessions.required(req);
    const input = TripInput.parse(req.body);
    // reusedFrom must be one of the caller's own trips (audit 5.4). 404, so other users' ids aren't confirmed.
    if (input.reusedFrom) {
      const [own] = await db.query('SELECT 1 FROM trips WHERE id = $1 AND user_id = $2', [input.reusedFrom, u.id]);
      if (!own) throw notFound();
    }
    const { days, ids, places } = await buildDays(db, input.preferences, input.days, breakMinutes);
    const p = input.preferences;
    // The trip's selection at creation: what the plan was built from (interests, wish list), what is scheduled,
    // and left-out places the client lists if they are published in this city — minus explicit exclusions.
    const published = new Set(places.map((x) => x.id));
    const scheduled = new Set(ids.flat());
    const excluded = new Set((input.excluded ?? []).filter((id) => !scheduled.has(id)));
    const wish = new Set(await wishListOf(db, u.id));
    const keep = (id: string) => published.has(id) && !excluded.has(id);
    const fromInterests = places.filter((x) => p.interests.includes(x.category) && keep(x.id)).map((x) => x.id);
    const fromWish = [...wish].filter(keep);
    const manual = [...scheduled, ...(input.unscheduled ?? [])].filter(keep);
    // Quota check and insert are atomic per user (review 3), so parallel saves cannot overshoot the limits.
    const quotas = [
      { sql: `SELECT count(*)::int AS n FROM trips WHERE user_id = $1 AND created_at > now() - interval '24 hours'`, params: [u.id], max: QUOTAS.tripsPerDay, code: 'trip_quota_daily' },
      { sql: `SELECT count(*)::int AS n FROM trips WHERE user_id = $1`, params: [u.id], max: QUOTAS.tripsTotal, code: 'trip_quota_total' }
    ];
    const id = await withQuota(db, `trips:${u.id}`, quotas, async (t) => {
      const [row] = await t.query<{ id: string }>(
        `INSERT INTO trips (user_id, city_id, title, start_date, end_date, travellers, trip_type, budget_total, interests, around_prayer, relaxed_pace, reused_from, first_day_start, last_day_end)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [u.id, p.cityId, input.title, p.startDate, p.endDate, p.travellers, p.tripType, p.budgetTotal, p.interests, p.aroundPrayerTimes, p.relaxedPace, input.reusedFrom ?? null, p.firstDayStart ?? null, p.lastDayEnd ?? null]
      );
      await writeTrip(t, row.id, days);
      await choose(t, row.id, fromInterests, 'interest');
      await choose(t, row.id, fromWish, 'wishlist');
      await choose(t, row.id, manual, 'manual');
      // Saving a trip also remembers its preferences, so the next trip starts pre-filled — including
      // for a guest who planned first and signed in only to save.
      await rememberPreferences(t, u.id, p);
      return row.id;
    });
    await track(db, 'trip_saved', u.id, { cityId: p.cityId, tripId: id, reused: !!input.reusedFrom }, null, input.sessionId ?? null);
    if (input.reusedFrom) await track(db, 'plan_reused', u.id, { cityId: p.cityId, tripId: id }, null, input.sessionId ?? null);
    return reply.status(201).send(await loadTrip(db, id, u.id, breakMinutes));
  });

  app.put('/v1/trips/:id', { config: { rateLimit: { max: 120, timeWindow: '1 hour' } } }, async (req) => {
    const u = await sessions.required(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const input = TripInput.omit({ reusedFrom: true }).parse(req.body);
    const p = input.preferences;
    const [own] = await db.query('SELECT 1 FROM trips WHERE id = $1 AND user_id = $2', [id, u.id]);
    if (!own) throw notFound();
    const { days, ids } = await buildDays(db, p, input.days, breakMinutes);
    await db.tx(async (t) => {
      // Lock the trip row first, so two saves of the same trip run one after the other instead of both
      // deleting and re-inserting its days (audit S9: unique-key error → 500).
      const [locked] = await t.query('SELECT 1 FROM trips WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, u.id]);
      if (!locked) throw notFound();
      const updated = await t.query(
        `UPDATE trips SET title=$3, start_date=$4, end_date=$5, travellers=$6, trip_type=$7, budget_total=$8, interests=$9, around_prayer=$10, relaxed_pace=$11,
           first_day_start=$12, last_day_end=$13, updated_at=now()
         WHERE id = $1 AND user_id = $2 RETURNING id`,
        [id, u.id, input.title, p.startDate, p.endDate, p.travellers, p.tripType, p.budgetTotal, p.interests, p.aroundPrayerTimes, p.relaxedPace, p.firstDayStart ?? null, p.lastDayEnd ?? null]
      );
      if (!updated.length) throw notFound();
      await writeTrip(t, id, days);
      // Scheduling a place is choosing it. Removing it from a day is not un-choosing it: it stays selected and
      // shows as left out. The client's "unscheduled"/"excluded" fields are ignored here.
      await choose(t, id, ids.flat(), 'manual');
    });
    return loadTrip(db, id, u.id, breakMinutes);
  });

  /** Choose a place for the trip without putting it in a day yet (explicit choice). */
  app.post('/v1/trips/:id/places', { config: { rateLimit: { max: 240, timeWindow: '1 hour' } } }, async (req) => {
    const u = await sessions.required(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { placeId: pid } = z.object({ placeId }).strict().parse(req.body);
    const [trip] = await db.query<{ city_id: string }>('SELECT city_id FROM trips WHERE id = $1 AND user_id = $2', [id, u.id]);
    if (!trip) throw notFound();
    const [place] = await db.query(`SELECT 1 FROM places WHERE id = $1 AND city_id = $2 AND status = 'published'`, [pid, trip.city_id]);
    if (!place) throw new HttpError(400, 'place_unavailable', pid);
    await withQuota(db, `trip-places:${id}`, [{ sql: 'SELECT count(*)::int AS n FROM trip_places WHERE trip_id = $1 AND place_id <> $2', params: [id, pid], max: MAX_SELECTED, code: 'selection_full' }], (t) => choose(t, id, [pid], 'manual'));
    return loadTrip(db, id, u.id, breakMinutes);
  });

  /** Remove a place from the trip (explicit choice). A place still in a day must be taken out of the day first. */
  app.delete('/v1/trips/:id/places/:placeId', async (req) => {
    const u = await sessions.required(req);
    const { id, placeId: pid } = z.object({ id: z.string().uuid(), placeId }).parse(req.params);
    const [trip] = await db.query('SELECT 1 FROM trips WHERE id = $1 AND user_id = $2', [id, u.id]);
    if (!trip) throw notFound();
    const [inDay] = await db.query('SELECT 1 FROM trip_stops WHERE trip_id = $1 AND place_id = $2', [id, pid]);
    if (inDay) throw new HttpError(409, 'place_scheduled', 'remove it from its day first');
    await db.query('DELETE FROM trip_places WHERE trip_id = $1 AND place_id = $2', [id, pid]);
    return loadTrip(db, id, u.id, breakMinutes);
  });

  app.delete('/v1/trips/:id', async (req, reply) => {
    const u = await sessions.required(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const rows = await db.query('DELETE FROM trips WHERE id = $1 AND user_id = $2 RETURNING id', [id, u.id]);
    if (!rows.length) throw notFound();
    return reply.status(204).send();
  });
};
