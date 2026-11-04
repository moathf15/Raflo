/**
 * Source-of-truth ticket (4 Nov 2026): the server keeps every place chosen for a trip, independent of the
 * interests, the wish list and whatever "unscheduled" list the client sends. The left-out list is always rebuilt
 * from that saved selection and the actual days.
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
let ip = 1;
const prefs = { cityId: 'madinah', startDate: '2026-12-13', endDate: '2026-12-14', travellers: 2, tripType: 'family', budgetTotal: 2000, interests: ['religious', 'history'], aroundPrayerTimes: true, relaxedPace: false };
// hejaz-railway (museum) and quba-walk (nature) are outside these interests.
type Res = { status: number; body: any };
async function call(token: string | null, method: string, url: string, body?: unknown): Promise<Res> {
  const res = await app.inject({ method: method as 'GET', url, payload: body as object, remoteAddress: `10.8.0.${ip++ % 250}`, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}
async function signIn(email: string) {
  const r = await call(null, 'POST', '/v1/auth/request-code', { email });
  return (await call(null, 'POST', '/v1/auth/native/verify', { email, code: r.body.devCode })).body.token as string;
}
const ids = (t: any): string[][] => t.days.map((d: { stops: { placeId: string }[] }) => d.stops.map((s) => s.placeId));
const put = (token: string, trip: any, days: string[][], extra: object = {}) => call(token, 'PUT', `/v1/trips/${trip.id}`, { title: trip.title, preferences: trip.preferences, days: days.map((placeIds) => ({ placeIds })), ...extra });
const listed = (t: any) => new Map<string, string>(t.unscheduled.map((u: { placeId: string; reason: string }) => [u.placeId, u.reason]));
async function newTrip(token: string) {
  const plan = (await call(token, 'POST', '/v1/plans', { preferences: prefs, title: 't' })).body;
  const r = await call(token, 'POST', '/v1/trips', { title: 't', preferences: prefs, days: ids(plan).map((placeIds) => ({ placeIds })) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

before(async () => {
  db = await testDb();
  await migrate(db);
  await seed(db);
  app = await buildApp(db, loadConfig({ NODE_ENV: 'test', AUTH_DEV_CODES: 'true', AUTH_RATE_LIMIT: '100000', NATIVE_CLIENTS: 'true' } as NodeJS.ProcessEnv));
});
after(async () => {
  await app.close();
  await db.close();
});

describe('the server keeps the trip\'s chosen places', () => {
  it('the ticket scenario: a manually added place outside interests and wish list survives removal from its day, even when the client sends an empty list', async () => {
    const token = await signIn('scenario@example.com');
    const trip = await newTrip(token);
    // 1–2. The user adds a museum (not an interest, not on the wish list) to day 1.
    const days = ids(trip);
    const added = await put(token, trip, [[...days[0], 'hejaz-railway'], days[1]]);
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.ok(added.body.selected.includes('hejaz-railway'), 'adding it to a day selects it');
    // 3–4. Removes it from the day; the client sends an empty unscheduled list.
    const removed = await put(token, trip, days, { unscheduled: [] });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    // 5. The server still knows it and lists it, with a day it fits on.
    assert.ok(removed.body.selected.includes('hejaz-railway'));
    assert.equal(listed(removed.body).get('hejaz-railway'), 'not_added');
    // A reorder afterwards does not lose it either.
    const reordered = await put(token, trip, [[...days[0]].reverse(), days[1]], { unscheduled: [] });
    assert.equal(listed(reordered.body).get('hejaz-railway'), 'not_added');
    // And reading the trip back shows the same.
    assert.equal(listed((await call(token, 'GET', `/v1/trips/${trip.id}`)).body).get('hejaz-railway'), 'not_added');
  });

  it('a place leaves the trip only by an explicit removal, and does not come back', async () => {
    const token = await signIn('explicit@example.com');
    const trip = await newTrip(token);
    const days = ids(trip);
    await put(token, trip, [[...days[0], 'hejaz-railway'], days[1]]);
    await put(token, trip, days);
    const del = await call(token, 'DELETE', `/v1/trips/${trip.id}/places/hejaz-railway`);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.ok(!del.body.selected.includes('hejaz-railway'));
    assert.ok(!listed(del.body).has('hejaz-railway'));
    const again = await put(token, trip, days, { unscheduled: ['hejaz-railway'] });
    assert.ok(!again.body.selected.includes('hejaz-railway'), 'a client list cannot re-select it');
    assert.ok(!listed(again.body).has('hejaz-railway'));
  });

  it('a scheduled place cannot be removed from the selection while it is in a day', async () => {
    const token = await signIn('scheduled@example.com');
    const trip = await newTrip(token);
    const inDay = ids(trip)[0][0];
    assert.equal((await call(token, 'DELETE', `/v1/trips/${trip.id}/places/${inDay}`)).status, 409);
  });

  it('a place can be chosen for the trip explicitly without a day, and is listed until it is scheduled', async () => {
    const token = await signIn('choose@example.com');
    const trip = await newTrip(token);
    const add = await call(token, 'POST', `/v1/trips/${trip.id}/places`, { placeId: 'quba-walk' });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    assert.ok(add.body.selected.includes('quba-walk'));
    assert.equal(listed(add.body).get('quba-walk'), 'not_added');
    assert.equal((await call(token, 'POST', `/v1/trips/${trip.id}/places`, { placeId: 'dar-almadinah' })).status, 400, 'draft places cannot be chosen');
    assert.equal((await call(token, 'POST', `/v1/trips/${trip.id}/places`, { placeId: 'no-such-place' })).status, 400);
  });

  it('the selection is the trip\'s own: later wish-list changes do not change it', async () => {
    const token = await signIn('wish@example.com');
    await call(token, 'PUT', '/v1/wishlist/quba-walk');
    const trip = await newTrip(token);
    assert.ok(trip.selected.includes('quba-walk'), 'the wish list at creation is part of the choice');
    await call(token, 'DELETE', '/v1/wishlist/quba-walk');
    const after = await put(token, trip, ids(trip));
    assert.ok(after.body.selected.includes('quba-walk'));
    assert.ok(listed(after.body).has('quba-walk') || ids(after.body).flat().includes('quba-walk'));
  });

  it('client "unscheduled" ids are only a hint on creation: unknown or unpublished ids are ignored', async () => {
    const token = await signIn('hint@example.com');
    const plan = (await call(token, 'POST', '/v1/plans', { preferences: prefs, title: 't' })).body;
    const r = await call(token, 'POST', '/v1/trips', { title: 't', preferences: prefs, days: ids(plan).map((placeIds) => ({ placeIds })), unscheduled: ['quba-walk', 'dar-almadinah', 'no-such-place'] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.selected.includes('quba-walk'), 'a published place the client left out is kept');
    assert.ok(!r.body.selected.includes('dar-almadinah') && !r.body.selected.includes('no-such-place'));
  });

  it('the client can exclude places explicitly when saving a new trip', async () => {
    const token = await signIn('exclude@example.com');
    const plan = (await call(token, 'POST', '/v1/plans', { preferences: { ...prefs, endDate: prefs.startDate, relaxedPace: true }, title: 't' })).body;
    const out = plan.unscheduled[0].placeId;
    const r = await call(token, 'POST', '/v1/trips', { title: 't', preferences: { ...prefs, endDate: prefs.startDate, relaxedPace: true }, days: ids(plan).map((placeIds) => ({ placeIds })), excluded: [out] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(!r.body.selected.includes(out));
    assert.ok(!listed(r.body).has(out));
  });

  it('a chosen place that is later hidden stays listed as unavailable', async () => {
    const token = await signIn('hidden@example.com');
    const trip = await newTrip(token);
    await call(token, 'POST', `/v1/trips/${trip.id}/places`, { placeId: 'quba-walk' });
    await db.query(`UPDATE places SET status = 'hidden' WHERE id = 'quba-walk'`);
    try {
      const t = (await call(token, 'GET', `/v1/trips/${trip.id}`)).body;
      assert.equal(listed(t).get('quba-walk'), 'unavailable');
    } finally {
      await db.query(`UPDATE places SET status = 'published' WHERE id = 'quba-walk'`);
    }
  });

  it('another user cannot read or change a trip\'s selection', async () => {
    const owner = await signIn('owner-sel@example.com');
    const other = await signIn('other-sel@example.com');
    const trip = await newTrip(owner);
    assert.equal((await call(other, 'POST', `/v1/trips/${trip.id}/places`, { placeId: 'quba-walk' })).status, 404);
    assert.equal((await call(other, 'DELETE', `/v1/trips/${trip.id}/places/${ids(trip)[0][0]}`)).status, 404);
  });
});
