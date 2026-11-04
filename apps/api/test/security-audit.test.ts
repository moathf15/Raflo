/**
 * Regression tests for the findings of SECURITY_AUDIT.md (S1–S5, S9). Each test failed on the code as uploaded.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import type { Db } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { seed } from '../src/db/seed';
import { testDb } from './db';

const ORIGIN = 'http://localhost:5173';
const prefs = { cityId: 'madinah', startDate: '2026-12-10', endDate: '2026-12-10', travellers: 1, tripType: 'solo', budgetTotal: 0, interests: ['religious'], aroundPrayerTimes: false, relaxedPace: false };

let db: Db;
let queries = 0;
/** The test database, counting every query (for S4). */
let counted: Db;
let app: FastifyInstance;
let ipSeq = 1;

const config = (env: Record<string, string> = {}) => loadConfig({ NODE_ENV: 'test', AUTH_DEV_CODES: 'true', AUTH_RATE_LIMIT: '1000', CORS_ORIGINS: ORIGIN, ...env } as NodeJS.ProcessEnv);

function inject(a: FastifyInstance, method: string, url: string, o: { body?: unknown; cookie?: string; headers?: Record<string, string>; ip?: string } = {}) {
  return a.inject({
    method: method as 'GET',
    url,
    payload: o.body as object,
    remoteAddress: o.ip ?? `10.20.0.${ipSeq++ % 250}`,
    headers: { ...(o.cookie ? { cookie: `riflo_session=${o.cookie}` } : {}), ...(o.headers ?? {}) }
  });
}

async function cookieSignIn(email: string) {
  const r = await inject(app, 'POST', '/v1/auth/request-code', { body: { email } });
  const v = await inject(app, 'POST', '/v1/auth/verify', { body: { email, code: r.json().devCode }, headers: { origin: ORIGIN } });
  assert.equal(v.statusCode, 200);
  return v.cookies.find((c) => c.name === 'riflo_session')!.value;
}

before(async () => {
  db = await testDb();
  await migrate(db);
  await seed(db);
  const count = (d: Db): Db => ({ ...d, query: (sql, params) => (queries++, d.query(sql, params)), tx: (fn) => d.tx((t) => fn(count(t))) });
  counted = count(db);
  app = await buildApp(counted, config());
});
after(async () => {
  await app.close();
  await db.close();
});

describe('S1 client IP from X-Forwarded-For', () => {
  const burst = async (a: FastifyInstance, xff: boolean) => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await inject(a, 'POST', '/v1/auth/request-code', { body: { email: `xff-${xff}-${ipSeq}-${i}@example.com` }, ip: '203.0.113.7', headers: xff ? { 'x-forwarded-for': `198.51.100.${i}` } : {} });
      codes.push(r.statusCode);
    }
    return codes;
  };

  it('ignores X-Forwarded-For from a client that is not a trusted proxy', async () => {
    const a = await buildApp(db, config({ AUTH_RATE_LIMIT: '2' }));
    try {
      assert.deepEqual(await burst(a, true), [202, 202, 429, 429], 'rotating X-Forwarded-For must not reset the per-IP limit');
    } finally {
      await a.close();
    }
  });

  it('uses X-Forwarded-For when the request comes from a listed proxy', async () => {
    const a = await buildApp(db, config({ AUTH_RATE_LIMIT: '2', TRUST_PROXY: '203.0.113.0/24' }));
    try {
      a.get('/__ip', async (req) => ({ ip: req.ip }));
      const r = await inject(a, 'GET', '/__ip', { ip: '203.0.113.7', headers: { 'x-forwarded-for': '198.51.100.9' } });
      assert.equal(r.json().ip, '198.51.100.9');
    } finally {
      await a.close();
    }
  });
});

describe('S2 lockout cannot be triggered for free', () => {
  it('guesses when no code was issued are refused but not counted', async () => {
    const email = 'never-requested@example.com';
    for (let i = 0; i < 12; i++) assert.equal((await inject(app, 'POST', '/v1/auth/verify', { body: { email, code: '123456' }, headers: { origin: ORIGIN }, ip: '10.30.0.1' })).statusCode, 400);
    const [row] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM auth_failures WHERE identifier = $1', [email]);
    assert.equal(row.n, 0);
    assert.equal((await inject(app, 'POST', '/v1/auth/request-code', { body: { email } })).statusCode, 202, 'the owner can still get a code');
  });
});

describe('S3 a dead session cookie', () => {
  it('lets the browser keep using guest features and clears the cookie', async () => {
    const cookie = await cookieSignIn('revoked-elsewhere@example.com');
    assert.equal((await inject(app, 'POST', '/v1/auth/logout-all', { cookie, body: {}, headers: { origin: ORIGIN } })).statusCode, 204);
    const plan = await inject(app, 'POST', '/v1/plans', { cookie, body: { preferences: prefs, title: 't' }, headers: { origin: ORIGIN } });
    assert.equal(plan.statusCode, 200);
    const cleared = plan.cookies.find((c) => c.name === 'riflo_session');
    assert.ok(cleared && cleared.value === '', 'the dead cookie is removed');
  });

  it('can always be signed out', async () => {
    const r = await inject(app, 'POST', '/v1/auth/logout', { cookie: 'not-a-token', body: {}, headers: { origin: ORIGIN } });
    assert.equal(r.statusCode, 204);
    assert.ok(r.cookies.some((c) => c.name === 'riflo_session' && c.value === ''));
  });

  it('still gets 401 on account routes', async () => {
    assert.equal((await inject(app, 'GET', '/v1/me', { cookie: 'not-a-token' })).statusCode, 401);
  });

  it('a valid cookie still needs an allowed origin to write (CSRF unchanged)', async () => {
    const cookie = await cookieSignIn('csrf-still@example.com');
    assert.equal((await inject(app, 'PATCH', '/v1/me', { cookie, body: { displayName: 'x' }, headers: { origin: 'https://evil.example' } })).statusCode, 403);
    assert.equal((await inject(app, 'PATCH', '/v1/me', { cookie, body: { displayName: 'x' } })).statusCode, 403);
  });
});

describe('S4 listing trips', () => {
  it('uses a fixed number of queries however many trips there are', async () => {
    const cookie = await cookieSignIn('many-trips@example.com');
    const h = { origin: ORIGIN };
    const save = () => inject(app, 'POST', '/v1/trips', { cookie, headers: h, body: { title: 't', preferences: prefs, days: [{ placeIds: ['quba'] }] } });
    const measure = async () => {
      queries = 0;
      const r = await inject(app, 'GET', '/v1/trips', { cookie });
      assert.equal(r.statusCode, 200);
      return { n: queries, trips: r.json().length as number };
    };
    await save();
    const one = await measure();
    for (let i = 0; i < 9; i++) await save();
    const ten = await measure();
    assert.equal(ten.trips, 10);
    assert.equal(ten.n, one.n, `1 trip: ${one.n} queries, 10 trips: ${ten.n}`);
  });
});

describe('S5 malformed Referer', () => {
  it('is a 403, not a 500', async () => {
    const cookie = await cookieSignIn('bad-referer@example.com');
    const r = await inject(app, 'PATCH', '/v1/me', { cookie, body: { displayName: 'x' }, headers: { referer: 'not a url' } });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error.code, 'csrf_origin');
  });
});

describe('S9 saving the same trip concurrently', () => {
  it('every save succeeds and the trip keeps exactly one copy of its days', async () => {
    const cookie = await cookieSignIn('race@example.com');
    const h = { origin: ORIGIN };
    const id = (await inject(app, 'POST', '/v1/trips', { cookie, headers: h, body: { title: 't', preferences: prefs, days: [{ placeIds: ['quba'] }] } })).json().id;
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => inject(app, 'PUT', `/v1/trips/${id}`, { cookie, headers: h, body: { title: `t${i}`, preferences: prefs, days: [{ placeIds: ['quba'] }] } })));
    assert.deepEqual(results.map((r) => r.statusCode), [200, 200, 200, 200, 200, 200]);
    const [days] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM trip_days WHERE trip_id = $1', [id]);
    assert.equal(days.n, 1);
  });
});
