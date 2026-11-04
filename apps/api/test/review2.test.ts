/**
 * Regression tests for the second review (RIFLO_Review_and_Scheduling_Requirements, 4 Nov 2026), section 3.
 * The concurrency tests fire requests in parallel. On real PostgreSQL (TEST_DATABASE_URL) they run on separate
 * connections, which is where the races happened.
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
import { QUOTAS } from '../src/context';

let app: FastifyInstance;
let web: FastifyInstance;
let db: Db;
const ORIGIN = 'http://localhost:5173';
const env = { NODE_ENV: 'test', AUTH_DEV_CODES: 'true', AUTH_RATE_LIMIT: '100000', CORS_ORIGINS: ORIGIN };
const prefs = { cityId: 'madinah', startDate: '2026-12-10', endDate: '2026-12-11', travellers: 2, tripType: 'family', budgetTotal: 2000, interests: ['religious', 'history'], aroundPrayerTimes: true, relaxedPace: false };

let ipSeq = 1;
const newIp = () => `10.9.${Math.floor(ipSeq / 250)}.${ipSeq++ % 250}`;
type Res = { status: number; body: any; headers: Record<string, unknown> };
async function call(a: FastifyInstance, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await a.inject({ method: method as 'GET', url, payload: body as object, remoteAddress: newIp(), headers });
  return { status: res.statusCode, body: res.body ? res.json() : null, headers: res.headers };
}
async function code(a: FastifyInstance, email: string) {
  const r = await call(a, 'POST', '/v1/auth/request-code', { email });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  return r.body.devCode as string;
}
async function nativeToken(email: string) {
  const r = await call(app, 'POST', '/v1/auth/native/verify', { email, code: await code(app, email) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token as string;
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const cookieOf = (r: Res) => String(([] as unknown[]).concat(r.headers['set-cookie'])[0]).split(';')[0];
const wrong = (c: string) => (c === '000000' ? '111111' : '000000');

before(async () => {
  db = await testDb();
  await migrate(db);
  await seed(db);
  app = await buildApp(db, loadConfig({ ...env, NATIVE_CLIENTS: 'true' } as NodeJS.ProcessEnv));
  web = await buildApp(db, loadConfig(env as NodeJS.ProcessEnv));
});
after(async () => {
  await app.close();
  await web.close();
  await db.close();
});

describe('3 bearer tokens are separate from browser sign-in', () => {
  it('browser sign-in sets the cookie and never returns a token, even if asked', async () => {
    const email = 'browser@example.com';
    const c = await code(web, email);
    const asked = await call(web, 'POST', '/v1/auth/verify', { email, code: c, transport: 'bearer' });
    assert.equal(asked.status, 400, 'the old transport switch is refused, not silently honoured');
    const ok = await call(web, 'POST', '/v1/auth/verify', { email, code: c });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.token, undefined);
    assert.match(String(ok.headers['set-cookie']), /HttpOnly/);
  });

  it('the native endpoint does not exist unless native clients are enabled', async () => {
    const email = 'native-off@example.com';
    assert.equal((await call(web, 'POST', '/v1/auth/native/verify', { email, code: await code(web, email) })).status, 404);
  });

  it('a web page cannot get a token from the native endpoint', async () => {
    const email = 'native-page@example.com';
    const c = await code(app, email);
    assert.equal((await call(app, 'POST', '/v1/auth/native/verify', { email, code: c }, { origin: ORIGIN })).status, 403);
    assert.equal((await call(app, 'POST', '/v1/auth/native/verify', { email, code: c }, { 'sec-fetch-site': 'same-origin' })).status, 403);
  });

  it('a session works only through the transport it was issued for', async () => {
    const token = await nativeToken('native-app@example.com');
    assert.equal((await call(app, 'GET', '/v1/me', undefined, bearer(token))).status, 200);
    assert.equal((await call(app, 'GET', '/v1/me', undefined, { cookie: `riflo_session=${token}` })).status, 401, 'bearer token replayed as a cookie');

    const email = 'cookie-user@example.com';
    const signed = await call(app, 'POST', '/v1/auth/verify', { email, code: await code(app, email) });
    const cookieToken = cookieOf(signed).split('=')[1];
    assert.equal((await call(app, 'GET', '/v1/me', undefined, { cookie: cookieOf(signed) })).status, 200);
    assert.equal((await call(app, 'GET', '/v1/me', undefined, bearer(cookieToken))).status, 401, 'cookie token replayed as bearer');
  });

  it('bearer tokens are refused everywhere when native clients are disabled', async () => {
    const token = await nativeToken('native-then-off@example.com');
    assert.equal((await call(web, 'GET', '/v1/me', undefined, bearer(token))).status, 401);
  });
});

describe('3 quotas and OTP limits under concurrent requests', () => {
  it('parallel wrong guesses get at most 5 comparisons per code; the code is then dead', async () => {
    const email = 'parallel-guess@example.com';
    const right = await code(app, email);
    const results = await Promise.all(Array.from({ length: 25 }, () => call(app, 'POST', '/v1/auth/native/verify', { email, code: wrong(right) })));
    assert.ok(results.every((r) => r.status === 400 || r.status === 429), JSON.stringify(results.map((r) => r.status)));
    const [row] = await db.query<{ attempts: number }>('SELECT attempts FROM login_codes WHERE identifier = $1', [email]);
    assert.equal(row.attempts, 5, 'exactly 5 guesses were counted');
    await db.query('DELETE FROM auth_failures WHERE identifier = $1', [email]); // lift the email lockout, to test the code itself
    assert.equal((await call(app, 'POST', '/v1/auth/native/verify', { email, code: right })).status, 400, 'the right code no longer works');
  });

  it('parallel code requests for one email issue exactly one code', async () => {
    const email = 'parallel-codes@example.com';
    const results = await Promise.all(Array.from({ length: 10 }, () => call(app, 'POST', '/v1/auth/request-code', { email })));
    assert.equal(results.filter((r) => r.status === 202).length, 1, JSON.stringify(results.map((r) => r.status)));
    assert.ok(results.filter((r) => r.status !== 202).every((r) => r.status === 429));
    const [n] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM login_codes WHERE identifier = $1', [email]);
    assert.equal(n.n, 1);
  });

  it('parallel trip saves cannot pass the daily trip quota', async () => {
    const token = await nativeToken('parallel-trips@example.com');
    const [u] = await db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'parallel-trips@example.com'`);
    // One slot left.
    await db.query(
      `INSERT INTO trips (user_id, city_id, title, start_date, end_date, travellers, trip_type, budget_total, interests, around_prayer, relaxed_pace)
       SELECT $1, 'madinah', 'filler', '2026-12-10', '2026-12-10', 1, 'family', 0, '{religious}', false, false FROM generate_series(1, $2)`,
      [u.id, QUOTAS.tripsPerDay - 1]
    );
    const plan = (await call(app, 'POST', '/v1/plans', { preferences: prefs, title: 't' }, bearer(token))).body;
    const body = { title: 't', preferences: prefs, days: plan.days.map((d: { stops: { placeId: string }[] }) => ({ placeIds: d.stops.map((s) => s.placeId) })) };
    const results = await Promise.all(Array.from({ length: 6 }, () => call(app, 'POST', '/v1/trips', body, bearer(token))));
    assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
    const [n] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM trips WHERE user_id = $1', [u.id]);
    assert.equal(n.n, QUOTAS.tripsPerDay);
  });

  it('parallel events cannot pass the daily event quota', async () => {
    const anon = 'anon_parallel0001';
    await db.query(`INSERT INTO events (name, anonymous_id, props) SELECT 'plan_started', $1, '{}' FROM generate_series(1, $2)`, [anon, QUOTAS.eventsPerDay - 1]);
    const results = await Promise.all(Array.from({ length: 6 }, () => call(app, 'POST', '/v1/events', { name: 'plan_started', anonymousId: anon, props: {} })));
    assert.equal(results.filter((r) => r.status === 202).length, 1, JSON.stringify(results.map((r) => r.status)));
    const [n] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM events WHERE anonymous_id = $1', [anon]);
    assert.equal(n.n, QUOTAS.eventsPerDay);
  });
});

describe('3 last admin under concurrency', () => {
  it('two admins demoting each other at the same time cannot leave zero admins', async () => {
    // Exactly two active admins.
    await db.query(`UPDATE users SET role = 'user' WHERE role = 'admin' AND email NOT IN ('admin@riflo.local')`);
    await db.query(`INSERT INTO users (email, role) VALUES ('second-admin-race@example.com', 'admin') ON CONFLICT (email) DO UPDATE SET role = 'admin', status = 'active'`);
    const [{ n: before }] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'`);
    assert.equal(before, 2);

    let firstUpdated!: () => void;
    const updated = new Promise<void>((r) => (firstUpdated = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    // Transaction 1 demotes admin A and holds its transaction open.
    const t1 = db.tx(async (t) => {
      await t.query(`UPDATE users SET role = 'user' WHERE email = 'admin@riflo.local'`);
      firstUpdated();
      await gate;
    });
    await updated;
    // Transaction 2 demotes admin B while transaction 1 is still open.
    const t2 = db.tx((t) => t.query(`UPDATE users SET role = 'user' WHERE email = 'second-admin-race@example.com'`));
    setTimeout(release, 300);
    const outcome = await Promise.allSettled([t1, t2]);

    const failed = outcome.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(failed.length, 1, 'exactly one demotion is refused');
    assert.match(String(failed[0].reason?.message ?? failed[0].reason), /last_admin/);
    const [{ n: afterCount }] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'`);
    assert.equal(afterCount, 1);
  });
});

describe('4–7 the plan API spreads the trip and explains what it left out', () => {
  const tripBody = (plan: any, p: any, extra: object = {}) => ({ title: 't', preferences: p, days: plan.days.map((d: { stops: { placeId: string }[] }) => ({ placeIds: d.stops.map((s) => s.placeId) })), ...extra });

  it('a 5-day plan uses every day and lists nothing it could fit', async () => {
    const p = { ...prefs, startDate: '2026-12-13', endDate: '2026-12-17', interests: ['religious', 'history'] };
    const plan = (await call(app, 'POST', '/v1/plans', { preferences: p, title: 't' })).body;
    assert.equal(plan.days.length, 5);
    assert.ok(plan.days.every((d: { stops: unknown[] }) => d.stops.length >= 1), JSON.stringify(plan.days.map((d: { stops: unknown[] }) => d.stops.length)));
    assert.deepEqual(plan.unscheduled, []);
  });

  it('a late arrival is honoured and stored with the trip', async () => {
    const token = await nativeToken('late-arrival@example.com');
    const p = { ...prefs, firstDayStart: 18 * 60, lastDayEnd: 12 * 60 };
    const plan = (await call(app, 'POST', '/v1/plans', { preferences: p, title: 't' }, bearer(token))).body;
    assert.ok(plan.days[0].stops.every((s: { start: number }) => s.start >= 18 * 60));
    const saved = await call(app, 'POST', '/v1/trips', tripBody(plan, p), bearer(token));
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.preferences.firstDayStart, 18 * 60);
    assert.equal(saved.body.preferences.lastDayEnd, 12 * 60);
    const remembered = (await call(app, 'GET', '/v1/passport', undefined, bearer(token))).body.lastPreferences;
    assert.equal(remembered.firstDayStart, undefined, 'arrival times belong to one trip, not to the next one');
  });

  it('rejects a one-day trip that ends before it starts', async () => {
    const p = { ...prefs, endDate: prefs.startDate, firstDayStart: 15 * 60, lastDayEnd: 14 * 60 };
    assert.equal((await call(app, 'POST', '/v1/plans', { preferences: p, title: 't' })).status, 400);
  });

  it('the server works out the left-out list itself: client reasons and unknown ids are ignored', async () => {
    const token = await nativeToken('unscheduled@example.com');
    const p = { ...prefs, endDate: prefs.startDate, relaxedPace: true, interests: ['religious', 'history'] };
    const plan = (await call(app, 'POST', '/v1/plans', { preferences: p, title: 't' }, bearer(token))).body;
    assert.ok(plan.unscheduled.length > 0, 'a relaxed one-day trip holds 3 of the 5 wanted places');
    const left = plan.unscheduled.map((u: { placeId: string }) => u.placeId);
    const inTrip = plan.days[0].stops[0].placeId;
    const saved = await call(app, 'POST', '/v1/trips', tripBody(plan, p, { unscheduled: [...left, inTrip, 'no-such-place'] }), bearer(token));
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.unscheduled.map((u: { placeId: string }) => u.placeId).sort(), [...left].sort());
    const byPlace = (xs: { placeId: string }[]) => [...xs].sort((a, b) => a.placeId.localeCompare(b.placeId));
    assert.deepEqual(byPlace(saved.body.unscheduled), byPlace(plan.unscheduled), 'same explanation on the server as in the plan');
  });

  it('closing days set in the admin reach the planner: the place moves to a day it is open', async () => {
    await db.query(`UPDATE users SET role = 'admin', status = 'active' WHERE email = 'admin@riflo.local'`); // the race test above may have demoted it
    const admin = await nativeToken('admin@riflo.local');
    const place = (await call(app, 'GET', '/v1/places/quba')).body;
    const sunday = 0; // 2026-12-13 is a Sunday
    const body = { ...place, cityId: 'madinah', hours: { open: 0, close: 1440, closedOn: [sunday, sunday] } };
    for (const k of ['id', 'status', 'updatedAt', 'openReports', 'photos']) delete body[k];
    const put = await call(app, 'PUT', '/v1/admin/places/quba', body, bearer(admin));
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.hours.closedOn, [0], 'duplicates removed');
    const p = { ...prefs, startDate: '2026-12-13', endDate: '2026-12-14', interests: ['religious'] };
    const plan = (await call(app, 'POST', '/v1/plans', { preferences: p, title: 't' })).body;
    assert.ok(!plan.days[0].stops.some((s: { placeId: string }) => s.placeId === 'quba'), 'not on the Sunday');
    assert.ok(plan.days[1].stops.some((s: { placeId: string }) => s.placeId === 'quba'), 'on the Monday instead');
    assert.equal((await call(app, 'PUT', '/v1/admin/places/quba', { ...body, hours: { open: 0, close: 1440, closedOn: [7] } }, bearer(admin))).status, 400);
  });
});
