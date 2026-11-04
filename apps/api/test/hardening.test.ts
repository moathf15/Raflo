/** Tests for controls added after the audit that the audit's acceptance list doesn't spell out. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { generatePlan, prayerTimes, rankPlaces, SAMPLE_PLACES, scheduleDay, type Place, type TripPreferences } from '@riflo/core';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import type { Db } from '../src/db/client';
import { testDb } from './db';
import { migrate } from '../src/db/migrate';
import { seed } from '../src/db/seed';
import type { Mailer } from '../src/lib/email';

const ORIGIN = 'http://localhost:5173';
let app: FastifyInstance;
let db: Db;
let mailerFails = false;
const sent: { to: string; code: string }[] = [];
const mailer: Mailer = {
  async sendLoginCode(to, code) {
    if (mailerFails) throw new Error('smtp down');
    sent.push({ to, code });
  }
};

before(async () => {
  db = await testDb();
  await migrate(db);
  await seed(db);
  app = await buildApp(db, loadConfig({ NODE_ENV: 'test', AUTH_RATE_LIMIT: '1000', CORS_ORIGINS: ORIGIN, NATIVE_CLIENTS: 'true' } as NodeJS.ProcessEnv), { mailer });
});
after(async () => {
  await app.close();
  await db.close();
});

const inject = (method: string, url: string, opts: { body?: unknown; cookie?: string; origin?: string; ip?: string } = {}) =>
  app.inject({ method: method as 'GET', url, payload: opts.body as object, remoteAddress: opts.ip ?? '10.5.0.1', headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.origin ? { origin: opts.origin } : {}) } });

async function cookieSignIn(email: string) {
  await inject('POST', '/v1/auth/request-code', { body: { email } });
  const code = sent.filter((s) => s.to === email).at(-1)!.code;
  const res = await inject('POST', '/v1/auth/verify', { body: { email, code } });
  assert.equal(res.statusCode, 200);
  const set = String(res.headers['set-cookie']);
  return set.split(';')[0]; // riflo_session=…
}

describe('email delivery', () => {
  it('codes reach the mailer, not the response', async () => {
    const r = await inject('POST', '/v1/auth/request-code', { body: { email: 'mail@example.com' } });
    assert.equal(r.statusCode, 202);
    assert.equal(r.json().devCode, undefined);
    assert.match(sent.at(-1)!.code, /^\d{6}$/);
  });
  it('a provider failure answers 503 and leaves no usable code', async () => {
    mailerFails = true;
    const r = await inject('POST', '/v1/auth/request-code', { body: { email: 'down@example.com' } });
    mailerFails = false;
    assert.equal(r.statusCode, 503);
    const [n] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM login_codes WHERE identifier = 'down@example.com'`);
    assert.equal(n.n, 0);
  });
});

describe('cookie session and CSRF', () => {
  it('a cookie-authenticated change must come from an allowed origin', async () => {
    const cookie = await cookieSignIn('csrf@example.com');
    assert.equal((await inject('GET', '/v1/me', { cookie })).statusCode, 200, 'reads need no origin');
    assert.equal((await inject('GET', '/v1/session', { cookie })).json().user.email, 'csrf@example.com');
    assert.deepEqual((await inject('GET', '/v1/session')).json(), { user: null }, 'guests get 200 with no user');
    assert.equal((await inject('PATCH', '/v1/me', { cookie, body: { displayName: 'x' } })).statusCode, 403, 'no Origin header');
    assert.equal((await inject('PATCH', '/v1/me', { cookie, origin: 'https://evil.example', body: { displayName: 'x' } })).statusCode, 403, 'foreign origin');
    assert.equal((await inject('PATCH', '/v1/me', { cookie, origin: ORIGIN, body: { displayName: 'سارة' } })).statusCode, 200);
  });
  it('sign out everywhere ends every session', async () => {
    const a = await cookieSignIn('everywhere@example.com');
    await db.query(`UPDATE login_codes SET created_at = now() - interval '2 minutes' WHERE identifier = 'everywhere@example.com'`);
    const b = await cookieSignIn('everywhere@example.com');
    assert.equal((await inject('POST', '/v1/auth/logout-all', { cookie: a, origin: ORIGIN, body: {} })).statusCode, 204);
    assert.equal((await inject('GET', '/v1/me', { cookie: b })).statusCode, 401);
  });
});

describe('progressive lockout', () => {
  it('locks an email after 10 failures across codes, even from many IPs', async () => {
    const email = 'locked@example.com';
    await db.query(`INSERT INTO auth_failures (identifier, ip) SELECT $1, '10.6.0.' || g FROM generate_series(1, 10) g`, [email]);
    const r = await inject('POST', '/v1/auth/request-code', { body: { email }, ip: '10.7.7.7' });
    assert.equal(r.statusCode, 429);
    assert.equal(r.json().error.code, 'too_many_attempts');
    assert.ok(Number(r.headers['retry-after']) > 0);
  });
});

describe('returning-user prefill', () => {
  it('a guest who plans first and signs in to save still gets the next trip pre-filled', async () => {
    const prefs = { cityId: 'madinah', startDate: '2026-12-01', endDate: '2026-12-01', travellers: 3, tripType: 'friends', budgetTotal: 900, interests: ['history'], aroundPrayerTimes: false, relaxedPace: true };
    const plan = (await app.inject({ method: 'POST', url: '/v1/plans', payload: { preferences: prefs, title: 't' } })).json(); // as a guest
    await inject('POST', '/v1/auth/request-code', { body: { email: 'guest-then-save@example.com' } });
    const token = (await app.inject({ method: 'POST', url: '/v1/auth/native/verify', payload: { email: 'guest-then-save@example.com', code: sent.at(-1)!.code } })).json().token;
    const auth = { authorization: `Bearer ${token}` };
    const saved = await app.inject({ method: 'POST', url: '/v1/trips', headers: auth, payload: { title: 't', preferences: prefs, days: plan.days.map((d: { stops: { placeId: string }[] }) => ({ placeIds: d.stops.map((s) => s.placeId) })) } });
    assert.equal(saved.statusCode, 201);
    const passport = (await app.inject({ method: 'GET', url: '/v1/passport', headers: auth })).json();
    assert.deepEqual(passport.lastPreferences.interests, ['history']);
    assert.equal(passport.lastPreferences.travellers, 3);
  });
});

describe('planner rules (audit 5.1, 5.2)', () => {
  const madinah = { lat: 24.4672, lng: 39.6112 };
  const prefs: TripPreferences = { cityId: 'madinah', startDate: '2026-11-10', endDate: '2026-11-12', travellers: 2, tripType: 'family', budgetTotal: 2000, interests: ['religious', 'history'], aroundPrayerTimes: true, relaxedPace: false };
  const prayers = (d: string) => prayerTimes(madinah, 'Asia/Riyadh', d);
  const byId = new Map(SAMPLE_PLACES.map((p) => [p.id, p]));

  it('uses prayer times for each date', () => {
    const nov = prayers('2026-11-10').find((p) => p.prayer === 'maghrib')!.at;
    const jun = prayers('2026-06-21').find((p) => p.prayer === 'maghrib')!.at;
    assert.ok(jun - nov > 60, 'Maghrib is over an hour later in June than in November');
  });

  it('never overlaps a prayer break with a visit, except inside a mosque', () => {
    const plan = generatePlan({ preferences: prefs, places: SAMPLE_PLACES, prayerTimes: prayers, title: 't' });
    for (const day of plan.days) {
      for (const [i, s] of day.stops.entries()) {
        const p = byId.get(s.placeId)!;
        for (const b of day.breaks.filter((x) => !x.atPlace)) {
          const end = s.start + p.visitMinutes;
          assert.ok(b.until <= s.start || b.at >= end, `break ${b.prayer} overlaps ${p.id} on ${day.date}`);
        }
        if (day.breaks.some((x) => x.atPlace && x.afterStop === i)) assert.equal(p.category, 'religious', 'only mosques host a prayer during a visit');
      }
    }
  });

  it('waits for opening time and flags visits that would end after closing', () => {
    const museum: Place = { ...byId.get('hejaz-railway')!, id: 'test-museum', hours: { open: 16 * 60, close: 18 * 60 }, visitMinutes: 60 };
    const map = new Map([...byId, ['test-museum', museum]]);
    const day = scheduleDay('2026-11-10', ['quba', 'test-museum'], map, { ...prefs, aroundPrayerTimes: false }, []);
    assert.equal(day.stops[1].start, 16 * 60, 'arrives early, starts at opening');
    const late: Place = { ...museum, hours: { open: 8 * 60, close: 9 * 60 + 30 } };
    const day2 = scheduleDay('2026-11-10', ['prophets-mosque', 'test-museum'], new Map([...byId, ['test-museum', late]]), { ...prefs, aroundPrayerTimes: false }, []);
    assert.equal(day2.stops[1].warning, 'outside_hours');
  });

  it('the generated plan never schedules a place outside its hours', () => {
    const shortHours = SAMPLE_PLACES.map((p) => (p.id === 'quba' ? { ...p, hours: { open: 18 * 60, close: 19 * 60 } } : p));
    const plan = generatePlan({ preferences: prefs, places: shortHours, prayerTimes: prayers, title: 't' });
    assert.ok(plan.days.every((d) => d.stops.every((s) => s.warning !== 'outside_hours')));
  });

  it('alternates between the chosen interests instead of following data order', () => {
    const order = rankPlaces(SAMPLE_PLACES, prefs).slice(0, 4).map((p) => p.category);
    assert.deepEqual(order, ['religious', 'history', 'religious', 'history']);
  });

  it('rejects the same place twice in one day', async () => {
    await inject('POST', '/v1/auth/request-code', { body: { email: 'dup@example.com' } });
    const code = sent.at(-1)!.code;
    const token = (await app.inject({ method: 'POST', url: '/v1/auth/native/verify', payload: { email: 'dup@example.com', code } })).json().token;
    const r = await app.inject({ method: 'POST', url: '/v1/trips', headers: { authorization: `Bearer ${token}` }, payload: { title: 't', preferences: { ...prefs, endDate: prefs.startDate }, days: [{ placeIds: ['quba', 'uhud', 'quba'] }] } });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error.code, 'duplicate_place');
  });
});
