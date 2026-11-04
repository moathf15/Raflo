import type { Place } from '@riflo/core';
import { z } from 'zod';
import type { Module } from '../context';
import type { Db } from '../db/client';
import { notFound } from '../lib/http';
import { PLACE_COLUMNS, toPlace, type PlaceRow } from '../lib/mappers';
import { category } from '../lib/schemas';

/** Published places of a city (what users and the planner may see). */
export async function publishedPlaces(db: Db, cityId: string): Promise<Place[]> {
  const rows = await db.query<PlaceRow>(`SELECT ${PLACE_COLUMNS} FROM places p WHERE p.city_id = $1 AND p.status = 'published' ORDER BY p.name_ar`, [cityId]);
  return rows.map(toPlace);
}

export const placesModule: Module = (app, { db, sessions }) => {
  app.get('/v1/cities', async () => {
    const rows = await db.query<{ id: string; name_ar: string; lat: number; lng: number; timezone: string }>('SELECT id, name_ar, lat, lng, timezone FROM cities WHERE active ORDER BY name_ar');
    return rows.map((c) => ({ id: c.id, name: c.name_ar, location: { lat: c.lat, lng: c.lng }, timezone: c.timezone }));
  });

  app.get('/v1/cities/:cityId/places', async (req) => {
    const { cityId } = req.params as { cityId: string };
    const q = z.object({ category: category.optional(), q: z.string().max(80).optional() }).parse(req.query);
    let places = await publishedPlaces(db, cityId);
    if (q.category) places = places.filter((p) => p.category === q.category);
    if (q.q) places = places.filter((p) => p.name.includes(q.q!) || p.summary.includes(q.q!));
    return places;
  });

  app.get('/v1/places/:id', async (req) => {
    const { id } = req.params as { id: string };
    const [row] = await db.query<PlaceRow>(`SELECT ${PLACE_COLUMNS} FROM places p WHERE p.id = $1 AND p.status = 'published'`, [id]);
    if (!row) throw notFound();
    const photos = await db.query<{ url: string; alt_ar: string; credit: string | null }>('SELECT url, alt_ar, credit FROM place_photos WHERE place_id = $1 ORDER BY position', [id]);
    return { ...toPlace(row), photos: photos.map((p) => ({ url: p.url, alt: p.alt_ar, credit: p.credit })) };
  });

  /** Visitors flag wrong or outdated information. Guests may report too. */
  app.post('/v1/places/:id/reports', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = await sessions.optional(req);
    const body = z.object({ kind: z.enum(['wrong_info', 'closed', 'suggestion', 'complaint']).default('wrong_info'), message: z.string().trim().max(1000).default('') }).parse(req.body ?? {});
    const [exists] = await db.query(`SELECT 1 FROM places WHERE id = $1 AND status = 'published'`, [id]);
    if (!exists) throw notFound();
    await db.query('INSERT INTO reports (place_id, user_id, kind, message) VALUES ($1, $2, $3, $4)', [id, user?.id ?? null, body.kind, body.message]);
    return reply.status(201).send({ received: true });
  });
};
