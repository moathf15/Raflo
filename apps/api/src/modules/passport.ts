import { todayIn } from '@riflo/core';
import { z } from 'zod';
import { withQuota, QUOTAS, track, type Module } from '../context';
import { HttpError, notFound } from '../lib/http';
import { toVisit, VISIT_COLUMNS, type VisitRow } from '../lib/mappers';
import { ClientEvent, isoDate, placeId } from '../lib/schemas';
import { wishListOf } from '../lib/users';

/** How far back a visit may be logged. */
const MAX_VISIT_AGE_DAYS = 365;

export const passportModule: Module = (app, { db, sessions }) => {
  /** Everything the Passport screen needs in one call. */
  app.get('/v1/passport', async (req) => {
    const u = await sessions.required(req);
    const [user] = await db.query<{ display_name: string | null }>('SELECT display_name FROM users WHERE id = $1', [u.id]);
    const visits = await db.query<VisitRow>(`SELECT ${VISIT_COLUMNS} FROM visits WHERE user_id = $1 ORDER BY visited_on, created_at`, [u.id]);
    const wishList = await wishListOf(db, u.id);
    const [prefs] = await db.query<{ preferences: unknown }>('SELECT preferences FROM user_preferences WHERE user_id = $1', [u.id]);
    const [stats] = await db.query<{ trips: number; days: number }>(`SELECT count(*)::int AS trips, coalesce(sum(end_date - start_date + 1), 0)::int AS days FROM trips WHERE user_id = $1`, [u.id]);
    return {
      displayName: user.display_name,
      visits: visits.map(toVisit),
      wishList,
      lastPreferences: prefs?.preferences ?? null,
      // Distinct places and total visits are separate numbers (audit 5.6).
      stats: { trips: stats.trips, placesVisited: new Set(visits.map((v) => v.place_id)).size, visits: visits.length, travelDays: stats.days }
    };
  });

  /**
   * Log a visit (a stamp). Self-reported, never proof of presence (audit 3.4):
   * - the date is a real calendar date, not in the future in the city's time zone, at most a year back;
   * - with a tripId, the trip is the caller's, the place is in it and the date is within the trip;
   * - one visit per place per day; at most 50 visits logged per day.
   */
  app.post('/v1/visits', { config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = await sessions.required(req);
    const body = z
      .object({ placeId, tripId: z.string().uuid().nullable().default(null), date: isoDate, rating: z.number().int().min(1).max(5).nullable().default(null), note: z.string().trim().max(1000).default('') })
      .parse(req.body);
    const [place] = await db.query<{ timezone: string }>(`SELECT c.timezone FROM places p JOIN cities c ON c.id = p.city_id WHERE p.id = $1 AND p.status = 'published'`, [body.placeId]);
    if (!place) throw notFound();
    const today = todayIn(place.timezone);
    if (body.date > today) throw new HttpError(400, 'visit_in_future');
    const [age] = await db.query<{ days: number }>('SELECT ($1::date - $2::date)::int AS days', [today, body.date]);
    if (age.days > MAX_VISIT_AGE_DAYS) throw new HttpError(400, 'visit_too_old');
    if (body.tripId) {
      const [trip] = await db.query<{ start_date: string; end_date: string; has_place: boolean }>(
        `SELECT start_date::text, end_date::text, EXISTS (SELECT 1 FROM trip_stops s WHERE s.trip_id = t.id AND s.place_id = $3) AS has_place
         FROM trips t WHERE t.id = $1 AND t.user_id = $2`,
        [body.tripId, u.id, body.placeId]
      );
      if (!trip) throw notFound();
      if (!trip.has_place) throw new HttpError(400, 'place_not_in_trip');
      if (body.date < trip.start_date || body.date > trip.end_date) throw new HttpError(400, 'date_outside_trip');
    }
    const quota = { sql: `SELECT count(*)::int AS n FROM visits WHERE user_id = $1 AND created_at > now() - interval '24 hours'`, params: [u.id], max: QUOTAS.visitsPerDay, code: 'visit_quota_daily' };
    const visit = await withQuota(db, `visits:${u.id}`, [quota], async (t) => {
      const rows = await t.query<VisitRow>(
        `INSERT INTO visits (user_id, place_id, trip_id, visited_on, rating, note) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, place_id, visited_on) DO NOTHING RETURNING ${VISIT_COLUMNS}`,
        [u.id, body.placeId, body.tripId, body.date, body.rating, body.note]
      );
      if (!rows.length) throw new HttpError(409, 'already_logged');
      await t.query('DELETE FROM wishlist WHERE user_id = $1 AND place_id = $2', [u.id, body.placeId]);
      return rows[0];
    });
    await track(db, 'visit_logged', u.id, { placeId: body.placeId });
    return reply.status(201).send(toVisit(visit));
  });

  /** Edit the rating or note of one of the caller's own visits. */
  app.patch('/v1/visits/:id', async (req) => {
    const u = await sessions.required(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ rating: z.number().int().min(1).max(5).nullable(), note: z.string().trim().max(1000) }).parse(req.body);
    const [row] = await db.query<VisitRow>(`UPDATE visits SET rating = $3, note = $4, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING ${VISIT_COLUMNS}`, [id, u.id, body.rating, body.note]);
    if (!row) throw notFound();
    return toVisit(row);
  });

  app.delete('/v1/visits/:id', async (req, reply) => {
    const u = await sessions.required(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const rows = await db.query('DELETE FROM visits WHERE id = $1 AND user_id = $2 RETURNING id', [id, u.id]);
    if (!rows.length) throw notFound();
    return reply.status(204).send();
  });

  app.put('/v1/wishlist/:placeId', async (req) => {
    const u = await sessions.required(req);
    const id = placeId.parse((req.params as { placeId: string }).placeId);
    const [place] = await db.query(`SELECT 1 FROM places WHERE id = $1 AND status = 'published'`, [id]);
    if (!place) throw notFound();
    const quota = { sql: 'SELECT count(*)::int AS n FROM wishlist WHERE user_id = $1 AND place_id <> $2', params: [u.id, id], max: QUOTAS.wishlistTotal, code: 'wishlist_full' };
    await withQuota(db, `wishlist:${u.id}`, [quota], (t) => t.query('INSERT INTO wishlist (user_id, place_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [u.id, id]));
    return { wishList: await wishListOf(db, u.id) };
  });

  app.delete('/v1/wishlist/:placeId', async (req) => {
    const u = await sessions.required(req);
    const id = placeId.parse((req.params as { placeId: string }).placeId);
    await db.query('DELETE FROM wishlist WHERE user_id = $1 AND place_id = $2', [u.id, id]);
    return { wishList: await wishListOf(db, u.id) };
  });

  /**
   * Client funnel events (audit 3.5): only allowlisted names and props, strict types and sizes,
   * 2 KB body cap, and at most 300 events per user or anonymous id per day.
   * Server-side events (plan_ready, trip_saved) are written by the API itself, not accepted from clients.
   */
  app.post('/v1/events', { bodyLimit: 2048, config: { rateLimit: { max: 120, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const user = await sessions.optional(req);
    const body = ClientEvent.parse(req.body);
    const anon = user ? null : body.anonymousId ?? null;
    if (!user && !anon) throw new HttpError(400, 'identity_required');
    const quota = {
      sql: user ? `SELECT count(*)::int AS n FROM events WHERE user_id = $1 AND created_at > now() - interval '24 hours'` : `SELECT count(*)::int AS n FROM events WHERE anonymous_id = $1 AND created_at > now() - interval '24 hours'`,
      params: [user?.id ?? anon],
      max: QUOTAS.eventsPerDay,
      code: 'event_quota_daily'
    };
    await withQuota(db, `events:${user?.id ?? anon}`, [quota], (t) => track(t, body.name, user?.id ?? null, body.props, anon, body.sessionId ?? null));
    return reply.status(202).send({ ok: true });
  });
};
