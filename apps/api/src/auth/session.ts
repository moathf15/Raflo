import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify, SignJWT } from 'jose';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { forbidden, HttpError, unauthorized } from '../lib/http';

export type Role = 'user' | 'editor' | 'admin';
export interface SessionUser {
  id: string;
  role: Role;
  sessionId: string;
}

export const CODE_TTL_MINUTES = 10;
export const MAX_CODE_ATTEMPTS = 5;
export const COOKIE_NAME = 'riflo_session';
const TOUCH_EVERY_MS = 5 * 60_000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Sessions (audit 3.3, P0 session policy):
 * - every sign-in creates a row in `sessions`; the signed token only carries its id;
 * - a token is accepted only while its session is not revoked or expired and the user is active,
 *   so sign-out, "sign out everywhere" and suspension take effect immediately;
 * - browsers get the token in an HttpOnly, Secure, SameSite=Lax cookie (unreadable by page scripts);
 *   requests authenticated by that cookie must come from an allowed Origin when they change data (CSRF);
 * - native apps (only when NATIVE_CLIENTS is on) sign in through their own endpoint and send `Authorization: Bearer`,
 *   which is not ambient, so no CSRF check applies. A session is accepted only through the transport it was issued for.
 */
export function createSessions(cfg: Config, db: Db) {
  const key = new TextEncoder().encode(cfg.JWT_SECRET);
  const hash = (code: string) => createHash('sha256').update(`${cfg.JWT_SECRET}:${code}`).digest('hex');
  const origins = new Set(cfg.CORS_ORIGINS.split(',').map((o) => o.trim()));
  const ttlMs = cfg.SESSION_TTL_DAYS * 864e5;

  function readToken(req: FastifyRequest): { token: string; viaCookie: boolean } | null {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      if (!cfg.NATIVE_CLIENTS) throw unauthorized();
      return { token: header.slice(7), viaCookie: false };
    }
    const cookie = req.cookies?.[COOKIE_NAME];
    return cookie ? { token: cookie, viaCookie: true } : null;
  }

  /** The origin of a Referer header, or undefined when it is missing or not a URL (audit S5: was a 500). */
  function refererOrigin(referer: string | undefined): string | undefined {
    if (!referer) return undefined;
    try {
      return new URL(referer).origin;
    } catch {
      return undefined;
    }
  }

  function checkOrigin(req: FastifyRequest) {
    if (SAFE_METHODS.has(req.method)) return;
    const origin = req.headers.origin ?? refererOrigin(req.headers.referer);
    if (!origin || !origins.has(origin)) throw new HttpError(403, 'csrf_origin');
  }

  /**
   * Requests that arrived with a session cookie that is no longer valid (bad signature, revoked, expired, user
   * suspended). They are treated as guests and the app clears the cookie on the response (audit S3), so a revoked
   * session cannot keep a browser out of guest features and sign-out can always remove it.
   */
  const stale = new WeakSet<FastifyRequest>();
  const staleCookie = (req: FastifyRequest) => {
    stale.add(req);
    return null;
  };

  return {
    newCode: () => String(randomInt(0, 1_000_000)).padStart(6, '0'),
    hashCode: hash,
    codeMatches(code: string, stored: string) {
      const a = Buffer.from(hash(code));
      const b = Buffer.from(stored);
      return a.length === b.length && timingSafeEqual(a, b);
    },

    /** Create a session row and its signed token. */
    async start(dbx: Db, userId: string, req: FastifyRequest, transport: 'cookie' | 'bearer') {
      const [s] = await dbx.query<{ id: string; expires_at: Date }>(
        `INSERT INTO sessions (user_id, expires_at, user_agent, ip, transport) VALUES ($1, now() + make_interval(secs => $2), $3, $4, $5) RETURNING id, expires_at`,
        [userId, ttlMs / 1000, String(req.headers['user-agent'] ?? '').slice(0, 200), req.ip, transport]
      );
      const token = await new SignJWT({ sid: s.id }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime(Math.floor(new Date(s.expires_at).getTime() / 1000)).sign(key);
      return { token, expiresAt: new Date(s.expires_at) };
    },
    setCookie(reply: FastifyReply, token: string, expiresAt: Date) {
      reply.setCookie(COOKIE_NAME, token, { httpOnly: true, secure: cfg.COOKIE_SECURE, sameSite: 'lax', path: '/', domain: cfg.COOKIE_DOMAIN, expires: expiresAt });
    },
    clearCookie(reply: FastifyReply) {
      reply.clearCookie(COOKIE_NAME, { path: '/', domain: cfg.COOKIE_DOMAIN });
    },
    revoke: (sessionId: string) => db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]),
    revokeAll: (dbx: Db, userId: string) => dbx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]),

    /**
     * The signed-in user, or null for guests.
     * - A cookie that is no longer valid makes the request a guest one, and the cookie is cleared (audit S3).
     * - A bearer token that is no longer valid is a 401: native clients send it on purpose and must sign in again.
     */
    async optional(req: FastifyRequest): Promise<SessionUser | null> {
      const found = readToken(req);
      if (!found) return null;
      const invalid = () => (found.viaCookie ? staleCookie(req) : Promise.reject(unauthorized()));
      let sub: string | undefined;
      let sid: unknown;
      try {
        const { payload } = await jwtVerify(found.token, key, { algorithms: ['HS256'] });
        sub = payload.sub;
        sid = payload.sid;
      } catch {
        return invalid();
      }
      if (typeof sid !== 'string' || typeof sub !== 'string') return invalid();
      // CSRF: a valid cookie on a write must come from an allowed origin. Checked before any session lookup.
      if (found.viaCookie) checkOrigin(req);
      const [row] = await db.query<{ role: Role; status: string; last_used_at: Date }>(
        `SELECT u.role, u.status, s.last_used_at FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now() AND s.transport = $3`,
        [sid, sub, found.viaCookie ? 'cookie' : 'bearer']
      );
      if (!row || row.status !== 'active') return invalid();
      if (Date.now() - new Date(row.last_used_at).getTime() > TOUCH_EVERY_MS) await db.query('UPDATE sessions SET last_used_at = now() WHERE id = $1', [sid]);
      return { id: sub, role: row.role, sessionId: sid };
    },
    /** True when this request carried a session cookie that is no longer valid (the app then clears it). */
    hasStaleCookie: (req: FastifyRequest) => stale.has(req),
    async required(req: FastifyRequest): Promise<SessionUser> {
      const u = await this.optional(req);
      if (!u) throw unauthorized();
      return u;
    },
    async role(req: FastifyRequest, ...roles: Role[]): Promise<SessionUser> {
      const u = await this.required(req);
      if (!roles.includes(u.role)) throw forbidden();
      return u;
    }
  };
}

export type Sessions = ReturnType<typeof createSessions>;
