import { UpstreamError } from "../lib/errors.js";
import type { OpenAiChatBody, OpenAiClient, OpenAiMessage, OpenAiToolCall } from "./openai.client.js";
import type { ChatMessage, EmbeddingService, LlmChatRequest, LlmChatResult, LlmService, ToolCall } from "./types.js";
import { taskPrefixes } from "./embeddings.service.js";

export interface OpenAiLlmOptions {
  model: string;
  temperature: number;
}

/** LlmService backed by a hosted, OpenAI-compatible chat model with native tool calling. */
export class OpenAiLlmService implements LlmService {
  readonly model: string;

  constructor(
    private readonly client: OpenAiClient,
    private readonly opts: OpenAiLlmOptions,
  ) {
    this.model = opts.model;
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResult> {
    const body: OpenAiChatBody = {
      model: this.opts.model,
      messages: toOpenAiMessages(request.messages),
      temperature: request.format ? 0 : this.opts.temperature,
      ...(request.format
        ? {
            response_format:
              request.format === "json"
                ? { type: "json_object" as const }
                : { type: "json_schema" as const, json_schema: { name: "output", schema: request.format, strict: false } },
          }
        : {}),
    };
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }

    const started = Date.now();
    if (!request.onToken) {
      const res = await this.client.chat(body, { signal: request.signal });
      const msg = res.choices?.[0]?.message;
      if (!msg) throw new UpstreamError(this.client.label, "the response had no message");
      return {
        content: msg.content ?? "",
        thinking: msg.reasoning_content || undefined,
        toolCalls: (msg.tool_calls ?? []).map(fromOpenAiToolCall),
        usage: { promptTokens: res.usage?.prompt_tokens, completionTokens: res.usage?.completion_tokens, durationMs: Date.now() - started },
      };
    }

    let content = "";
    let thinking = "";
    // Tool calls arrive as fragments keyed by index: id and name first, then pieces of the JSON arguments.
    const partial = new Map<number, { id?: string; name: string; args: string }>();
    let usage: LlmChatResult["usage"];
    for await (const chunk of this.client.chatStream(body, { signal: request.signal })) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        content += delta.content;
        request.onToken(delta.content);
      }
      if (delta?.reasoning_content) thinking += delta.reasoning_content;
      for (const [i, call] of (delta?.tool_calls ?? []).entries()) {
        const key = call.index ?? i;
        const p = partial.get(key) ?? { name: "", args: "" };
        if (call.id) p.id = call.id;
        if (call.function?.name) p.name += call.function.name;
        if (call.function?.arguments) p.args += call.function.arguments;
        partial.set(key, p);
      }
      if (chunk.usage) usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
    }
    const toolCalls = [...partial.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, p]) => fromOpenAiToolCall({ id: p.id, function: { name: p.name, arguments: p.args } }));
    return { content, thinking: thinking || undefined, toolCalls, usage: { ...usage, durationMs: Date.now() - started } };
  }
}

/**
 * Converts the provider-neutral history. OpenAI-style APIs link each tool
 * result to its call by id, so calls without one get a stable generated id.
 */
export function toOpenAiMessages(messages: ChatMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  let pending: { id: string; name: string }[] = [];
  let n = 0;
  for (const m of messages) {
    if (m.role === "assistant") {
      const calls = (m.toolCalls ?? []).map((c) => ({ id: c.id ?? `call_${++n}`, name: c.name, arguments: c.arguments }));
      pending = calls.map(({ id, name }) => ({ id, name }));
      out.push({
        role: "assistant",
        content: m.content || (calls.length ? null : ""),
        ...(calls.length
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }
          : {}),
      });
    } else if (m.role === "tool") {
      // Match by id, else by name in call order.
      const idx = m.toolCallId ? pending.findIndex((p) => p.id === m.toolCallId) : pending.findIndex((p) => p.name === m.toolName);
      const id = m.toolCallId ?? (idx >= 0 ? pending[idx]!.id : `call_${++n}`);
      if (idx >= 0) pending.splice(idx, 1);
      out.push({ role: "tool", tool_call_id: id, content: m.content });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

let generated = 0;
/** Arguments arrive as a JSON string; models occasionally send invalid or empty JSON. */
export function fromOpenAiToolCall(call: OpenAiToolCall): ToolCall {
  const raw = call.function.arguments ?? "";
  let args: unknown = {};
  try {
    args = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    args = { __raw: raw };
  }
  return {
    id: call.id || `call_gen_${++generated}`,
    name: call.function.name ?? "",
    arguments: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
  };
}

export interface OpenAiEmbeddingOptions {
  model: string;
  dimensions: number;
  batchSize?: number;
}

/** Embeddings from a hosted, OpenAI-compatible /embeddings endpoint. */
export class OpenAiEmbeddingService implements EmbeddingService {
  readonly model: string;
  readonly dimensions: number;
  private readonly batchSize: number;
  private readonly prefixes: { document: string; query: string };

  constructor(
    private readonly client: OpenAiClient,
    opts: OpenAiEmbeddingOptions,
  ) {
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    this.batchSize = opts.batchSize ?? 64;
    this.prefixes = taskPrefixes(opts.model);
  }

  async embedDocuments(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize).map((t) => this.prefixes.document + t);
      out.push(...this.check(await this.client.embed(this.model, batch, { signal })));
    }
    return out;
  }

  async embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
    const [v] = this.check(await this.client.embed(this.model, [this.prefixes.query + text], { signal }));
    return v as number[];
  }

  private check(vectors: number[][]): number[][] {
    for (const v of vectors) {
      if (v.length !== this.dimensions) {
        throw new UpstreamError(
          this.client.label,
          `embedding model "${this.model}" returned ${v.length} dimensions but EMBEDDING_DIMENSIONS is ${this.dimensions}. Update the config and re-index your documents.`,
        );
      }
    }
    return vectors;
  }
}
