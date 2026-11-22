import OpenAI from 'openai';
import type { ChatRequest, Provider, TextPart, ToolCallPart } from './types';
import { ProviderError } from './types';

export interface OpenAIOptions {
  apiKey: string;
  model: string;
  label: string;
  maxTokens: number;
  temperature?: number | null;
  baseURL?: string | null;
}

/** OpenAI (or any OpenAI-compatible endpoint set by base URL) via the official SDK's Chat Completions API. */
export function openaiProvider(o: OpenAIOptions): Provider {
  const client = new OpenAI({ apiKey: o.apiKey, ...(o.baseURL ? { baseURL: o.baseURL } : {}), maxRetries: 2, timeout: 10 * 60_000 });

  const toMessages = (req: ChatRequest): OpenAI.Chat.Completions.ChatCompletionMessageParam[] => {
    const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: 'system', content: req.system }];
    for (const m of req.messages) {
      if (m.role === 'assistant') {
        const text = m.content.filter((p): p is TextPart => p.type === 'text').map((p) => p.text).join('\n');
        const calls = m.content.filter((p): p is ToolCallPart => p.type === 'tool_call');
        out.push({
          role: 'assistant',
          content: text || null,
          ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {})
        });
      } else {
        const texts: string[] = [];
        for (const p of m.content) {
          if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.id, content: p.isError ? `ERROR: ${p.content}` : p.content });
          else texts.push(p.text);
        }
        if (texts.length) out.push({ role: 'user', content: texts.join('\n\n') });
      }
    }
    return out;
  };

  return {
    kind: 'openai',
    model: o.model,
    label: o.label,
    async chat(req, signal) {
      let res: OpenAI.Chat.Completions.ChatCompletion;
      try {
        res = await client.chat.completions.create(
          {
            model: o.model,
            messages: toMessages(req),
            max_completion_tokens: req.maxTokens ?? o.maxTokens,
            ...(o.temperature != null ? { temperature: o.temperature } : {}),
            ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.schema } })) } : {})
          },
          { signal }
        );
      } catch (e) {
        if (e instanceof OpenAI.AuthenticationError) throw new ProviderError('OpenAI rejected the API key', false, 401);
        if (e instanceof OpenAI.PermissionDeniedError) throw new ProviderError('The API key has no access to this model', false, 403);
        if (e instanceof OpenAI.NotFoundError) throw new ProviderError(`Model not found: ${o.model}`, false, 404);
        if (e instanceof OpenAI.BadRequestError) throw new ProviderError(`OpenAI rejected the request: ${e.message}`, false, 400);
        if (e instanceof OpenAI.RateLimitError) throw new ProviderError('OpenAI rate limit reached', true, 429);
        if (e instanceof OpenAI.APIError) throw new ProviderError(`OpenAI API error ${e.status ?? ''}: ${e.message}`, true, e.status);
        throw new ProviderError(`Could not reach OpenAI: ${(e as Error).message}`, true);
      }
      const choice = res.choices[0];
      const content: (TextPart | ToolCallPart)[] = [];
      if (choice?.message.content) content.push({ type: 'text', text: choice.message.content });
      for (const c of choice?.message.tool_calls ?? []) {
        if (c.type !== 'function') continue;
        let input: unknown = {};
        try {
          input = JSON.parse(c.function.arguments || '{}');
        } catch {
          input = { __invalid_json: c.function.arguments };
        }
        content.push({ type: 'tool_call', id: c.id, name: c.function.name, input });
      }
      const fr = choice?.finish_reason;
      const refusal = choice?.message.refusal ?? undefined;
      const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      return {
        content,
        stopReason: refusal ? 'refusal' : fr === 'tool_calls' ? 'tool_use' : fr === 'stop' ? 'end' : fr === 'length' ? 'max_tokens' : fr === 'content_filter' ? 'refusal' : 'other',
        refusal: refusal ?? (fr === 'content_filter' ? 'Blocked by the provider content filter' : undefined),
        usage: { input: (res.usage?.prompt_tokens ?? 0) - cached, output: res.usage?.completion_tokens ?? 0, cacheRead: cached, cacheWrite: 0 },
        model: res.model,
        raw: choice?.message
      };
    },
    async check() {
      await this.chat({ system: 'Reply with OK.', messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }], tools: [], maxTokens: 32 });
    }
  };
}
