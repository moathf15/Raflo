import Anthropic from '@anthropic-ai/sdk';
import type { ChatRequest, Provider, TextPart, ToolCallPart } from './types';
import { ProviderError } from './types';

/** Models that accept the server-side refusal fallback chain (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-sonnet-5-5']);

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  label: string;
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  baseURL?: string | null;
}

/**
 * Claude via the official Anthropic SDK (Messages API). Thinking is adaptive (the default on current models);
 * depth is set with `output_config.effort`. Sampling parameters are not sent: current Claude models reject them.
 */
export function anthropicProvider(o: AnthropicOptions): Provider {
  const client = new Anthropic({ apiKey: o.apiKey, ...(o.baseURL ? { baseURL: o.baseURL } : {}), maxRetries: 2, timeout: 10 * 60_000 });
  const useFallback = FALLBACK_MODELS.has(o.model);

  const toParams = (req: ChatRequest): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming => ({
    model: o.model,
    max_tokens: req.maxTokens ?? o.maxTokens,
    // The role prompt is stable per employee, so it is cached; per-task context goes in the user turn.
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages: req.messages.map((m): Anthropic.Beta.Messages.BetaMessageParam => {
      if (m.role === 'assistant') {
        if (m.raw && m.provider === 'anthropic') return { role: 'assistant', content: m.raw as Anthropic.Beta.Messages.BetaContentBlockParam[] };
        return {
          role: 'assistant',
          content: m.content.map((p) => (p.type === 'text' ? { type: 'text' as const, text: p.text } : { type: 'tool_use' as const, id: p.id, name: p.name, input: p.input as Record<string, unknown> }))
        };
      }
      return {
        role: 'user',
        content: m.content.map((p) =>
          p.type === 'text' ? { type: 'text' as const, text: p.text } : { type: 'tool_result' as const, tool_use_id: p.id, content: p.content, ...(p.isError ? { is_error: true } : {}) }
        )
      };
    }),
    ...(req.tools.length
      ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema as Anthropic.Beta.Messages.BetaTool.InputSchema })), tool_choice: { type: 'auto' as const } }
      : {}),
    ...(o.effort ? { output_config: { effort: o.effort } } : {}),
    ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {})
  });

  return {
    kind: 'anthropic',
    model: o.model,
    label: o.label,
    async chat(req, signal) {
      let res: Anthropic.Beta.Messages.BetaMessage;
      try {
        res = await client.beta.messages.create(toParams(req), { signal });
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) throw new ProviderError('Anthropic rejected the API key', false, 401);
        if (e instanceof Anthropic.PermissionDeniedError) throw new ProviderError('The API key has no access to this model', false, 403);
        if (e instanceof Anthropic.NotFoundError) throw new ProviderError(`Model not found: ${o.model}`, false, 404);
        if (e instanceof Anthropic.BadRequestError) throw new ProviderError(`Anthropic rejected the request: ${e.message}`, false, 400);
        if (e instanceof Anthropic.RateLimitError) throw new ProviderError('Anthropic rate limit reached', true, 429);
        if (e instanceof Anthropic.APIError) throw new ProviderError(`Anthropic API error ${e.status ?? ''}: ${e.message}`, true, e.status);
        throw new ProviderError(`Could not reach Anthropic: ${(e as Error).message}`, true);
      }
      const content: (TextPart | ToolCallPart)[] = [];
      for (const b of res.content) {
        if (b.type === 'text') content.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') content.push({ type: 'tool_call', id: b.id, name: b.name, input: b.input });
      }
      const u = res.usage;
      const stop = res.stop_reason;
      return {
        content,
        stopReason: stop === 'end_turn' || stop === 'stop_sequence' ? 'end' : stop === 'tool_use' ? 'tool_use' : stop === 'max_tokens' ? 'max_tokens' : stop === 'refusal' ? 'refusal' : 'other',
        refusal: stop === 'refusal' ? (res.stop_details?.explanation ?? 'The model declined this request') : undefined,
        usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
        model: res.model,
        raw: res.content
      };
    },
    async check() {
      await this.chat({ system: 'Reply with OK.', messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }], tools: [], maxTokens: 64 });
    }
  };
}
