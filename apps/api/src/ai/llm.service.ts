import type { OllamaChatBody, OllamaClient, OllamaMessage, OllamaToolCall } from "./ollama.client.js";
import type { ChatMessage, LlmChatRequest, LlmChatResult, LlmService, ToolCall } from "./types.js";

export interface OllamaLlmOptions {
  model: string;
  think: boolean;
  numCtx: number;
  temperature: number;
}

/** LlmService backed by a local Ollama chat model with native tool calling. */
export class OllamaLlmService implements LlmService {
  readonly model: string;

  constructor(
    private readonly client: OllamaClient,
    private readonly opts: OllamaLlmOptions,
  ) {
    this.model = opts.model;
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResult> {
    const body: OllamaChatBody = {
      model: this.opts.model,
      messages: request.messages.map(toOllamaMessage),
      think: this.opts.think,
      options: { temperature: request.format ? 0 : this.opts.temperature, num_ctx: this.opts.numCtx },
      ...(request.format ? { format: request.format } : {}),
    };
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    if (!request.onToken) {
      const res = await this.client.chat(body, { signal: request.signal });
      return {
        content: res.message?.content ?? "",
        thinking: res.message?.thinking,
        toolCalls: (res.message?.tool_calls ?? []).map(fromOllamaToolCall),
        usage: usage(res),
      };
    }

    let content = "";
    let thinking = "";
    const toolCalls: ToolCall[] = [];
    let last: Parameters<typeof usage>[0] | undefined;
    for await (const chunk of this.client.chatStream(body, { signal: request.signal })) {
      const delta = chunk.message?.content ?? "";
      if (delta) {
        content += delta;
        request.onToken(delta);
      }
      if (chunk.message?.thinking) thinking += chunk.message.thinking;
      for (const call of chunk.message?.tool_calls ?? []) toolCalls.push(fromOllamaToolCall(call));
      if (chunk.done) last = chunk;
    }
    return { content, thinking: thinking || undefined, toolCalls, usage: last ? usage(last) : undefined };
  }
}

function usage(res: { prompt_eval_count?: number; eval_count?: number; total_duration?: number }) {
  return {
    promptTokens: res.prompt_eval_count,
    completionTokens: res.eval_count,
    durationMs: res.total_duration ? Math.round(res.total_duration / 1e6) : undefined,
  };
}

function toOllamaMessage(m: ChatMessage): OllamaMessage {
  switch (m.role) {
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ ...(c.id ? { id: c.id } : {}), function: { name: c.name, arguments: c.arguments } })) }
          : {}),
      };
    case "tool":
      return { role: "tool", content: m.content, tool_name: m.toolName, ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}) };
    default:
      return { role: m.role, content: m.content };
  }
}

/** Models occasionally return arguments as a JSON string instead of an object. */
export function fromOllamaToolCall(call: OllamaToolCall): ToolCall {
  let args: unknown = call.function.arguments;
  if (typeof args === "string") {
    try {
      args = args.trim() ? JSON.parse(args) : {};
    } catch {
      args = { __raw: args };
    }
  }
  return {
    ...(call.id ? { id: call.id } : {}),
    name: call.function.name,
    arguments: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
  };
}
