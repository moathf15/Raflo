import { publishProblems, STALE_DAYS, type Place } from '@riflo/core';
import { z } from 'zod';
import { audit, type Module } from '../context';
import type { Db } from '../db/client';
import { HttpError, notFound } from '../lib/http';
import { PLACE_COLUMNS, toPlace, type PlaceRow } from '../lib/mappers';
import { PlaceInput, PlaceStatus } from '../lib/schemas';

const FUNNEL = ['plan_started', 'plan_step_completed', 'plan_ready', 'trip_saved'] as const;
const RETURN_WINDOW_DAYS = 90;
const OPEN_REPORT = ['new', 'in_review', 'reopened'];
const slug = (s: string) => `place-${Date.now().toString(36)}-${Math.abs([...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)).toString(36)}`;

async function placeById(db: Db, id: string): Promise<Place | null> {
  const [row] = await db.query<PlaceRow>(`SELECT ${PLACE_COLUMNS} FROM places p WHERE p.id = $1`, [id]);
  return row ? toPlace(row) : null;
}
async function cityOf(db: Db, cityId: string) {
  const [c] = await db.query<{ lat: number; lng: number }>('SELECT lat, lng FROM cities WHERE id = $1', [cityId]);
  if (!c) throw new HttpError(400, 'city_unavailable');
  return { location: { lat: Number(c.lat), lng: Number(c.lng) } };
}
/** Publishing needs the minimum data (audit 5.5). */
async function assertPublishable(db: Db, p: Place) {
  const problems = publishProblems(p, await cityOf(db, p.cityId));
  if (problems.length) throw new HttpError(400, 'place_incomplete', 'place_incomplete', { missing: problems });
}
/** Only the fields that changed, as { field: [before, after] }: the history of prices and hours. */
function diff(before: Place | null, after: Place): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const k of ['name', 'summary', 'category', 'location', 'visitMinutes', 'costPerPerson', 'openingHours', 'hours', 'source', 'verifiedAt', 'bestTime', 'etiquette', 'status'] as const) {
    const a = before?.[k] ?? null;
    const b = after[k] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = [a, b];
  }
  return out;
}

/**
 * Every admin change and its audit row are written in one transaction (audit 6.4):
 * if the audit write fails, the change is rolled back.
 */
export const adminModule: Module = (app, { db, sessions }) => {
  const staff = (req: Parameters<typeof sessions.role>[0]) => sessions.role(req, 'editor', 'admin');

  // ---- Content ----------------------------------------------------------
  app.get('/v1/admin/cities/:cityId/places', async (req) => {
    await staff(req);
    const rows = await db.query<PlaceRow>(`SELECT ${PLACE_COLUMNS} FROM places p WHERE p.city_id = $1 ORDER BY p.updated_at DESC LIMIT 1000`, [(req.params as { cityId: string }).cityId]);
    return rows.map(toPlace);
  });

  app.post('/v1/admin/places', async (req, reply) => {
    const u = await staff(req);
    const p = PlaceInput.parse(req.body);
    await cityOf(db, p.cityId);
    const id = p.id ?? slug(p.name);
    const created = await db.tx(async (t) => {
      const [row] = await t.query<{ id: string }>(
        `INSERT INTO places (id, city_id, name_ar, summary_ar, category, lat, lng, visit_minutes, cost_per_person, opening_hours, open_minute, close_minute, closed_weekdays, source, verified_at, best_time, etiquette, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'draft',$18) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, p.cityId, p.name, p.summary, p.category, p.location.lat, p.location.lng, p.visitMinutes, p.costPerPerson, p.openingHours, p.hours?.open ?? null, p.hours?.close ?? null, p.hours?.closedOn ?? [], p.source, p.verifiedAt, p.bestTime, p.etiquette, u.id]
      );
      if (!row) throw new HttpError(409, 'id_taken');
      const place = (await placeById(t, id))!;
      await audit(t, u.id, 'create', 'place', id, diff(null, place));
      return place;
    });
    return reply.status(201).send(created);
  });

  app.put('/v1/admin/places/:id', async (req) => {
    const u = await staff(req);
    const { id } = req.params as { id: string };
    const p = PlaceInput.parse(req.body);
    return db.tx(async (t) => {
      const before = await placeById(t, id);
      if (!before) throw notFound();
      await t.query(
        `UPDATE places SET city_id=$2, name_ar=$3, summary_ar=$4, category=$5, lat=$6, lng=$7, visit_minutes=$8, cost_per_person=$9, opening_hours=$10,
           open_minute=$11, close_minute=$12, source=$13, verified_at=$14, best_time=$15, etiquette=$16, closed_weekdays=$17, updated_at=now()
         WHERE id = $1`,
        [id, p.cityId, p.name, p.summary, p.category, p.location.lat, p.location.lng, p.visitMinutes, p.costPerPerson, p.openingHours, p.hours?.open ?? null, p.hours?.close ?? null, p.source, p.verifiedAt, p.bestTime, p.etiquette, p.hours?.closedOn ?? []]
      );
      const after = (await placeById(t, id))!;
      // A published place can't be edited into an incomplete one.
      if (after.status === 'published') await assertPublishable(t, after);
      await audit(t, u.id, 'update', 'place', id, diff(before, after));
      return after;
    });
  });

  /** Publishing no longer closes reports: each report is handled on its own (audit 5.5). */
  app.patch('/v1/admin/places/:id/status', async (req) => {
    const u = await staff(req);
    const { id } = req.params as { id: string };
    const { status } = z.object({ status: PlaceStatus }).parse(req.body);
    return db.tx(async (t) => {
      const before = await placeById(t, id);
      if (!before) throw notFound();
      if (status === 'published') await assertPublishable(t, before);
      await t.query('UPDATE places SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
      const after = (await placeById(t, id))!;
      await audit(t, u.id, 'set_status', 'place', id, diff(before, after));
      return after;
    });
  });

  // ---- Reports: new → in_review → resolved / rejected, may be reopened -----
  app.get('/v1/admin/reports', async (req) => {
    await staff(req);
    const { status } = z.object({ status: z.enum(['open', 'new', 'in_review', 'resolved', 'rejected', 'reopened']).default('open') }).parse(req.query);
    const statuses = status === 'open' ? OPEN_REPORT : [status];
    return db.query(
      `SELECT r.id, r.place_id AS "placeId", p.name_ar AS "placeName", r.kind, r.message, r.status, r.resolution_note AS "resolutionNote", r.created_at AS "createdAt"
       FROM reports r JOIN places p ON p.id = r.place_id WHERE r.status = ANY($1) ORDER BY r.created_at DESC LIMIT 200`,
      [statuses]
    );
  });

  app.patch('/v1/admin/reports/:id', async (req) => {
    const u = await staff(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({ status: z.enum(['in_review', 'resolved', 'rejected', 'reopened']), note: z.string().trim().max(1000).optional() })
      .refine((b) => !['resolved', 'rejected'].includes(b.status) || !!b.note, { message: 'a note is required to resolve or reject', path: ['note'] })
      .parse(req.body);
    return db.tx(async (t) => {
      const closing = body.status === 'resolved' || body.status === 'rejected';
      const rows = await t.query<{ id: string; place_id: string; kind: string; message: string; status: string; resolution_note: string | null; created_at: Date; place_name: string }>(
        `UPDATE reports r SET status = $2, resolution_note = coalesce($3, resolution_note), updated_at = now(),
           resolved_by = CASE WHEN $4 THEN $5::uuid ELSE NULL END, resolved_at = CASE WHEN $4 THEN now() ELSE NULL END
         FROM places p WHERE r.id = $1 AND p.id = r.place_id
         RETURNING r.id, r.place_id, r.kind, r.message, r.status, r.resolution_note, r.created_at, p.name_ar AS place_name`,
        [id, body.status, body.note ?? null, closing, u.id]
      );
      if (!rows.length) throw notFound();
      await audit(t, u.id, 'set_status', 'report', id, { status: body.status, note: body.note ?? null });
      const r = rows[0];
      return { id: r.id, placeId: r.place_id, placeName: r.place_name, kind: r.kind, message: r.message, status: r.status, resolutionNote: r.resolution_note, createdAt: r.created_at };
    });
  });

  // ---- Overview: every metric has a precise definition (audit 5.7) --------
  app.get('/v1/admin/overview', async (req) => {
    await staff(req);
    const q = z.object({ cityId: z.string().default('madinah'), days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    const [content] = await db.query<{ stale: number; drafts: number; reports: number }>(
      `SELECT
         count(*) FILTER (WHERE status <> 'hidden' AND updated_at < now() - make_interval(days => $2))::int AS stale,
         count(*) FILTER (WHERE status = 'draft')::int AS drafts,
         (SELECT count(*)::int FROM reports r JOIN places p2 ON p2.id = r.place_id WHERE r.status = ANY($3) AND p2.city_id = $1) AS reports
       FROM places WHERE city_id = $1`,
      [q.cityId, STALE_DAYS, OPEN_REPORT]
    );
    const [m] = await db.query<{ registered: number; active: number; trips: number; eligible: number; returned: number }>(
      `WITH firsts AS (SELECT user_id, min(created_at) AS first_at FROM trips GROUP BY user_id)
       SELECT (SELECT count(*)::int FROM users WHERE role = 'user') AS registered,
              (SELECT count(DISTINCT user_id)::int FROM (
                 SELECT user_id FROM events WHERE user_id IS NOT NULL AND created_at > now() - make_interval(days => $2)
                 UNION SELECT user_id FROM trips WHERE created_at > now() - make_interval(days => $2)
                 UNION SELECT user_id FROM visits WHERE created_at > now() - make_interval(days => $2)) a) AS active,
              (SELECT count(*)::int FROM trips WHERE city_id = $1 AND created_at > now() - make_interval(days => $2)) AS trips,
              (SELECT count(*)::int FROM firsts WHERE first_at < now() - make_interval(days => $3)) AS eligible,
              (SELECT count(*)::int FROM firsts f WHERE f.first_at < now() - make_interval(days => $3)
                 AND EXISTS (SELECT 1 FROM trips t WHERE t.user_id = f.user_id AND t.created_at > f.first_at AND t.created_at <= f.first_at + make_interval(days => $3))) AS returned`,
      [q.cityId, q.days, RETURN_WINDOW_DAYS]
    );
    // Funnel: distinct planning sessions reaching each step, so steps of the same attempt line up.
    const funnelRows = await db.query<{ name: string; n: number }>(
      `SELECT name, count(DISTINCT session_id)::int AS n FROM events
       WHERE name = ANY($1) AND session_id IS NOT NULL AND created_at > now() - make_interval(days => $2) GROUP BY name`,
      [FUNNEL as unknown as string[], q.days]
    );
    const count = (name: string) => funnelRows.find((r) => r.name === name)?.n ?? 0;
    const [completion] = await db.query<{ started: number; ready: number }>(
      `SELECT count(DISTINCT session_id) FILTER (WHERE name = 'plan_started')::int AS started,
              count(DISTINCT session_id) FILTER (WHERE name = 'plan_ready' AND session_id IN (SELECT session_id FROM events WHERE name = 'plan_started'))::int AS ready
       FROM events WHERE session_id IS NOT NULL AND created_at > now() - make_interval(days => $1)`,
      [q.days]
    );
    const topPlaces = await db.query<{ placeId: string; name: string; trips: number }>(
      `SELECT s.place_id AS "placeId", p.name_ar AS name, count(DISTINCT s.trip_id)::int AS trips
       FROM trip_stops s JOIN trips t ON t.id = s.trip_id JOIN places p ON p.id = s.place_id
       WHERE t.city_id = $1 AND t.created_at > now() - make_interval(days => $2)
       GROUP BY s.place_id, p.name_ar ORDER BY trips DESC, name LIMIT 5`,
      [q.cityId, q.days]
    );
    return {
      staleCount: content.stale,
      reportCount: content.reports,
      draftCount: content.drafts,
      periodDays: q.days,
      metrics: {
        registeredUsers: m.registered,
        activeUsers: m.active,
        tripsCreated: m.trips,
        completionRate: completion.started ? completion.ready / completion.started : null,
        returnRate: m.eligible ? m.returned / m.eligible : null
      },
      funnel: FUNNEL.map((name) => ({ step: name, count: count(name) })),
      topPlaces
    };
  });

  app.get('/v1/admin/insights', async (req) => {
    await staff(req);
    const { cityId } = z.object({ cityId: z.string().default('madinah') }).parse(req.query);
    const topPlaces = await db.query(
      `SELECT s.place_id AS "placeId", p.name_ar AS name, count(DISTINCT s.trip_id)::int AS trips
       FROM trip_stops s JOIN trips t ON t.id = s.trip_id JOIN places p ON p.id = s.place_id
       WHERE t.city_id = $1 GROUP BY s.place_id, p.name_ar ORDER BY trips DESC LIMIT 10`,
      [cityId]
    );
    const topInterests = await db.query(`SELECT i AS interest, count(*)::int AS trips FROM trips, unnest(interests) AS i WHERE city_id = $1 GROUP BY i ORDER BY trips DESC`, [cityId]);
    const trips = await db.query(`SELECT status, count(*)::int AS n FROM trips WHERE city_id = $1 GROUP BY status`, [cityId]);
    return { topPlaces, topInterests, trips };
  });

  // ---- Users (admin only) -------------------------------------------------
  app.get('/v1/admin/users', async (req) => {
    await sessions.role(req, 'admin');
    const { q } = z.object({ q: z.string().max(100).optional() }).parse(req.query);
    return db.query(
      `SELECT u.id, u.email, u.display_name AS "displayName", u.role, u.status, u.created_at AS "createdAt", u.last_seen_at AS "lastSeenAt",
              (SELECT count(*)::int FROM trips t WHERE t.user_id = u.id) AS trips,
              (SELECT count(*)::int FROM visits v WHERE v.user_id = u.id) AS visits
       FROM users u WHERE ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%' OR u.display_name ILIKE '%' || $1 || '%')
       ORDER BY u.created_at DESC LIMIT 200`,
      [q ?? null]
    );
  });

  /**
   * Admin only. Nobody changes their own role or status; the last active admin can't be removed
   * (enforced by a database trigger, answered as 409 last_admin). Suspension ends all sessions now.
   */
  app.patch('/v1/admin/users/:id', async (req) => {
    const admin = await sessions.role(req, 'admin');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ role: z.enum(['user', 'editor', 'admin']).optional(), status: z.enum(['active', 'suspended']).optional() }).refine((b) => b.role || b.status).parse(req.body);
    if (id === admin.id) throw new HttpError(400, 'cannot_change_self');
    return db.tx(async (t) => {
      const [before] = await t.query<{ role: string; status: string }>('SELECT role, status FROM users WHERE id = $1', [id]);
      if (!before) throw notFound();
      await t.query('UPDATE users SET role = coalesce($2, role), status = coalesce($3, status) WHERE id = $1', [id, body.role ?? null, body.status ?? null]);
      if (body.status === 'suspended') await sessions.revokeAll(t, id);
      await audit(t, admin.id, 'update', 'user', id, { before, after: body });
      return { id, ...body };
    });
  });
};
