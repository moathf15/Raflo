import type { FastifyReply, FastifyRequest } from 'fastify';
import { allowedOrigins, type Config } from './config';
import type { Db } from './db/client';
import { randomToken, sha256 } from './lib/crypto';
import { HttpError } from './lib/http';

export const COOKIE = 'hq_session';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface Owner {
  id: string;
  email: string;
  role: 'owner' | 'viewer';
  sessionId: string;
}

/**
 * Owner sessions: a random token in an HttpOnly, SameSite=Strict cookie; only its SHA-256 is stored, so a database
 * leak does not leak sessions. Writes must carry the X-HQ-CSRF header and, when the browser sends one, an allowed
 * Origin; cross-site forms can do neither.
 */
export function createAuth(cfg: Config, db: Db) {
  const origins = allowedOrigins(cfg);
  const ttlMs = cfg.HQ_SESSION_TTL_HOURS * 3600_000;

  function checkCsrf(req: FastifyRequest) {
    if (SAFE.has(req.method)) return;
    if (req.headers['x-hq-csrf'] !== '1') throw new HttpError(403, 'csrf');
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) throw new HttpError(403, 'csrf_origin');
  }

  return {
    checkCsrf,
    async start(reply: FastifyReply, req: FastifyRequest, ownerId: string) {
      const token = randomToken();
      const expires = new Date(Date.now() + ttlMs);
      await db.query('INSERT INTO hq_sessions (owner_id, token_hash, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5)', [
        ownerId,
        sha256(token),
        expires,
        req.ip,
        String(req.headers['user-agent'] ?? '').slice(0, 200)
      ]);
      reply.setCookie(COOKIE, token, { httpOnly: true, secure: cfg.COOKIE_SECURE, sameSite: 'strict', path: '/', expires });
    },
    async end(req: FastifyRequest, reply: FastifyReply) {
      const token = req.cookies?.[COOKIE];
      if (token) await db.query('UPDATE hq_sessions SET revoked_at = now() WHERE token_hash = $1', [sha256(token)]);
      reply.clearCookie(COOKIE, { path: '/' });
    },
    async optional(req: FastifyRequest): Promise<Owner | null> {
      const token = req.cookies?.[COOKIE];
      if (!token) return null;
      const [row] = await db.query<{ id: string; email: string; role: 'owner' | 'viewer'; sid: string }>(
        `SELECT o.id, o.email, o.role, s.id AS sid FROM hq_sessions s JOIN hq_owners o ON o.id = s.owner_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
        [sha256(token)]
      );
      if (!row) return null;
      return { id: row.id, email: row.email, role: row.role, sessionId: row.sid };
    },
    /** Any signed-in user (owner or viewer). */
    async viewer(req: FastifyRequest): Promise<Owner> {
      checkCsrf(req);
      const o = await this.optional(req);
      if (!o) throw new HttpError(401, 'unauthorized');
      return o;
    },
    /** The owner: required for every change. */
    async owner(req: FastifyRequest): Promise<Owner> {
      const o = await this.viewer(req);
      if (o.role !== 'owner') throw new HttpError(403, 'forbidden');
      return o;
    }
  };
}

export type Auth = ReturnType<typeof createAuth>;
