/** Provider-neutral LLM types used by the orchestrator. */

export interface ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolName: string; toolCallId?: string };

/** A tool as advertised to the model (JSON-schema parameters). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
  /** Constrain the output to JSON (a JSON schema, or "json"). */
  format?: Record<string, unknown> | "json";
  /** When provided the response is streamed and each content delta is reported. */
  onToken?: (delta: string) => void;
}

export interface LlmChatResult {
  content: string;
  toolCalls: ToolCall[];
  thinking?: string;
  usage?: { promptTokens?: number; completionTokens?: number; durationMs?: number };
}

export interface LlmService {
  readonly model: string;
  chat(request: LlmChatRequest): Promise<LlmChatResult>;
}

export interface EmbeddingService {
  readonly model: string;
  readonly dimensions: number;
  /** Embeds passages that will be stored in the vector index. */
  embedDocuments(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  /** Embeds a search query. */
  embedQuery(text: string, signal?: AbortSignal): Promise<number[]>;
}
