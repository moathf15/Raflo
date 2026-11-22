import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { createAuth } from './auth';
import type { Ctx } from './context';
import { errorHandler } from './lib/http';
import { authModule } from './modules/core';
import { commsModule } from './modules/comms';
import { dashboardModule } from './modules/dashboard';
import { githubModule } from './modules/github';
import { meetingsModule } from './modules/meetings';
import { orgModule } from './modules/org';
import { settingsModule } from './modules/settings';
import { tasksModule } from './modules/tasks';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' };

export async function buildApp(ctx: Ctx, opts: { setupCode?: () => string | null } = {}) {
  const app = Fastify({
    logger: ctx.cfg.NODE_ENV === 'test' ? false : { level: 'info', redact: ['req.headers.cookie', 'res.headers["set-cookie"]'] },
    bodyLimit: 512 * 1024
  });
  const auth = createAuth(ctx.cfg, ctx.db);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https://avatars.githubusercontent.com'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"]
      }
    }
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  app.setErrorHandler(errorHandler);
  app.get('/hq/v1/health', async () => {
    await ctx.db.query('SELECT 1');
    return { ok: true };
  });
  const extra = { setupCode: opts.setupCode ?? (() => null) };
  for (const mod of [authModule, orgModule, tasksModule, meetingsModule, commsModule, githubModule, settingsModule, dashboardModule]) mod(app, ctx, auth, extra);

  // The built frontend (single-page app), when configured.
  const dir = ctx.cfg.HQ_STATIC_DIR ? resolve(ctx.cfg.HQ_STATIC_DIR) : null;
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/hq/v1/') || !dir || req.method !== 'GET') return reply.status(404).send({ error: { code: 'route_not_found', message: 'route_not_found' } });
    const path = normalize(join(dir, decodeURIComponent(req.url.split('?')[0])));
    const file = path.startsWith(dir) && existsSync(path) && statSync(path).isFile() ? path : join(dir, 'index.html');
    if (!existsSync(file)) return reply.status(404).send('Frontend not built');
    reply.header('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    if (file.includes('/assets/')) reply.header('cache-control', 'public, max-age=31536000, immutable');
    return reply.send(readFileSync(file));
  });
  return app;
}
