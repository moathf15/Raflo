/**
 * Manual scheduling ticket (4 Nov 2026): the API refuses to save a day that is not executable, whatever the
 * client sends, and rebuilds the left-out list itself after every edit.
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

let app: FastifyInstance;
let db: Db;
let token = '';
let ip = 1;
const prefs = { cityId: 'madinah', startDate: '2026-12-13', endDate: '2026-12-14', travellers: 2, tripType: 'family', budgetTotal: 2000, interests: ['religious', 'history'], aroundPrayerTimes: true, relaxedPace: false };
type Res = { status: number; body: any };
async function call(method: string, url: string, body?: unknown): Promise<Res> {
  const res = await app.inject({ method: method as 'GET', url, payload: body as object, remoteAddress: `10.7.0.${ip++ % 250}`, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}
const ids = (t: any): string[][] => t.days.map((d: { stops: { placeId: string }[] }) => d.stops.map((s) => s.placeId));
const body = (p: object, days: string[][]) => ({ title: 't', preferences: p, days: days.map((placeIds) => ({ placeIds })) });
const tripRows = async (id: string) => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM trip_stops WHERE trip_id = $1', [id]))[0].n;

before(async () => {
  db = await testDb();
  await migrate(db);
  await seed(db);
  app = await buildApp(db, loadConfig({ NODE_ENV: 'test', AUTH_DEV_CODES: 'true', AUTH_RATE_LIMIT: '100000', NATIVE_CLIENTS: 'true' } as NodeJS.ProcessEnv));
  const r = await call('POST', '/v1/auth/request-code', { email: 'manual@example.com' });
  token = (await call('POST', '/v1/auth/native/verify', { email: 'manual@example.com', code: r.body.devCode })).body.token;
});
after(async () => {
  await app.close();
  await db.close();
});

describe('saving manual edits', () => {
  it('adding a place to a full day is refused with 400 and the reason; nothing is saved', async () => {
    const p = { ...prefs, endDate: prefs.startDate, lastDayEnd: 11 * 60 }; // a two-hour day
    const plan = (await call('POST', '/v1/plans', { preferences: p, title: 't' })).body;
    const day = ids(plan)[0];
    const extra = plan.unscheduled[0]?.placeId ?? 'uhud';
    const r = await call('POST', '/v1/trips', body(p, [[...day, extra]]));
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'day_not_executable');
    assert.deepEqual(r.body.error.problems.map((x: { problem: string }) => x.problem), ['past_day_end']);
    const [{ n }] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM trips t JOIN users u ON u.id = t.user_id WHERE u.email = 'manual@example.com'`);
    assert.equal(n, 0);
  });

  it('editing a saved trip into an impossible day is refused and the saved trip is unchanged', async () => {
    const plan = (await call('POST', '/v1/plans', { preferences: prefs, title: 't' })).body;
    const saved = (await call('POST', '/v1/trips', body(prefs, ids(plan)))).body;
    const before = await tripRows(saved.id);
    // A very long visit added to day 1 cannot end before 21:00.
    await db.query(`UPDATE places SET visit_minutes = 600 WHERE id = 'hejaz-railway'`);
    const r = await call('PUT', `/v1/trips/${saved.id}`, body(prefs, [[...ids(saved)[0], 'hejaz-railway'], ids(saved)[1]]));
    await db.query(`UPDATE places SET visit_minutes = 60 WHERE id = 'hejaz-railway'`);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.problems[0].problem, 'past_day_end');
    assert.equal(await tripRows(saved.id), before);
    assert.deepEqual(ids((await call('GET', `/v1/trips/${saved.id}`)).body), ids(saved));
  });

  it('a place on its closed weekday, or outside its hours, is refused with the place named', async () => {
    await assert.rejects(db.query(`UPDATE places SET closed_weekdays = '{0}' WHERE id = 'uhud'`), 'closing days need opening hours');
    await db.query(`UPDATE places SET open_minute = 0, close_minute = 1440, closed_weekdays = '{0}' WHERE id = 'uhud'`); // 2026-12-13 is a Sunday
    await db.query(`UPDATE places SET open_minute = 6 * 60, close_minute = 8 * 60 WHERE id = 'seven-mosques'`);
    try {
      const closed = await call('POST', '/v1/trips', body(prefs, [['uhud'], []]));
      assert.equal(closed.status, 400);
      assert.deepEqual(closed.body.error.problems, [{ date: '2026-12-13', placeId: 'uhud', problem: 'closed_that_day' }]);
      const hours = await call('POST', '/v1/trips', body(prefs, [[], ['seven-mosques']]));
      assert.deepEqual(hours.body.error.problems, [{ date: '2026-12-14', placeId: 'seven-mosques', problem: 'outside_hours' }]);
      assert.equal((await call('POST', '/v1/trips', body(prefs, [[], ['uhud']]))).status, 201, 'the Monday is fine');
    } finally {
      await db.query(`UPDATE places SET closed_weekdays = '{}', open_minute = NULL, close_minute = NULL WHERE id = 'uhud'`);
      await db.query(`UPDATE places SET open_minute = NULL, close_minute = NULL WHERE id = 'seven-mosques'`);
    }
  });

  it('the left-out list is rebuilt on every save: a removed place returns with the day it fits on, and leaves once added back', async () => {
    const plan = (await call('POST', '/v1/plans', { preferences: prefs, title: 't' })).body;
    const saved = (await call('POST', '/v1/trips', body(prefs, ids(plan)))).body;
    assert.deepEqual(saved.unscheduled, []);
    const days = ids(saved);
    const removed = days[0].pop()!;
    const without = await call('PUT', `/v1/trips/${saved.id}`, body(prefs, days));
    assert.equal(without.status, 200, JSON.stringify(without.body));
    assert.equal(without.body.unscheduled.length, 1);
    assert.deepEqual([without.body.unscheduled[0].placeId, without.body.unscheduled[0].reason], [removed, 'not_added']);
    assert.ok(['2026-12-13', '2026-12-14'].includes(without.body.unscheduled[0].canFitOn));
    days[1].push(removed);
    const back = await call('PUT', `/v1/trips/${saved.id}`, body(prefs, days));
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.deepEqual(back.body.unscheduled, []);
  });

  it('the client cannot clear the list: an empty "unscheduled" is ignored', async () => {
    const p = { ...prefs, endDate: prefs.startDate, relaxedPace: true };
    const plan = (await call('POST', '/v1/plans', { preferences: p, title: 't' })).body;
    assert.ok(plan.unscheduled.length > 0);
    const saved = await call('POST', '/v1/trips', { ...body(p, ids(plan)), unscheduled: [] });
    assert.equal(saved.status, 201);
    assert.deepEqual(saved.body.unscheduled.map((u: { placeId: string }) => u.placeId).sort(), plan.unscheduled.map((u: { placeId: string }) => u.placeId).sort());
  });
});
