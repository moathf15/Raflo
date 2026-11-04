/**
 * Regression tests for the RIFLO Security & Logic Audit (3 Nov 2026).
 * Each test names the audit section it covers. They were written first against
 * the unfixed code to confirm which findings were real, then kept so the issues
 * cannot come back.
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
const cfg = loadConfig({ NODE_ENV: 'test', AUTH_DEV_CODES: 'true', AUTH_RATE_LIMIT: '1000', NATIVE_CLIENTS: 'true' } as NodeJS.ProcessEnv);
const prefs = { cityId: 'madinah', startDate: '2026-12-10', endDate: '2026-12-12', travellers: 2, tripType: 'family', budgetTotal: 2000, interests: ['religious', 'history'], aroundPrayerTimes: true, relaxedPace: false };

let ipSeq = 1;
async function call(method: string, url: string, body?: unknown, token?: string, ip?: string) {
  const res = await app.inject({ method: method as 'GET', url, payload: body as object, remoteAddress: ip ?? '10.0.0.1', headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}
const newIp = () => `10.1.${Math.floor(ipSeq / 250)}.${ipSeq++ % 250}`;
async function requestCode(email: string, ip = newIp()) {
  return call('POST', '/v1/auth/request-code', { email }, undefined, ip);
}
const tokens = new Map<string, string>();
async function signIn(email: string) {
  if (tokens.has(email)) return tokens.get(email)!;
  const r = await requestCode(email);
  const v = await call('POST', '/v1/auth/native/verify', { email, code: r.body.devCode }, undefined, newIp());
  assert.equal(v.status, 200, JSON.stringify(v.body));
  tokens.set(email, v.body.token);
  return v.body.token as string;
}
async function saveTrip(token: string, p = prefs) {
  const plan = (await call('POST', '/v1/plans', { preferences: p, title: 't' }, token)).body;
  const r = await call('POST', '/v1/trips', { title: 't', preferences: p, days: plan.days.map((d: { stops: { placeId: string }[] }) => ({ placeIds: d.stops.map((s) => s.placeId) })) }, token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
const wrongCode = (c: string) => (c === '000000' ? '111111' : '000000');

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

describe('3.1 OTP attempt counting', () => {
  it('keeps failed attempts and rejects the right code after 5 wrong ones', async () => {
    const email = 'otp-five@example.com';
    const { body } = await requestCode(email);
    for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/v1/auth/verify', { email, code: wrongCode(body.devCode) }, undefined, newIp())).status, 400);
    const right = await call('POST', '/v1/auth/verify', { email, code: body.devCode }, undefined, newIp());
    assert.notEqual(right.status, 200, 'the correct code must be locked after 5 failures');
  });
  it('rejects an expired code', async () => {
    const email = 'otp-expired@example.com';
    const { body } = await requestCode(email);
    await db.query(`UPDATE login_codes SET expires_at = now() - interval '1 minute' WHERE identifier = $1`, [email]);
    assert.equal((await call('POST', '/v1/auth/verify', { email, code: body.devCode }, undefined, newIp())).status, 400);
  });
  it('rejects a reused code', async () => {
    const email = 'otp-reuse@example.com';
    const { body } = await requestCode(email);
    assert.equal((await call('POST', '/v1/auth/verify', { email, code: body.devCode }, undefined, newIp())).status, 200);
    assert.equal((await call('POST', '/v1/auth/verify', { email, code: body.devCode }, undefined, newIp())).status, 400);
  });
  it('invalidates the previous code when a new one is issued', async () => {
    const email = 'otp-new@example.com';
    const first = (await requestCode(email)).body.devCode;
    await db.query(`UPDATE login_codes SET created_at = now() - interval '2 minutes' WHERE identifier = $1`, [email]); // past the resend cooldown
    const second = (await requestCode(email)).body.devCode;
    if (first !== second) assert.equal((await call('POST', '/v1/auth/verify', { email, code: first }, undefined, newIp())).status, 400);
    assert.equal((await call('POST', '/v1/auth/verify', { email, code: second }, undefined, newIp())).status, 200);
  });
});

describe('3.2 OTP distributed guessing', () => {
  it('limits codes per email even when every request comes from a new IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      await db.query(`UPDATE login_codes SET created_at = created_at - interval '2 minutes' WHERE identifier = 'spray@example.com'`); // skip cooldown, test the hourly cap
      statuses.push((await requestCode('spray@example.com')).status);
    }
    assert.ok(statuses.includes(429), `expected a per-email limit, got ${statuses}`);
  });
  it('enforces a resend cooldown', async () => {
    assert.equal((await requestCode('cool@example.com')).status, 202);
    assert.equal((await requestCode('cool@example.com')).status, 429);
  });
});

describe('Sessions: revocation (3.7, P0)', () => {
  it('sign-out revokes the token on the server', async () => {
    const token = await signIn('logout@example.com');
    assert.equal((await call('POST', '/v1/auth/logout', {}, token)).status, 204);
    assert.equal((await call('GET', '/v1/me', undefined, token)).status, 401);
  });
});

describe('5.4 reusedFrom ownership', () => {
  it("rejects reusing another user's trip", async () => {
    const owner = await signIn('owner@example.com');
    const theirs = await saveTrip(owner);
    const attacker = await signIn('attacker@example.com');
    const plan = (await call('POST', '/v1/plans', { preferences: prefs, title: 't' }, attacker)).body;
    const r = await call('POST', '/v1/trips', { title: 't', preferences: prefs, reusedFrom: theirs.id, days: plan.days.map((d: { stops: { placeId: string }[] }) => ({ placeIds: d.stops.map((s) => s.placeId) })) }, attacker);
    assert.equal(r.status, 404);
  });
});

describe('5.3 calendar dates', () => {
  it('rejects 2026-02-30 and 2026-99-99 with 400', async () => {
    for (const bad of ['2026-02-30', '2026-99-99', '2025-02-29']) {
      const r = await call('POST', '/v1/plans', { preferences: { ...prefs, startDate: bad, endDate: bad }, title: 't' });
      assert.equal(r.status, 400, bad);
    }
  });
  it('accepts 29 February in a leap year', async () => {
    const r = await call('POST', '/v1/plans', { preferences: { ...prefs, startDate: '2028-02-28', endDate: '2028-03-01' }, title: 't' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.days.map((d: { date: string }) => d.date), ['2028-02-28', '2028-02-29', '2028-03-01']);
  });
});

describe('3.4 Passport integrity', () => {
  let token: string;
  let trip: { id: string; days: { stops: { placeId: string }[] }[] };
  before(async () => {
    token = await signIn('visits@example.com');
    trip = await saveTrip(token, { ...prefs, startDate: '2026-12-10', endDate: '2026-12-10', relaxedPace: true }); // one short day: 3 places
  });
  it('rejects a visit dated in the future', async () => {
    const r = await call('POST', '/v1/visits', { placeId: 'quba', date: '2099-01-01' }, token);
    assert.equal(r.status, 400);
  });
  it('rejects an invalid visit date with 400, not 500', async () => {
    assert.equal((await call('POST', '/v1/visits', { placeId: 'quba', date: '2026-99-99' }, token)).status, 400);
  });
  it('rejects a tripId when the place is not in that trip', async () => {
    const inTrip = new Set(trip.days.flatMap((d) => d.stops.map((s) => s.placeId)));
    const outside = ['prophets-mosque', 'quba', 'qiblatayn', 'uhud', 'seven-mosques', 'hejaz-railway', 'quba-walk'].find((p) => !inTrip.has(p));
    assert.ok(outside, 'test setup: need a published place outside the trip');
    const r = await call('POST', '/v1/visits', { placeId: outside, tripId: trip.id, date: '2026-11-01' }, token);
    assert.equal(r.status, 400);
  });
});

describe('3.5 analytics events', () => {
  it('rejects oversized props', async () => {
    const props = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, 'x'.repeat(50)]));
    assert.equal((await call('POST', '/v1/events', { name: 'plan_started', props, anonymousId: 'anon_abcdefgh12' })).status, 413, 'body over the 2 KB cap');
    const small = { cityId: 'x'.repeat(41) };
    assert.equal((await call('POST', '/v1/events', { name: 'plan_started', props: small, anonymousId: 'anon_abcdefgh12' })).status, 400, 'value over its size limit');
  });
  it('caps events per anonymous id per day', async () => {
    await db.query(`INSERT INTO events (name, anonymous_id) SELECT 'plan_started', 'anon_floodtest01' FROM generate_series(1, 300)`);
    assert.equal((await call('POST', '/v1/events', { name: 'plan_started', props: {}, anonymousId: 'anon_floodtest01' })).status, 429);
  });
  it('rejects props that are not on the allowlist', async () => {
    assert.equal((await call('POST', '/v1/events', { name: 'plan_started', props: { revenue: 99999 }, anonymousId: 'anon_abcdefgh12' })).status, 400);
  });
});

describe('6.4 audit log is atomic with the change', () => {
  it('rolls back the admin change when the audit write fails', async () => {
    const admin = await signIn('admin@riflo.local');
    await db.query(`ALTER TABLE audit_log ADD CONSTRAINT audit_fail_test CHECK (action <> 'set_status')`);
    try {
      const r = await call('PATCH', '/v1/admin/places/aqiq/status', { status: 'hidden' }, admin);
      assert.equal(r.status, 500);
      const [row] = await db.query<{ status: string }>(`SELECT status FROM places WHERE id = 'aqiq'`);
      assert.equal(row.status, 'draft', 'place must be unchanged when the audit write fails');
    } finally {
      await db.query('ALTER TABLE audit_log DROP CONSTRAINT audit_fail_test');
    }
  });
});

describe('4 admin rules', () => {
  it('editors cannot manage users; users and guests cannot reach any admin route', async () => {
    const admin = await signIn('admin@riflo.local');
    const editorEmail = 'editor@example.com';
    const editor = await signIn(editorEmail);
    const [ed] = await db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [editorEmail]);
    assert.equal((await call('PATCH', `/v1/admin/users/${ed.id}`, { role: 'editor' }, admin)).status, 200);
    const user = await signIn('plain-user@example.com');
    const routes: [string, string, unknown?][] = [
      ['GET', '/v1/admin/cities/madinah/places'], ['POST', '/v1/admin/places', {}], ['PUT', '/v1/admin/places/quba', {}], ['PATCH', '/v1/admin/places/quba/status', { status: 'hidden' }],
      ['GET', '/v1/admin/reports'], ['PATCH', '/v1/admin/reports/00000000-0000-0000-0000-000000000000', { status: 'resolved' }], ['GET', '/v1/admin/overview'], ['GET', '/v1/admin/insights'],
      ['GET', '/v1/admin/users'], ['PATCH', `/v1/admin/users/${ed.id}`, { role: 'admin' }]
    ];
    for (const [m, u, b] of routes) {
      assert.equal((await call(m, u, b)).status, 401, `guest ${m} ${u}`);
      assert.equal((await call(m, u, b, user)).status, 403, `user ${m} ${u}`);
    }
    assert.equal((await call('GET', '/v1/admin/users', undefined, editor)).status, 403);
    assert.equal((await call('PATCH', `/v1/admin/users/${ed.id}`, { role: 'admin' }, editor)).status, 403);
  });
  it('a user cannot promote themselves through their own profile', async () => {
    const user = await signIn('climber@example.com');
    const r = await call('PATCH', '/v1/me', { displayName: 'x', role: 'admin', status: 'active' }, user);
    assert.ok(r.status < 500);
    const [row] = await db.query<{ role: string }>(`SELECT role FROM users WHERE email = 'climber@example.com'`);
    assert.equal(row.role, 'user');
    assert.equal((await call('GET', '/v1/admin/users', undefined, user)).status, 403);
  });
  it('the last active admin cannot be demoted or suspended', async () => {
    const admin = await signIn('admin@riflo.local');
    const second = await signIn('second-admin@example.com');
    const [s] = await db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'second-admin@example.com'`);
    await call('PATCH', `/v1/admin/users/${s.id}`, { role: 'admin' }, admin);
    const [a] = await db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'admin@riflo.local'`);
    assert.equal((await call('PATCH', `/v1/admin/users/${a.id}`, { role: 'user' }, second)).status, 200, 'demoting one of two admins is allowed');
    assert.equal((await call('PATCH', `/v1/admin/users/${s.id}`, { status: 'suspended' }, admin)).status, 403, 'demoted admin lost access');
    await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [a.id]);
    await db.query(`UPDATE users SET role = 'user' WHERE id = $1`, [s.id]);
    const [count] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'`);
    assert.equal(count.n, 1);
    // Only one admin left: the database refuses to remove it, whatever path is used.
    await assert.rejects(db.query(`UPDATE users SET role = 'user' WHERE id = $1`, [a.id]));
  });
});

describe('5.5 reports are handled one by one', () => {
  it('publishing a place does not silently close its reports', async () => {
    const admin = await signIn('admin@riflo.local');
    await call('POST', '/v1/places/uhud/reports', { kind: 'closed', message: 'مغلق للصيانة' });
    await call('PATCH', '/v1/admin/places/uhud/status', { status: 'published' }, admin);
    const [open] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM reports WHERE place_id = 'uhud' AND status IN ('new', 'in_review', 'reopened')`);
    assert.equal(open.n, 1);
  });
  it('closing a report requires a reason and records who closed it', async () => {
    const admin = await signIn('admin@riflo.local');
    const [rep] = await db.query<{ id: string }>(`SELECT id FROM reports WHERE place_id = 'uhud' LIMIT 1`);
    assert.equal((await call('PATCH', `/v1/admin/reports/${rep.id}`, { status: 'resolved' }, admin)).status, 400);
    assert.equal((await call('PATCH', `/v1/admin/reports/${rep.id}`, { status: 'resolved', note: 'تم تحديث الأوقات' }, admin)).status, 200);
    const [row] = await db.query<{ resolution_note: string; resolved_by: string | null }>('SELECT resolution_note, resolved_by FROM reports WHERE id = $1', [rep.id]);
    assert.equal(row.resolution_note, 'تم تحديث الأوقات');
    assert.ok(row.resolved_by);
  });
  it('a place cannot be published without the minimum data', async () => {
    const admin = await signIn('admin@riflo.local');
    const r = await call('PATCH', '/v1/admin/places/aqiq/status', { status: 'published' }, admin);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'place_incomplete');
  });
});

describe('6.3 environment parsing', () => {
  it('treats "false" as false and rejects unknown values', () => {
    assert.equal(loadConfig({ AUTH_DEV_CODES: 'false' } as NodeJS.ProcessEnv).AUTH_DEV_CODES, false);
    assert.equal(loadConfig({ AUTH_DEV_CODES: 'true' } as NodeJS.ProcessEnv).AUTH_DEV_CODES, true);
    assert.throws(() => loadConfig({ AUTH_DEV_CODES: 'yes please' } as NodeJS.ProcessEnv));
  });
  it('refuses unsafe production settings', () => {
    const prod = { NODE_ENV: 'production', DATABASE_URL: 'postgres://x', JWT_SECRET: 'p'.repeat(48), RATE_LIMIT_STORE: 'memory', EMAIL_PROVIDER: 'smtp', SMTP_URL: 'smtps://u:p@mail.example.com', EMAIL_FROM: 'RIFLO <no-reply@riflo.sa>', CORS_ORIGINS: 'https://riflo.sa', TRUST_PROXY: '10.0.0.0/8' };
    assert.doesNotThrow(() => loadConfig(prod as NodeJS.ProcessEnv));
    // Security audit S1: the trusted proxies must be stated, and "trust anyone" is refused.
    assert.doesNotThrow(() => loadConfig({ ...prod, TRUST_PROXY: 'false' } as NodeJS.ProcessEnv));
    assert.throws(() => loadConfig({ ...prod, TRUST_PROXY: undefined } as NodeJS.ProcessEnv));
    assert.throws(() => loadConfig({ ...prod, TRUST_PROXY: 'true' } as NodeJS.ProcessEnv));
    assert.throws(() => loadConfig({ ...prod, TRUST_PROXY: '1' } as NodeJS.ProcessEnv));
    assert.throws(() => loadConfig({ ...prod, AUTH_DEV_CODES: 'true' } as NodeJS.ProcessEnv));
    assert.throws(() => loadConfig({ ...prod, EMAIL_PROVIDER: 'log' } as NodeJS.ProcessEnv));
    assert.throws(() => loadConfig({ ...prod, CORS_ORIGINS: 'http://localhost:5173' } as NodeJS.ProcessEnv));
  });
});
