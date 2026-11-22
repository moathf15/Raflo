import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Auth } from '../auth';
import type { Ctx } from '../context';
import { verifyPassword, hashPassword } from '../lib/crypto';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/http';

export type Module = (app: FastifyInstance, ctx: Ctx, auth: Auth, extra: { setupCode: () => string | null }) => void;

export const Uuid = z.uuid();
export const idParam = (p: unknown) => z.object({ id: Uuid }).parse(p).id;

/** Sign-in, first-owner setup and the current session. */
export const authModule: Module = (app, ctx, auth, extra) => {
  app.get('/hq/v1/auth/state', async (req) => {
    const [{ n }] = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM hq_owners');
    const me = await auth.optional(req);
    return { needsSetup: n === 0, me: me ? { id: me.id, email: me.email, role: me.role } : null };
  });

  app.post('/hq/v1/auth/setup', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    auth.checkCsrf(req);
    const b = z.object({ email: z.email().max(200), password: z.string().min(12).max(200), name: z.string().min(1).max(100), setupCode: z.string().min(6).max(100) }).parse(req.body);
    const code = extra.setupCode();
    if (!code || b.setupCode.trim() !== code) throw new HttpError(403, 'invalid_setup_code', 'The setup code is printed in the HQ API log when no owner exists.');
    const owner = await ctx.db.tx(async (t) => {
      const [{ n }] = await t.query<{ n: number }>('SELECT count(*)::int AS n FROM hq_owners');
      if (n > 0) throw new HttpError(409, 'already_set_up');
      const [o] = await t.query<{ id: string }>(`INSERT INTO hq_owners (email, display_name, password_hash, role) VALUES ($1, $2, $3, 'owner') RETURNING id`, [
        b.email.toLowerCase(),
        b.name,
        await hashPassword(b.password)
      ]);
      return o;
    });
    await audit(ctx.db, { type: 'owner', id: owner.id }, 'owner.setup', 'owner', owner.id);
    await auth.start(reply, req, owner.id);
    return { ok: true };
  });

  app.post('/hq/v1/auth/login', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    auth.checkCsrf(req);
    const b = z.object({ email: z.string().max(200), password: z.string().max(200) }).parse(req.body);
    const key = `${req.ip}|${b.email.toLowerCase()}`;
    const [{ n }] = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM hq_login_failures WHERE key = $1 AND created_at > now() - interval '15 minutes'`, [key]);
    if (n >= 5) throw new HttpError(429, 'too_many_attempts', 'Too many failed attempts. Try again in 15 minutes.', { retryAfterSeconds: 900 });
    const [o] = await ctx.db.query<{ id: string; password_hash: string }>('SELECT id, password_hash FROM hq_owners WHERE email = $1', [b.email.toLowerCase()]);
    // Same work whether or not the account exists.
    const ok = o ? await verifyPassword(b.password, o.password_hash) : (await verifyPassword(b.password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='), false);
    if (!o || !ok) {
      await ctx.db.query('INSERT INTO hq_login_failures (key) VALUES ($1)', [key]);
      throw new HttpError(401, 'invalid_credentials');
    }
    await ctx.db.query('DELETE FROM hq_login_failures WHERE key = $1', [key]);
    await auth.start(reply, req, o.id);
    await audit(ctx.db, { type: 'owner', id: o.id }, 'owner.login', 'owner', o.id, { ip: req.ip });
    return { ok: true };
  });

  app.post('/hq/v1/auth/logout', async (req, reply) => {
    auth.checkCsrf(req);
    await auth.end(req, reply);
    return { ok: true };
  });
};
