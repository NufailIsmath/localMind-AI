import { retry } from "../lib/async.js";
import { UpstreamError } from "../lib/errors.js";

/**
 * Wire types for the OpenAI-compatible Chat Completions / Embeddings API, which
 * most hosted gateways (Roar AI, OpenRouter, Together, Groq, OpenAI itself…) speak.
 */
export interface OpenAiToolCall {
  index?: number;
  id?: string;
  type?: "function";
  function: { name?: string; arguments?: string };
}

export type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export interface OpenAiChatBody {
  model: string;
  messages: OpenAiMessage[];
  tools?: { type: "function"; function: { name: string; description: string; parameters: unknown } }[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" } | { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } };
}

export interface OpenAiChatResponse {
  choices: { index: number; message: { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[]; reasoning_content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface OpenAiChatChunk {
  choices: { index: number; delta: { content?: string | null; tool_calls?: OpenAiToolCall[]; reasoning_content?: string }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export interface OpenAiClientOptions {
  /** e.g. https://api.example.com/v1 (the client appends /chat/completions, /embeddings, /models). */
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  retries?: number;
  /** Name used in error messages and logs (e.g. "Roar AI"). */
  label?: string;
  fetchImpl?: typeof fetch;
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const isRetryable = (err: unknown) => err instanceof UpstreamError && !err.timedOut && (err.status === undefined || RETRYABLE_STATUS.has(err.status));

/**
 * Minimal OpenAI-compatible HTTP client: timeouts, cancellation, retries for
 * transient failures (429/5xx/network), and SSE streaming. The API key is only
 * ever sent in the Authorization header; it never appears in errors or logs.
 */
export class OpenAiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  readonly label: string;

  constructor(private readonly opts: OpenAiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.label = opts.label ?? new URL(this.baseUrl).hostname;
  }

  async chat(body: OpenAiChatBody, opts: { signal?: AbortSignal } = {}): Promise<OpenAiChatResponse> {
    return retry(() => this.json<OpenAiChatResponse>("POST", "/chat/completions", { ...body, stream: false }, opts), {
      retries: this.opts.retries ?? 2,
      shouldRetry: isRetryable,
      signal: opts.signal,
    });
  }

  /** Streams Server-Sent Events. Only failures before the first byte are retried. */
  async *chatStream(body: OpenAiChatBody, opts: { signal?: AbortSignal } = {}): AsyncGenerator<OpenAiChatChunk> {
    const signal = this.signal(opts.signal);
    const res = await retry(() => this.request("POST", "/chat/completions", { ...body, stream: true, stream_options: { include_usage: true } }, signal), {
      retries: this.opts.retries ?? 2,
      shouldRetry: isRetryable,
      signal: opts.signal,
    });
    if (!res.body) throw this.error("empty response stream");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        let read: Awaited<ReturnType<typeof reader.read>>;
        try {
          read = await reader.read();
        } catch (err) {
          throw this.wrap(err, signal);
        }
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        // SSE events are separated by a blank line; each has one or more "data:" lines.
        let sep: number;
        while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const event = buffer.slice(0, sep);
          buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
          const chunk = this.parseEvent(event);
          if (chunk === "done") return;
          if (chunk) yield chunk;
        }
      }
      const tail = this.parseEvent(buffer);
      if (tail && tail !== "done") yield tail;
    } finally {
      reader.releaseLock();
    }
  }

  async embed(model: string, input: string[], opts: { signal?: AbortSignal } = {}): Promise<number[][]> {
    const res = await retry(
      () => this.json<{ data: { index: number; embedding: number[] }[] }>("POST", "/embeddings", { model, input, encoding_format: "float" }, opts),
      { retries: this.opts.retries ?? 2, shouldRetry: isRetryable, signal: opts.signal },
    );
    if (!Array.isArray(res.data) || res.data.length !== input.length) throw this.error(`expected ${input.length} embeddings, got ${res.data?.length ?? 0}`);
    return [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  async listModels(opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string[]> {
    const res = await this.json<{ data?: { id: string }[] }>("GET", "/models", undefined, opts);
    return (res.data ?? []).map((m) => m.id);
  }

  // ---------------------------------------------------------------- internals

  private parseEvent(event: string): OpenAiChatChunk | "done" | null {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) return null; // comments / keep-alives
    if (data === "[DONE]") return "done";
    let parsed: OpenAiChatChunk & { error?: { message?: string } };
    try {
      parsed = JSON.parse(data);
    } catch {
      throw this.error(`invalid JSON in stream: ${data.slice(0, 120)}`);
    }
    if (parsed.error) throw this.error(parsed.error.message ?? "stream error");
    return parsed;
  }

  private async json<T>(method: "GET" | "POST", path: string, body: unknown, opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
    const signal = this.signal(opts.signal, opts.timeoutMs);
    const res = await this.request(method, path, body, signal);
    try {
      return (await res.json()) as T;
    } catch (err) {
      if (signal.aborted) throw this.wrap(err, signal);
      throw this.error(`invalid JSON response from ${path}`, res.status);
    }
  }

  private async request(method: "GET" | "POST", path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          accept: body !== undefined && (body as { stream?: boolean }).stream ? "text/event-stream" : "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      });
    } catch (err) {
      throw this.wrap(err, signal);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const text = await res.text();
        try {
          const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
          detail = (typeof j.error === "string" ? j.error : j.error?.message) ?? j.message ?? "";
        } catch {
          detail = text.slice(0, 200);
        }
      } catch {
        /* ignore unreadable bodies */
      }
      const hint =
        res.status === 401 || res.status === 403
          ? " (the API key was rejected: check AI_API_KEY, and that the trial hasn't expired)"
          : res.status === 402
            ? " (out of credit: check the provider's billing or trial)"
            : res.status === 404 && /model/i.test(detail)
              ? " (check the model name against the provider's model list)"
              : res.status === 429
                ? " (rate limit or quota reached)"
                : "";
      throw this.error(`${path} failed with HTTP ${res.status}${detail ? `: ${this.redact(detail)}` : ""}${hint}`, res.status);
    }
    return res;
  }

  /** Providers sometimes echo the key back in error text. */
  private redact(s: string): string {
    return this.opts.apiKey ? s.split(this.opts.apiKey).join("[redacted]") : s;
  }

  private signal(external?: AbortSignal, timeoutMs = this.opts.timeoutMs): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return external ? AbortSignal.any([external, timeout]) : timeout;
  }

  private error(message: string, status?: number): UpstreamError {
    return new UpstreamError(this.label, message, status);
  }

  private wrap(err: unknown, signal: AbortSignal): Error {
    if (err instanceof UpstreamError) return err;
    if (signal.aborted) {
      const reason = signal.reason as unknown;
      if (reason instanceof DOMException && reason.name === "TimeoutError") {
        const e = new UpstreamError(this.label, "request timed out", 504, { cause: err });
        e.timedOut = true;
        return e;
      }
      return reason instanceof Error ? reason : new DOMException("Aborted", "AbortError");
    }
    return new UpstreamError(this.label, `cannot reach ${this.label} (${err instanceof Error ? err.message : String(err)})`, undefined, { cause: err });
  }
}
