import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { createSessions } from './auth/session';
import type { Config } from './config';
import type { Ctx } from './context';
import type { Db } from './db/client';
import { createMailer, type Mailer } from './lib/email';
import { errorHandler } from './lib/http';
import { adminModule } from './modules/admin';
import { authModule } from './modules/auth';
import { passportModule } from './modules/passport';
import { placesModule } from './modules/places';
import { tripsModule } from './modules/trips';

export interface AppOptions {
  /** Tests inject a mailer to capture or fail deliveries. */
  mailer?: Mailer;
}

export async function buildApp(db: Db, cfg: Config, opts: AppOptions = {}) {
  const app = Fastify({
    logger: cfg.NODE_ENV === 'test' ? false : { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] },
    bodyLimit: 64 * 1024,
    // Request-level timeouts (audit 3.6). Queries have their own statement_timeout.
    connectionTimeout: 15_000,
    requestTimeout: 20_000,
    trustProxy: cfg.NODE_ENV === 'production'
  });
  const ctx: Ctx = { db, sessions: createSessions(cfg, db), cfg, mailer: opts.mailer ?? createMailer(cfg, app.log) };
  const redis = cfg.REDIS_URL ? new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false }) : undefined;

  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  await app.register(cookie);
  await app.register(cors, { origin: cfg.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  // Shared store across instances when REDIS_URL is set (audit 3.2, 3.6); per-process memory otherwise.
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', enableDraftSpec: true, ...(redis ? { redis, nameSpace: 'riflo-rl:' } : {}) });
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'route_not_found', message: 'route_not_found' } }));

  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });

  for (const mod of [authModule, placesModule, tripsModule, passportModule, adminModule]) mod(app, ctx);

  // Housekeeping (audit 3.7): expired codes, old failures and dead sessions are removed hourly.
  const cleanup = async () => {
    await db.query(`DELETE FROM login_codes WHERE created_at < now() - interval '1 day'`);
    await db.query(`DELETE FROM auth_failures WHERE created_at < now() - interval '7 days'`);
    await db.query(`DELETE FROM sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`);
  };
  if (cfg.NODE_ENV !== 'test') {
    const timer = setInterval(() => cleanup().catch((e) => app.log.error(e)), 3600_000);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }
  if (redis) app.addHook('onClose', async () => void redis.quit());
  app.decorate('cleanup', cleanup);
  return app;
}
