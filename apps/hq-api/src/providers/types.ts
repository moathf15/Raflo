/**
 * Provider-neutral chat interface. Each adapter (Anthropic, OpenAI) translates to and from its own SDK.
 * Assistant turns keep the provider's raw content (`raw`) so provider-specific blocks (e.g. Claude thinking blocks)
 * are passed back unchanged within the same tool loop.
 */
export interface TextPart {
  type: 'text';
  text: string;
}
export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultPart {
  type: 'tool_result';
  id: string;
  content: string;
  isError?: boolean;
}

export type ChatMessage =
  | { role: 'user'; content: (TextPart | ToolResultPart)[] }
  | { role: 'assistant'; content: (TextPart | ToolCallPart)[]; raw?: unknown; provider?: string };

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema of the tool input (object). */
  schema: Record<string, unknown>;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  maxTokens?: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ChatResponse {
  content: (TextPart | ToolCallPart)[];
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';
  usage: Usage;
  /** The model that actually served the request (may differ after a server-side fallback). */
  model: string;
  raw: unknown;
  refusal?: string;
}

export interface Provider {
  readonly kind: 'anthropic' | 'openai' | 'test';
  readonly model: string;
  readonly label: string;
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  /** A minimal request proving the credentials and model work. */
  check(): Promise<void>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
  }
}
