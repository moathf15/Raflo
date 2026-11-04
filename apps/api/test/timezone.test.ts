/**
 * Dates must not shift with the server's time zone. The API ran on a server in Asia/Riyadh (UTC+3): `pg` turned
 * `date` columns into local-midnight Dates and toISOString() returned the previous day (found 4 Nov 2026).
 * This file runs the whole round trip with the process in Asia/Riyadh and in a UTC−10 zone.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import type { Db } from '../src/db/client';
import { testDb } from './db';
import { migrate } from '../src/db/migrate';
import { seed } from '../src/db/seed';

const originalTz = process.env.TZ;
let app: FastifyInstance;
let db: Db;
let token = '';
const prefs = { cityId: 'madinah', startDate: '2026-12-10', endDate: '2026-12-12', travellers: 2, tripType: 'family', budgetTotal: 2000, interests: ['religious', 'history'], aroundPrayerTimes: true, relaxedPace: false };
async function call(method: string, url: string, body?: unknown) {
  const res = await app.inject({ method: method as 'GET', url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

before(async () => {
  db = await testDb();
  await migrate(db);
  await seed(db);
  app = await buildApp(db, loadConfig({ NODE_ENV: 'test', AUTH_DEV_CODES: 'true', AUTH_RATE_LIMIT: '100000', NATIVE_CLIENTS: 'true' } as NodeJS.ProcessEnv));
  const r = await call('POST', '/v1/auth/request-code', { email: 'tz@example.com' });
  token = (await call('POST', '/v1/auth/native/verify', { email: 'tz@example.com', code: r.body.devCode })).body.token;
});
after(async () => {
  process.env.TZ = originalTz;
  await app.close();
  await db.close();
});

describe('dates do not shift with the server time zone', () => {
  for (const tz of ['Asia/Riyadh', 'Pacific/Honolulu', 'UTC']) {
    it(`a saved trip reads back with the same dates in ${tz}`, async () => {
      process.env.TZ = tz;
      const plan = (await call('POST', '/v1/plans', { preferences: prefs, title: 't' })).body;
      const saved = await call('POST', '/v1/trips', { title: 't', preferences: prefs, days: plan.days.map((d: { stops: { placeId: string }[] }) => ({ placeIds: d.stops.map((s) => s.placeId) })) });
      assert.equal(saved.status, 201, JSON.stringify(saved.body));
      const back = (await call('GET', `/v1/trips/${saved.body.id}`)).body;
      assert.equal(back.preferences.startDate, '2026-12-10');
      assert.equal(back.preferences.endDate, '2026-12-12');
      assert.deepEqual(back.days.map((d: { date: string }) => d.date), ['2026-12-10', '2026-12-11', '2026-12-12']);
      // A left-out place is offered for a real day of the trip.
      const removed = back.days[0].stops[0].placeId;
      const days = back.days.map((d: { stops: { placeId: string }[] }) => ({ placeIds: d.stops.map((s) => s.placeId).filter((id) => id !== removed) }));
      const edited = (await call('PUT', `/v1/trips/${saved.body.id}`, { title: 't', preferences: back.preferences, days })).body;
      assert.ok(['2026-12-10', '2026-12-11', '2026-12-12'].includes(edited.unscheduled.find((u: { placeId: string }) => u.placeId === removed).canFitOn));
    });
  }
});
