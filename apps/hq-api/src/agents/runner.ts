import { z } from 'zod';
import { setEmployeeStatus, type Ctx, type EmployeeStatus } from '../context';
import { costOf, getSetting } from '../lib/settings';
import type { ChatMessage, Provider, ToolCallPart, ToolResultPart, Usage } from '../providers/types';
import { ProviderError } from '../providers/types';
import type { EmployeeRow } from './prompts';
import { toToolDef, type Tool, type ToolEnv } from './tools';

export type RunKind = 'task' | 'review' | 'plan' | 'meeting_turn' | 'minutes' | 'chat' | 'briefing';

/** The structured output a run must end with, submitted as a tool call and validated against `input`. */
export interface Terminal<S extends z.ZodType> {
  name: string;
  description: string;
  input: S;
  status: [EmployeeStatus, string];
}

export class RunError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly code: 'budget' | 'no_provider' | 'provider' | 'limit' | 'refusal' | 'output' | 'timeout') {
    super(message);
  }
}

export interface RunOptions<S extends z.ZodType> {
  kind: RunKind;
  employee: EmployeeRow;
  system: string;
  prompt: string;
  tools: Tool[];
  terminal?: Terminal<S>;
  /** When the model answers in text without calling the terminal tool twice, use the text as this field. */
  textFallback?: (text: string) => z.infer<S> | null;
  taskId?: string | null;
  meetingId?: string | null;
  projectId?: string | null;
  projectRepo?: string | null;
  /** Status shown while the model is thinking. */
  thinkingStatus?: [EmployeeStatus, string];
  maxIterations?: number;
  /** Extra messages (chat history) placed before `prompt`. */
  history?: ChatMessage[];
}

export interface RunResult<S extends z.ZodType> {
  runId: string;
  output: z.infer<S> | null;
  text: string;
  usage: Usage;
  costUsd: number | null;
  model: string;
}

interface LogEntry {
  t: string;
  type: 'model' | 'tool' | 'error' | 'note';
  [k: string]: unknown;
}

/** Spent today and this month, from recorded runs. */
export async function spend(ctx: Ctx) {
  const [r] = await ctx.db.query<{ today: string; month: string }>(
    `SELECT coalesce(sum(cost_usd) FILTER (WHERE started_at >= date_trunc('day', now())), 0) AS today,
            coalesce(sum(cost_usd) FILTER (WHERE started_at >= date_trunc('month', now())), 0) AS month
     FROM hq_runs`
  );
  return { today: Number(r.today), month: Number(r.month) };
}

async function assertBudget(ctx: Ctx) {
  const limits = await getSetting(ctx.db, 'limits');
  const s = await spend(ctx);
  if (s.today >= limits.dailyBudgetUsd) throw new RunError(`Daily AI budget reached ($${s.today.toFixed(2)} of $${limits.dailyBudgetUsd}). Raise it in Settings → Limits.`, false, 'budget');
  if (s.month >= limits.monthlyBudgetUsd) throw new RunError(`Monthly AI budget reached ($${s.month.toFixed(2)} of $${limits.monthlyBudgetUsd}).`, false, 'budget');
}

/**
 * One agent execution: a bounded tool-use loop against the employee's provider. Every model call, tool call,
 * token and cost is recorded in hq_runs; the employee's office status follows what the loop is actually doing.
 */
export async function runAgent<S extends z.ZodType>(ctx: Ctx, o: RunOptions<S>): Promise<RunResult<S>> {
  const limits = await getSetting(ctx.db, 'limits');
  const pricing = await getSetting(ctx.db, 'pricing');
  let provider: Provider;
  try {
    provider = await ctx.providers.forEmployee(o.employee);
  } catch (e) {
    throw new RunError((e as Error).message, false, 'no_provider');
  }
  const [run] = await ctx.db.query<{ id: string }>(
    `INSERT INTO hq_runs (kind, task_id, meeting_id, employee_id, provider, model) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [o.kind, o.taskId ?? null, o.meetingId ?? null, o.employee.id, `${provider.kind}:${provider.label}`, provider.model]
  );
  ctx.bus.emit({ type: 'run', runId: run.id, status: 'running', employeeId: o.employee.id, kind: o.kind });

  const env: ToolEnv = { employee: o.employee, runId: run.id, taskId: o.taskId ?? null, projectId: o.projectId ?? null, projectRepo: o.projectRepo ?? null };
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let cost: number | null = null;
  let calls = 0;
  let model = provider.model;
  const log: LogEntry[] = [];
  const toolMap = new Map(o.tools.map((t) => [t.name, t]));
  const toolDefs = o.tools.map((t) => toToolDef(t.name, t.description, t.input));
  if (o.terminal) toolDefs.push(toToolDef(o.terminal.name, o.terminal.description, o.terminal.input));
  const messages: ChatMessage[] = [...(o.history ?? []), { role: 'user', content: [{ type: 'text', text: o.prompt }] }];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), limits.runTimeoutSeconds * 1000);
  const maxIterations = o.maxIterations ?? limits.maxToolIterations;
  const thinking = o.thinkingStatus ?? ['thinking', 'Thinking'];
  const persist = async (status?: 'succeeded' | 'failed', error?: string) => {
    await ctx.db.query(
      `UPDATE hq_runs SET input_tokens = $2, output_tokens = $3, cache_read_tokens = $4, cache_write_tokens = $5, cost_usd = $6, model_calls = $7, log = $8, model = $9
         ${status ? ', status = $10, error = $11, finished_at = now()' : ''} WHERE id = $1`,
      [run.id, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, cost, calls, JSON.stringify(log), model, ...(status ? [status, error ?? null] : [])]
    );
  };

  let nudged = false;
  let lastText = '';
  try {
    for (let iteration = 0; ; iteration++) {
      if (iteration >= maxIterations) throw new RunError(`Stopped after ${maxIterations} steps without a final result (Settings → Limits).`, false, 'limit');
      if (usage.input + usage.output + usage.cacheRead > limits.maxTokensPerRun) throw new RunError(`Token limit for one run reached (${limits.maxTokensPerRun}).`, false, 'limit');
      await assertBudget(ctx);
      await setEmployeeStatus(ctx, o.employee.id, thinking[0], thinking[1]);
      const started = Date.now();
      let res;
      try {
        res = await provider.chat({ system: o.system, messages, tools: toolDefs }, abort.signal);
      } catch (e) {
        if (abort.signal.aborted) throw new RunError(`Run timed out after ${limits.runTimeoutSeconds}s.`, true, 'timeout');
        if (e instanceof ProviderError) throw new RunError(e.message, e.retryable, 'provider');
        throw new RunError((e as Error).message, true, 'provider');
      }
      calls++;
      model = res.model || model;
      usage.input += res.usage.input;
      usage.output += res.usage.output;
      usage.cacheRead += res.usage.cacheRead;
      usage.cacheWrite += res.usage.cacheWrite;
      cost = costOf(pricing, provider.model, usage);
      const text = res.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n').trim();
      if (text) lastText = text;
      const toolCalls = res.content.filter((p): p is ToolCallPart => p.type === 'tool_call');
      log.push({ t: new Date().toISOString(), type: 'model', ms: Date.now() - started, stop: res.stopReason, usage: res.usage, text: text.slice(0, 2000), tools: toolCalls.map((c) => c.name) });
      await persist();

      if (res.stopReason === 'refusal') throw new RunError(`The model declined: ${res.refusal ?? 'no reason given'}`, false, 'refusal');
      messages.push({ role: 'assistant', content: res.content, raw: res.raw, provider: provider.kind });

      if (!toolCalls.length) {
        if (res.stopReason === 'max_tokens') throw new RunError('The response hit the max_tokens limit before finishing. Increase max tokens for this provider.', true, 'output');
        if (!o.terminal) return finish(null, text);
        if (!nudged) {
          nudged = true;
          messages.push({ role: 'user', content: [{ type: 'text', text: `Finish by calling the ${o.terminal.name} tool with your result.` }] });
          continue;
        }
        const fb = o.textFallback?.(text || lastText);
        if (fb) {
          log.push({ t: new Date().toISOString(), type: 'note', note: 'Final result taken from text: the model did not call the result tool.' });
          return finish(fb, text);
        }
        throw new RunError(`The model did not submit a result with ${o.terminal.name}.`, true, 'output');
      }

      const results: ToolResultPart[] = [];
      let final: z.infer<S> | null = null;
      for (const call of toolCalls) {
        if (o.terminal && call.name === o.terminal.name) {
          const parsed = o.terminal.input.safeParse(call.input);
          if (parsed.success) {
            final = parsed.data;
            log.push({ t: new Date().toISOString(), type: 'tool', tool: call.name, ok: true });
            results.push({ type: 'tool_result', id: call.id, content: 'Received.' });
          } else {
            const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
            log.push({ t: new Date().toISOString(), type: 'tool', tool: call.name, ok: false, error: msg });
            results.push({ type: 'tool_result', id: call.id, content: `Invalid input: ${msg}. Call ${call.name} again with corrected input.`, isError: true });
          }
          continue;
        }
        const t = toolMap.get(call.name);
        if (!t) {
          results.push({ type: 'tool_result', id: call.id, content: `Tool ${call.name} is not available to you.`, isError: true });
          log.push({ t: new Date().toISOString(), type: 'tool', tool: call.name, ok: false, error: 'not permitted' });
          continue;
        }
        const parsed = t.input.safeParse(call.input);
        if (!parsed.success) {
          const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
          results.push({ type: 'tool_result', id: call.id, content: `Invalid input: ${msg}`, isError: true });
          log.push({ t: new Date().toISOString(), type: 'tool', tool: call.name, ok: false, error: msg });
          continue;
        }
        await setEmployeeStatus(ctx, o.employee.id, t.status[0], t.status[1]);
        try {
          const out = await t.run(ctx, env, parsed.data);
          results.push({ type: 'tool_result', id: call.id, content: out });
          log.push({ t: new Date().toISOString(), type: 'tool', tool: call.name, ok: true, input: summarize(parsed.data), output: out.slice(0, 500) });
        } catch (e) {
          const msg = (e as Error).message;
          results.push({ type: 'tool_result', id: call.id, content: `Error: ${msg}`, isError: true });
          log.push({ t: new Date().toISOString(), type: 'tool', tool: call.name, ok: false, input: summarize(parsed.data), error: msg });
        }
      }
      if (final !== null) {
        if (o.terminal) await setEmployeeStatus(ctx, o.employee.id, o.terminal.status[0], o.terminal.status[1]);
        return finish(final, text);
      }
      messages.push({ role: 'user', content: results });
    }
  } catch (e) {
    const err = e instanceof RunError ? e : new RunError((e as Error).message, true, 'provider');
    log.push({ t: new Date().toISOString(), type: 'error', error: err.message });
    await persist('failed', err.message);
    ctx.bus.emit({ type: 'run', runId: run.id, status: 'failed', employeeId: o.employee.id, kind: o.kind });
    throw err;
  } finally {
    clearTimeout(timer);
  }

  async function finish(output: z.infer<S> | null, text: string): Promise<RunResult<S>> {
    await persist('succeeded');
    ctx.bus.emit({ type: 'run', runId: run.id, status: 'succeeded', employeeId: o.employee.id, kind: o.kind });
    return { runId: run.id, output, text, usage, costUsd: cost, model };
  }
}

function summarize(v: unknown): unknown {
  const s = JSON.stringify(v);
  return s.length > 400 ? `${s.slice(0, 400)}…` : v;
}

export async function loadEmployee(ctx: Ctx, id: string): Promise<EmployeeRow | null> {
  const [e] = await ctx.db.query<EmployeeRow>('SELECT * FROM hq_employees WHERE id = $1', [id]);
  return e ?? null;
}
