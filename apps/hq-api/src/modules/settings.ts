import { z } from 'zod';
import { audit } from '../lib/audit';
import { maskSecret } from '../lib/crypto';
import { HttpError, notFound } from '../lib/http';
import { getSetting, setSetting, SETTING_KEYS, type SettingKey } from '../lib/settings';
import type { ProviderRow } from '../providers/registry';
import { idParam, type Module } from './core';

const ProviderInput = z.object({
  kind: z.enum(['anthropic', 'openai']),
  label: z.string().min(1).max(60),
  model: z.string().min(1).max(100),
  api_key: z.string().min(10).max(500),
  base_url: z.url().nullable().default(null),
  temperature: z.number().min(0).max(2).nullable().default(null),
  max_tokens: z.number().int().min(256).max(128_000).default(16_000),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().default(null),
  is_default: z.boolean().default(false),
  enabled: z.boolean().default(true)
});

const publicProvider = (r: ProviderRow & { last_check: unknown; created_at: string }, key: string) => ({
  id: r.id,
  kind: r.kind,
  label: r.label,
  model: r.model,
  base_url: r.base_url,
  temperature: r.temperature == null ? null : Number(r.temperature),
  max_tokens: r.max_tokens,
  effort: r.effort,
  is_default: r.is_default,
  enabled: r.enabled,
  last_check: r.last_check,
  api_key: maskSecret(key),
  created_at: r.created_at
});

export const settingsModule: Module = (app, ctx, auth) => {
  app.get('/hq/v1/settings', async (req) => {
    await auth.viewer(req);
    const out: Record<string, unknown> = {};
    for (const k of SETTING_KEYS) out[k] = await getSetting(ctx.db, k);
    return out;
  });

  app.put('/hq/v1/settings/:key', async (req) => {
    const o = await auth.owner(req);
    const { key } = z.object({ key: z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]) }).parse(req.params);
    const before = await getSetting(ctx.db, key);
    const value = await setSetting(ctx.db, key, req.body);
    await audit(ctx.db, { type: 'owner', id: o.id }, 'settings.update', 'settings', key, { before, after: value });
    ctx.wake();
    return value;
  });

  // AI providers. API keys are encrypted at rest and never returned.
  app.get('/hq/v1/providers', async (req) => {
    await auth.viewer(req);
    const rows = await ctx.db.query<ProviderRow & { last_check: unknown; created_at: string }>('SELECT * FROM hq_providers ORDER BY created_at');
    return rows.map((r) => publicProvider(r, ctx.vault.decrypt(r.api_key_enc)));
  });

  app.post('/hq/v1/providers', async (req) => {
    const o = await auth.owner(req);
    const b = ProviderInput.parse(req.body);
    if (b.kind === 'anthropic' && b.temperature != null) throw new HttpError(400, 'temperature_unsupported', 'Current Claude models do not accept temperature.');
    const [{ n }] = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM hq_providers');
    const isDefault = b.is_default || n === 0;
    const id = await ctx.db.tx(async (t) => {
      if (isDefault) await t.query('UPDATE hq_providers SET is_default = false');
      const [r] = await t.query<{ id: string }>(
        `INSERT INTO hq_providers (kind, label, model, api_key_enc, base_url, temperature, max_tokens, effort, is_default, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [b.kind, b.label, b.model, ctx.vault.encrypt(b.api_key), b.base_url, b.temperature, b.max_tokens, b.effort, isDefault, b.enabled]
      );
      return r.id;
    });
    await audit(ctx.db, { type: 'owner', id: o.id }, 'provider.create', 'provider', id, { kind: b.kind, model: b.model, label: b.label });
    ctx.bus.emit({ type: 'providers.changed' });
    return { id };
  });

  app.patch('/hq/v1/providers/:id', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    const b = ProviderInput.partial().omit({ kind: true }).parse(req.body);
    const [cur] = await ctx.db.query<ProviderRow>('SELECT * FROM hq_providers WHERE id = $1', [id]);
    if (!cur) throw notFound();
    if (cur.kind === 'anthropic' && b.temperature != null) throw new HttpError(400, 'temperature_unsupported');
    const { api_key, ...rest } = b;
    const sets: Record<string, unknown> = { ...rest };
    if (api_key) sets.api_key_enc = ctx.vault.encrypt(api_key);
    await ctx.db.tx(async (t) => {
      if (b.is_default) await t.query('UPDATE hq_providers SET is_default = false');
      const keys = Object.keys(sets);
      if (keys.length) await t.query(`UPDATE hq_providers SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => sets[k])]);
    });
    await audit(ctx.db, { type: 'owner', id: o.id }, 'provider.update', 'provider', id, { ...rest, api_key_changed: !!api_key });
    ctx.bus.emit({ type: 'providers.changed' });
    return { ok: true };
  });

  app.delete('/hq/v1/providers/:id', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    await ctx.db.query('UPDATE hq_employees SET provider_id = NULL WHERE provider_id = $1', [id]);
    await ctx.db.query('DELETE FROM hq_providers WHERE id = $1', [id]);
    await audit(ctx.db, { type: 'owner', id: o.id }, 'provider.delete', 'provider', id);
    ctx.bus.emit({ type: 'providers.changed' });
    return { ok: true };
  });

  /** A real request to the provider proving the key and model work. Its tokens are tiny and not billed to employees. */
  app.post('/hq/v1/providers/:id/test', async (req) => {
    const o = await auth.owner(req);
    const id = idParam(req.params);
    const [row] = await ctx.db.query<ProviderRow>('SELECT * FROM hq_providers WHERE id = $1', [id]);
    if (!row) throw notFound();
    let check: { ok: boolean; error?: string; at: string };
    try {
      await ctx.providers.fromRow(row).check();
      check = { ok: true, at: new Date().toISOString() };
    } catch (e) {
      check = { ok: false, error: (e as Error).message, at: new Date().toISOString() };
    }
    await ctx.db.query('UPDATE hq_providers SET last_check = $2 WHERE id = $1', [id, JSON.stringify(check)]);
    await audit(ctx.db, { type: 'owner', id: o.id }, 'provider.test', 'provider', id, { ok: check.ok });
    return check;
  });

  app.get('/hq/v1/audit', async (req) => {
    await auth.viewer(req);
    const q = z.object({ before: z.coerce.number().int().optional() }).parse(req.query);
    return ctx.db.query(
      `SELECT a.*, coalesce(e.name, o.email) AS actor_name FROM hq_audit_log a
       LEFT JOIN hq_employees e ON a.actor_type = 'employee' AND e.id::text = a.actor_id
       LEFT JOIN hq_owners o ON a.actor_type = 'owner' AND o.id::text = a.actor_id
       WHERE ($1::bigint IS NULL OR a.id < $1) ORDER BY a.id DESC LIMIT 200`,
      [q.before ?? null]
    );
  });
};
