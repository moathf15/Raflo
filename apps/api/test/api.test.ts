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

const cfg = loadConfig({ NODE_ENV: 'test', AUTH_DEV_CODES: 'true', AUTH_RATE_LIMIT: '1000', NATIVE_CLIENTS: 'true' } as NodeJS.ProcessEnv);
const prefs = { cityId: 'madinah', startDate: '2026-12-10', endDate: '2026-12-12', travellers: 4, tripType: 'family', budgetTotal: 3000, interests: ['religious', 'history'], aroundPrayerTimes: true, relaxedPace: false };

let ipSeq = 1;
async function call(method: string, url: string, body?: unknown, token?: string) {
  const res = await app.inject({ method: method as 'GET', url, payload: body as object, remoteAddress: `10.9.0.${ipSeq++ % 250}`, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.statusCode, body: res.body ? res.json() : null, headers: res.headers };
}
const tokens = new Map<string, string>();
async function signIn(email: string) {
  if (tokens.has(email)) return tokens.get(email)!;
  const req = await call('POST', '/v1/auth/request-code', { email });
  const res = await call('POST', '/v1/auth/native/verify', { email, code: req.body.devCode });
  assert.equal(res.status, 200);
  tokens.set(email, res.body.token);
  return res.body.token as string;
}

before(async () => {
  db = await testDb();
  await migrate(db);
  await seed(db);
  app = await buildApp(db, cfg);
});
after(async () => {
  await app.close();
  await db.close();
});

describe('public content', () => {
  it('lists only published places', async () => {
    const r = await call('GET', '/v1/cities/madinah/places');
    assert.equal(r.status, 200);
    assert.ok(r.body.length > 0);
    assert.ok(r.body.every((p: { status: string }) => p.status === 'published'));
  });
  it('hides drafts from the place endpoint', async () => {
    assert.equal((await call('GET', '/v1/places/aqiq')).status, 404);
    assert.equal((await call('GET', '/v1/places/quba')).status, 200);
  });
});

describe('sign-in', () => {
  it('rejects a wrong code and accepts the right one', async () => {
    const email = 'sara@example.com';
    const req = await call('POST', '/v1/auth/request-code', { email });
    assert.equal(req.status, 202);
    const wrong = req.body.devCode === '000000' ? '111111' : '000000';
    assert.equal((await call('POST', '/v1/auth/verify', { email, code: wrong })).status, 400);
    const ok = await call('POST', '/v1/auth/verify', { email, code: req.body.devCode });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.role, 'user');
    assert.equal(ok.body.token, undefined, 'browsers never receive the token in the body');
    assert.match(String(ok.headers?.['set-cookie'] ?? ''), /riflo_session=.*HttpOnly.*SameSite=Lax/i);
    assert.equal((await call('POST', '/v1/auth/verify', { email, code: req.body.devCode })).status, 400, 'code is single-use');
  });
  it('requires a token for private routes', async () => {
    assert.equal((await call('GET', '/v1/passport')).status, 401);
    assert.equal((await call('GET', '/v1/passport', undefined, 'not-a-token')).status, 401);
  });
});

describe('trip lifecycle and passport loop', () => {
  let token: string;
  let tripId: string;
  let firstPlace: string;

  it('lets a guest generate a plan', async () => {
    const r = await call('POST', '/v1/plans', { preferences: prefs, title: 'رحلة عائلية' });
    assert.equal(r.status, 200);
    assert.equal(r.body.days.length, 3);
    assert.ok(r.body.days[0].stops.length > 0);
  });

  it('saves a trip and computes times on the server', async () => {
    token = await signIn('family@example.com');
    const plan = (await call('POST', '/v1/plans', { preferences: prefs, title: 'رحلة عائلية' }, token)).body;
    const days = plan.days.map((d: { stops: { placeId: string }[] }) => ({ placeIds: d.stops.map((s) => s.placeId) }));
    const saved = await call('POST', '/v1/trips', { title: plan.title, preferences: prefs, days }, token);
    assert.equal(saved.status, 201);
    tripId = saved.body.id;
    firstPlace = days[0].placeIds[0];
    assert.equal(saved.body.days[0].stops[0].start, 9 * 60);
  });

  it('remembers preferences for the next trip', async () => {
    const p = await call('GET', '/v1/passport', undefined, token);
    assert.deepEqual(p.body.lastPreferences.interests, prefs.interests);
    assert.equal(p.body.lastPreferences.startDate, undefined);
    assert.equal(p.body.stats.trips, 1);
    assert.equal(p.body.stats.travelDays, 3);
  });

  it('reorders a day on update', async () => {
    const trip = (await call('GET', `/v1/trips/${tripId}`, undefined, token)).body;
    const days = trip.days.map((d: { stops: { placeId: string }[] }) => ({ placeIds: d.stops.map((s) => s.placeId) }));
    days[0].placeIds.reverse();
    const r = await call('PUT', `/v1/trips/${tripId}`, { title: 'معدّلة', preferences: prefs, days }, token);
    assert.equal(r.status, 200);
    assert.equal(r.body.title, 'معدّلة');
    assert.equal(r.body.days[0].stops[0].placeId, days[0].placeIds[0]);
  });

  it('rejects unpublished places in a trip', async () => {
    const r = await call('POST', '/v1/trips', { title: 'x', preferences: prefs, days: [{ placeIds: ['aqiq'] }, { placeIds: [] }, { placeIds: [] }] }, token);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'place_unavailable');
  });

  it('logs a visit once per day and clears it from the wish list', async () => {
    await call('PUT', `/v1/wishlist/${firstPlace}`, undefined, token);
    // The trip is in December, so a visit today can't belong to it; log it as a standalone visit.
    assert.equal((await call('POST', '/v1/visits', { placeId: firstPlace, tripId, date: '2026-11-01' }, token)).status, 400, 'date outside the trip');
    const v = await call('POST', '/v1/visits', { placeId: firstPlace, date: '2026-11-01', rating: 5 }, token);
    assert.equal(v.status, 201);
    assert.equal(v.body.source, 'self_reported');
    assert.equal((await call('POST', '/v1/visits', { placeId: firstPlace, date: '2026-11-01' }, token)).status, 409);
    const p = (await call('GET', '/v1/passport', undefined, token)).body;
    assert.equal(p.visits.length, 1);
    assert.ok(!p.wishList.includes(firstPlace));
  });

  it("never exposes another user's trip", async () => {
    const other = await signIn('other@example.com');
    assert.equal((await call('GET', `/v1/trips/${tripId}`, undefined, other)).status, 404);
    assert.equal((await call('DELETE', `/v1/trips/${tripId}`, undefined, other)).status, 404);
  });
});

describe('admin', () => {
  let admin: string;
  let user: string;
  before(async () => {
    admin = await signIn('admin@riflo.local');
    user = await signIn('plain@example.com');
  });

  it('blocks non-staff', async () => {
    assert.equal((await call('GET', '/v1/admin/overview', undefined, user)).status, 403);
  });

  it('turns a visitor report into a decision, closed one by one with a reason', async () => {
    await call('POST', '/v1/places/quba/reports', { kind: 'wrong_info', message: 'تغيّرت الأوقات' });
    let o = (await call('GET', '/v1/admin/overview', undefined, admin)).body;
    assert.equal(o.reportCount, 1);
    assert.equal(o.metrics.tripsCreated, 1);
    const [rep] = (await call('GET', '/v1/admin/reports', undefined, admin)).body;
    assert.equal(rep.status, 'new');
    assert.equal((await call('PATCH', `/v1/admin/reports/${rep.id}`, { status: 'in_review' }, admin)).status, 200);
    assert.equal((await call('PATCH', `/v1/admin/reports/${rep.id}`, { status: 'resolved', note: 'حُدّثت الأوقات' }, admin)).status, 200);
    o = (await call('GET', '/v1/admin/overview', undefined, admin)).body;
    assert.equal(o.reportCount, 0);
  });

  it('creates a draft, publishes it, and records it in the audit log', async () => {
    const body = { cityId: 'madinah', name: 'مكان تجريبي', summary: 'وصف', category: 'museum', location: { lat: 24.47, lng: 39.61 }, visitMinutes: 30, costPerPerson: 15, openingHours: '9 ص – 5 م', hours: { open: 540, close: 1020 }, bestTime: 'any', etiquette: null };
    const c = await call('POST', '/v1/admin/places', body, admin);
    assert.equal(c.status, 201);
    assert.equal(c.body.status, 'draft');
    await call('PATCH', `/v1/admin/places/${c.body.id}/status`, { status: 'published' }, admin);
    assert.equal((await call('GET', `/v1/places/${c.body.id}`)).status, 200);
    const log = await db.query('SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id', [c.body.id]);
    assert.deepEqual(log.map((r) => r.action), ['create', 'set_status']);
  });

  it('validates input', async () => {
    const r = await call('POST', '/v1/admin/places', { name: '' }, admin);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'invalid_request');
  });

  it('suspending a user signs them out immediately', async () => {
    const users = (await call('GET', '/v1/admin/users?q=plain', undefined, admin)).body;
    await call('PATCH', `/v1/admin/users/${users[0].id}`, { status: 'suspended' }, admin);
    assert.equal((await call('GET', '/v1/me', undefined, user)).status, 401);
  });

  it('reports funnel and insights from real events, per planning session', async () => {
    const sessionId = 'sess_funnel_test_000001';
    await call('POST', '/v1/events', { name: 'plan_started', props: { cityId: 'madinah' }, anonymousId: 'anon_funneltest1', sessionId });
    await call('POST', '/v1/events', { name: 'plan_step_completed', props: { step: 1 }, anonymousId: 'anon_funneltest1', sessionId });
    await call('POST', '/v1/plans', { preferences: prefs, title: 't', anonymousId: 'anon_funneltest1', sessionId });
    await call('POST', '/v1/events', { name: 'plan_started', props: {}, anonymousId: 'anon_funneltest2', sessionId: 'sess_funnel_test_000002' }); // abandoned
    const o = (await call('GET', '/v1/admin/overview', undefined, admin)).body;
    const step = (n: string) => o.funnel.find((f: { step: string }) => f.step === n).count;
    assert.equal(step('plan_started'), 2);
    assert.equal(step('plan_ready'), 1);
    assert.equal(o.metrics.completionRate, 0.5);
    assert.ok(o.topPlaces.length > 0 && o.topPlaces[0].trips >= 1);
    const ins = (await call('GET', '/v1/admin/insights', undefined, admin)).body;
    assert.ok(ins.topPlaces.length > 0);
    assert.equal(ins.topInterests[0].trips, 1);
  });
});

describe('account deletion', () => {
  it('removes the user and their data', async () => {
    const token = await signIn('leaving@example.com');
    const plan = (await call('POST', '/v1/plans', { preferences: prefs, title: 't' }, token)).body;
    await call('POST', '/v1/trips', { title: 't', preferences: prefs, days: plan.days.map((d: { stops: { placeId: string }[] }) => ({ placeIds: d.stops.map((s) => s.placeId) })) }, token);
    assert.equal((await call('DELETE', '/v1/me', undefined, token)).status, 204);
    const [left] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM trips t JOIN users u ON u.id = t.user_id WHERE u.email = 'leaving@example.com'`);
    assert.equal(left.n, 0);
  });
});

describe('abuse protection', () => {
  it('rate-limits sign-in requests per IP', async () => {
    const strictDb = await testDb();
    await migrate(strictDb);
    const strict = await buildApp(strictDb, loadConfig({ NODE_ENV: 'test', AUTH_DEV_CODES: 'true' } as NodeJS.ProcessEnv));
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await strict.inject({ method: 'POST', url: '/v1/auth/request-code', payload: { email: `x${i}@example.com` } })).statusCode);
    assert.deepEqual(statuses, [202, 202, 202, 202, 202, 429]);
    await strict.close();
    await strictDb.close();
  });
});
