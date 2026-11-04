import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CODE_TTL_MINUTES, MAX_CODE_ATTEMPTS, type Role } from '../auth/session';
import { lockKey, type Module } from '../context';
import type { Db } from '../db/client';
import { maskEmail } from '../lib/email';
import { HttpError } from '../lib/http';

const Email = z.string().trim().toLowerCase().email().max(200);

/** Per-email limits stored in the database, so they hold across IPs and API instances (audit 3.2). */
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_CODES_PER_HOUR = 5;

/**
 * Progressive lockout from failures in the last 24h, across all codes for that email:
 * 10+ → 15 minutes after the last failure, 20+ → 1 hour, 30+ → 24 hours.
 */
async function lockedForSeconds(db: Db, email: string): Promise<number> {
  const [f] = await db.query<{ n: number; last: Date | null }>(`SELECT count(*)::int AS n, max(created_at) AS last FROM auth_failures WHERE identifier = $1 AND created_at > now() - interval '24 hours'`, [email]);
  if (!f.last || f.n < 10) return 0;
  const lockMs = (f.n >= 30 ? 24 * 60 : f.n >= 20 ? 60 : 15) * 60_000;
  return Math.max(0, Math.ceil((new Date(f.last).getTime() + lockMs - Date.now()) / 1000));
}

export const authModule: Module = (app, { db, sessions, cfg, mailer }) => {
  const perIp = { config: { rateLimit: { max: cfg.AUTH_RATE_LIMIT, timeWindow: '10 minutes' } } };
  const tooMany = (code: string, retryAfter: number) => new HttpError(429, code, `retry after ${retryAfter}s`, { retryAfterSeconds: retryAfter });

  /**
   * Step 1: send a 6-digit code. Same answer whether or not an account exists.
   * The cooldown and hourly limits are checked and the code inserted in one transaction holding a lock
   * on the email, so concurrent requests cannot all pass the check (review 3: quota race).
   */
  app.post('/v1/auth/request-code', perIp, async (req, reply) => {
    const { email } = z.object({ email: Email }).parse(req.body);

    const lock = await lockedForSeconds(db, email);
    if (lock) throw tooMany('too_many_attempts', lock);

    const code = sessions.newCode();
    const id = await db.tx(async (t) => {
      await lockKey(t, `otp:${email}`);
      const [recent] = await t.query<{ last: Date | null; hour: number }>(
        `SELECT max(created_at) AS last, count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour FROM login_codes WHERE identifier = $1`,
        [email]
      );
      if (recent.last) {
        const wait = RESEND_COOLDOWN_SECONDS - Math.floor((Date.now() - new Date(recent.last).getTime()) / 1000);
        if (wait > 0) throw tooMany('resend_too_soon', wait);
      }
      if (recent.hour >= MAX_CODES_PER_HOUR) throw tooMany('too_many_codes', 3600);
      // Issuing a new code invalidates every earlier one (audit 3.1).
      await t.query(`UPDATE login_codes SET invalidated_at = now() WHERE identifier = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`, [email]);
      const [row] = await t.query<{ id: string }>(`INSERT INTO login_codes (identifier, code_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3)) RETURNING id`, [email, sessions.hashCode(code), CODE_TTL_MINUTES]);
      return row.id;
    });
    try {
      await mailer.sendLoginCode(email, code, CODE_TTL_MINUTES);
    } catch (e) {
      await db.query('DELETE FROM login_codes WHERE id = $1', [id]);
      req.log.error({ event: 'login_code_send_failed', to: maskEmail(email), err: (e as Error).message });
      throw new HttpError(503, 'email_unavailable');
    }
    return reply.status(202).send(cfg.AUTH_DEV_CODES ? { sent: true, devCode: code } : { sent: true });
  });

  /**
   * Step 2: exchange the code for a session.
   * - Each guess first reserves one attempt with a conditional UPDATE (attempts < 5), and only then compares,
   *   so parallel guesses can never get more than 5 comparisons per code (review 3).
   * - Failures are written outside any transaction, so an error can never roll the count back (audit 3.1).
   * - The successful code is consumed with a conditional UPDATE, so it works exactly once even under races.
   */
  async function verify(req: FastifyRequest, email: string, code: string, transport: 'cookie' | 'bearer') {
    const lock = await lockedForSeconds(db, email);
    if (lock) throw tooMany('too_many_attempts', lock);

    const fail = async () => {
      await db.query('INSERT INTO auth_failures (identifier, ip) VALUES ($1, $2)', [email, req.ip]);
      req.log.warn({ event: 'login_code_failed', to: maskEmail(email), ip: req.ip });
      return new HttpError(400, 'code_invalid');
    };

    const [row] = await db.query<{ id: string; code_hash: string }>(
      `UPDATE login_codes SET attempts = attempts + 1
       WHERE id = (SELECT id FROM login_codes
                   WHERE identifier = $1 AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > now()
                   ORDER BY created_at DESC LIMIT 1)
         AND attempts < $2 AND consumed_at IS NULL AND invalidated_at IS NULL
       RETURNING id, code_hash`,
      [email, MAX_CODE_ATTEMPTS]
    );
    if (!row) throw await fail();
    if (!sessions.codeMatches(code, row.code_hash)) throw await fail();

    return db.tx(async (t) => {
      const consumed = await t.query(
        `UPDATE login_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > now() RETURNING id`,
        [row.id]
      );
      if (!consumed.length) throw new HttpError(400, 'code_invalid');
      const [user] = await t.query<{ id: string; role: Role; status: string; display_name: string | null }>(
        `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET last_seen_at = now() RETURNING id, role, status, display_name`,
        [email]
      );
      if (user.status !== 'active') throw new HttpError(403, 'account_suspended');
      const session = await sessions.start(t, user.id, req, transport);
      return { user: { id: user.id, email, displayName: user.display_name, role: user.role }, session };
    });
  }

  const VerifyBody = z.object({ email: Email, code: z.string().regex(/^\d{6}$/) }).strict();

  /** Browsers: the session is set as an HttpOnly cookie and never appears in the response body. */
  app.post('/v1/auth/verify', perIp, async (req, reply) => {
    const { email, code } = VerifyBody.parse(req.body);
    const { user, session } = await verify(req, email, code, 'cookie');
    sessions.setCookie(reply, session.token, session.expiresAt);
    return { user };
  });

  /**
   * Native apps only (review 3: bearer path). Disabled unless NATIVE_CLIENTS is on.
   * Refuses any request carrying an Origin, which every browser sends on a POST, so a web page cannot obtain a token here.
   * The session it creates is accepted only as `Authorization: Bearer`, never as a cookie.
   */
  app.post('/v1/auth/native/verify', perIp, async (req) => {
    if (!cfg.NATIVE_CLIENTS) throw new HttpError(404, 'not_found');
    if (req.headers.origin || req.headers['sec-fetch-site']) throw new HttpError(403, 'browser_not_allowed');
    const { email, code } = VerifyBody.parse(req.body);
    const { user, session } = await verify(req, email, code, 'bearer');
    return { user, token: session.token, expiresAt: session.expiresAt.toISOString() };
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const u = await sessions.optional(req);
    if (u) await sessions.revoke(u.sessionId);
    sessions.clearCookie(reply);
    return reply.status(204).send();
  });

  /** Sign out on every device. */
  app.post('/v1/auth/logout-all', async (req, reply) => {
    const u = await sessions.required(req);
    await sessions.revokeAll(db, u.id);
    sessions.clearCookie(reply);
    return reply.status(204).send();
  });

  /** Who is signed in, if anyone. 200 with user: null for guests (the cookie is HttpOnly, so the app must ask). */
  app.get('/v1/session', async (req) => {
    const u = await sessions.optional(req).catch(() => null);
    if (!u) return { user: null };
    const [row] = await db.query<{ id: string; email: string; display_name: string | null; role: Role }>('SELECT id, email, display_name, role FROM users WHERE id = $1', [u.id]);
    return { user: { id: row.id, email: row.email, displayName: row.display_name, role: row.role } };
  });

  app.get('/v1/me', async (req) => {
    const u = await sessions.required(req);
    const [row] = await db.query<{ id: string; email: string; display_name: string | null; role: Role }>('SELECT id, email, display_name, role FROM users WHERE id = $1', [u.id]);
    return { id: row.id, email: row.email, displayName: row.display_name, role: row.role };
  });

  app.patch('/v1/me', async (req) => {
    const u = await sessions.required(req);
    const { displayName } = z.object({ displayName: z.string().trim().min(1).max(60) }).parse(req.body);
    await db.query('UPDATE users SET display_name = $2 WHERE id = $1', [u.id, displayName]);
    return { displayName };
  });

  /** Right to erasure (PDPL): deletes the account and everything that belongs to it. */
  app.delete('/v1/me', async (req, reply) => {
    const u = await sessions.required(req);
    await db.query('DELETE FROM users WHERE id = $1', [u.id]);
    sessions.clearCookie(reply);
    return reply.status(204).send();
  });
};
