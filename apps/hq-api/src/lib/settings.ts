import { z } from 'zod';
import type { Db } from '../db/client';

/** Execution limits. Every agent run is checked against these before each model call. */
export const Limits = z.object({
  maxConcurrency: z.number().int().min(1).max(20).default(2),
  dailyBudgetUsd: z.number().min(0).max(100_000).default(5),
  monthlyBudgetUsd: z.number().min(0).max(1_000_000).default(50),
  maxToolIterations: z.number().int().min(1).max(50).default(12),
  maxTokensPerRun: z.number().int().min(1000).max(5_000_000).default(300_000),
  runTimeoutSeconds: z.number().int().min(30).max(3600).default(600),
  maxAttempts: z.number().int().min(1).max(5).default(2),
  maxRevisions: z.number().int().min(0).max(5).default(2),
  maxSubtasks: z.number().int().min(1).max(20).default(8),
  maxDelegationDepth: z.number().int().min(1).max(3).default(1),
  maxMeetingRounds: z.number().int().min(1).max(4).default(2),
  maxMeetingParticipants: z.number().int().min(2).max(10).default(6)
});
export type Limits = z.infer<typeof Limits>;

/** Company-wide permission policy. Agent tool permissions are additionally limited per employee. */
export const Policy = z.object({
  /** Chief of Staff plans wait for the owner before any subtask runs. */
  planRequiresApproval: z.boolean().default(true),
  /** Agents with the github.read tool may read authorised repositories. */
  githubRead: z.boolean().default(true),
  /** Approved code changes may be committed to a new hq/* branch (never the default or a protected branch). */
  githubWriteBranches: z.boolean().default(false),
  /** Pull requests may be opened (each one still needs an approval). */
  githubPullRequests: z.boolean().default(true),
  /** Pull requests may be merged (each one still needs an explicit approval). */
  githubMerge: z.boolean().default(false),
  /** Knowledge marked confidential may be sent to the AI provider. */
  confidentialToProvider: z.boolean().default(false),
  /** Branches that can never be written, in addition to the repository's default branch. */
  protectedBranches: z.array(z.string().min(1).max(200)).max(50).default(['main', 'master', 'production', 'release'])
});
export type Policy = z.infer<typeof Policy>;

/** USD per million tokens. Claude prices from Anthropic's published list; other models are entered by the owner. */
export const Pricing = z.record(
  z.string().min(1).max(100),
  z.object({ input: z.number().min(0), output: z.number().min(0), cacheRead: z.number().min(0).optional(), cacheWrite: z.number().min(0).optional() })
);
export type Pricing = z.infer<typeof Pricing>;
export const DEFAULT_PRICING: Pricing = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }
};

export const Company = z.object({
  name: z.string().min(1).max(100).default('Raflo'),
  mission: z.string().max(4000).default('')
});
export type Company = z.infer<typeof Company>;

const SCHEMAS = { limits: Limits, policy: Policy, pricing: Pricing, company: Company } as const;
export type SettingKey = keyof typeof SCHEMAS;
type Value<K extends SettingKey> = z.infer<(typeof SCHEMAS)[K]>;
export const SETTING_KEYS = Object.keys(SCHEMAS) as SettingKey[];

export async function getSetting<K extends SettingKey>(db: Db, key: K): Promise<Value<K>> {
  const [row] = await db.query<{ value: unknown }>('SELECT value FROM hq_settings WHERE key = $1', [key]);
  const fallback = key === 'pricing' ? DEFAULT_PRICING : {};
  return SCHEMAS[key].parse(row?.value ?? fallback) as Value<K>;
}

export async function setSetting<K extends SettingKey>(db: Db, key: K, value: unknown): Promise<Value<K>> {
  const parsed = SCHEMAS[key].parse(value) as Value<K>;
  await db.query('INSERT INTO hq_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()', [key, JSON.stringify(parsed)]);
  return parsed;
}

export function costOf(pricing: Pricing, model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number | null {
  const p = pricing[model];
  if (!p) return null;
  return (u.input * p.input + u.output * p.output + u.cacheRead * (p.cacheRead ?? p.input) + u.cacheWrite * (p.cacheWrite ?? p.input)) / 1e6;
}
