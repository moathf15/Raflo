import type { Db } from '../db/client';
import type { Vault } from '../lib/crypto';
import { anthropicProvider } from './anthropic';
import { openaiProvider } from './openai';
import type { Provider } from './types';

export interface ProviderRow {
  id: string;
  kind: 'anthropic' | 'openai';
  label: string;
  model: string;
  api_key_enc: string;
  base_url: string | null;
  temperature: string | number | null;
  max_tokens: number;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  is_default: boolean;
  enabled: boolean;
}

/** Builds a live provider client from a stored configuration. Tests replace this with a scripted provider. */
export type ProviderFactory = (row: ProviderRow, apiKey: string, modelOverride?: string | null) => Provider;

export const defaultFactory: ProviderFactory = (row, apiKey, modelOverride) => {
  const model = modelOverride || row.model;
  if (row.kind === 'anthropic') return anthropicProvider({ apiKey, model, label: row.label, maxTokens: row.max_tokens, effort: row.effort, baseURL: row.base_url });
  return openaiProvider({ apiKey, model, label: row.label, maxTokens: row.max_tokens, temperature: row.temperature == null ? null : Number(row.temperature), baseURL: row.base_url });
};

export class NoProviderError extends Error {
  constructor() {
    super('No AI provider is configured. Add one in Settings → AI providers; nothing runs until then.');
  }
}

export interface Providers {
  /** The provider for an employee: their own if set and enabled, otherwise the default one. */
  forEmployee(emp: { provider_id: string | null; model_override: string | null }): Promise<Provider>;
  fromRow(row: ProviderRow): Provider;
  hasAny(): Promise<boolean>;
}

export function createProviders(db: Db, vault: Vault, factory: ProviderFactory = defaultFactory): Providers {
  const fromRow = (row: ProviderRow, override?: string | null) => factory(row, vault.decrypt(row.api_key_enc), override);
  return {
    fromRow: (row) => fromRow(row),
    async hasAny() {
      const [r] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM hq_providers WHERE enabled');
      return r.n > 0;
    },
    async forEmployee(emp) {
      const rows = await db.query<ProviderRow>(
        `SELECT * FROM hq_providers WHERE enabled AND (id = $1 OR is_default) ORDER BY (id = $1) DESC NULLS LAST, is_default DESC, created_at LIMIT 1`,
        [emp.provider_id]
      );
      if (!rows[0]) {
        const any = await db.query<ProviderRow>('SELECT * FROM hq_providers WHERE enabled ORDER BY created_at LIMIT 1');
        if (!any[0]) throw new NoProviderError();
        return fromRow(any[0], emp.model_override);
      }
      return fromRow(rows[0], emp.model_override);
    }
  };
}
