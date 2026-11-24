import { retry } from "../lib/async.js";
import { UpstreamError } from "../lib/errors.js";

/** Wire types for the subset of the Ollama REST API we use. */
export interface OllamaToolCall {
  id?: string;
  function: { index?: number; name: string; arguments: Record<string, unknown> | string };
}

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
  tool_call_id?: string;
}

export interface OllamaChatBody {
  model: string;
  messages: OllamaMessage[];
  tools?: { type: "function"; function: { name: string; description: string; parameters: unknown } }[];
  stream?: boolean;
  think?: boolean;
  keep_alive?: string;
  options?: { temperature?: number; num_ctx?: number };
}

export interface OllamaChatChunk {
  model: string;
  message?: OllamaMessage;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export interface OllamaClientOptions {
  host: string;
  /** Per-request timeout. For streams, it bounds the whole response. */
  timeoutMs: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function isRetryable(err: unknown): boolean {
  // Never retry timeouts: a model that took LLM_TIMEOUT_MS once will likely do so again.
  if (err instanceof UpstreamError && !err.timedOut) {
    return err.status === undefined || RETRYABLE_STATUS.has(err.status);
  }
  return false;
}

/**
 * Minimal, dependency-free Ollama HTTP client with timeouts, cancellation,
 * retries for transient failures and NDJSON streaming.
 */
export class OllamaClient {
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OllamaClientOptions) {
    this.host = opts.host.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(model: string, input: string[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<number[][]> {
    const res = await retry(
      () => this.post<{ embeddings: number[][] }>("/api/embed", { model, input }, opts),
      { retries: this.opts.retries ?? 2, shouldRetry: isRetryable, signal: opts.signal },
    );
    if (!Array.isArray(res.embeddings) || res.embeddings.length !== input.length) {
      throw new UpstreamError("ollama", `expected ${input.length} embeddings, got ${res.embeddings?.length ?? 0}`);
    }
    return res.embeddings;
  }

  /** Non-streaming chat call. */
  async chat(body: OllamaChatBody, opts: { signal?: AbortSignal } = {}): Promise<OllamaChatChunk> {
    return retry(() => this.post<OllamaChatChunk>("/api/chat", { ...body, stream: false }, opts), {
      retries: this.opts.retries ?? 2,
      shouldRetry: isRetryable,
      signal: opts.signal,
    });
  }

  /**
   * Streaming chat call. Yields every NDJSON chunk. Connection errors before the
   * first byte are retried; failures mid-stream are not (the caller has already
   * seen partial output).
   */
  async *chatStream(body: OllamaChatBody, opts: { signal?: AbortSignal } = {}): AsyncGenerator<OllamaChatChunk> {
    const signal = this.signal(opts.signal);
    const response = await retry(() => this.request("/api/chat", { ...body, stream: true }, signal), {
      retries: this.opts.retries ?? 2,
      shouldRetry: isRetryable,
      signal,
    });
    if (!response.body) throw new UpstreamError("ollama", "empty response body");

    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(part, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) yield this.parseChunk(line);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) yield this.parseChunk(buffer.trim());
    } catch (err) {
      throw this.wrapError(err, signal);
    }
  }

  async listModels(opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string[]> {
    const signal = this.signal(opts.signal, opts.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.host}/api/tags`, { signal });
      if (!res.ok) throw new UpstreamError("ollama", `GET /api/tags failed with ${res.status}`, res.status);
      const json = (await res.json()) as { models?: { name: string }[] };
      return (json.models ?? []).map((m) => m.name);
    } catch (err) {
      throw this.wrapError(err, signal);
    }
  }

  private parseChunk(line: string): OllamaChatChunk {
    let chunk: OllamaChatChunk;
    try {
      chunk = JSON.parse(line) as OllamaChatChunk;
    } catch {
      throw new UpstreamError("ollama", `invalid JSON in stream: ${line.slice(0, 120)}`);
    }
    if (chunk.error) throw new UpstreamError("ollama", chunk.error);
    return chunk;
  }

  private async post<T>(path: string, body: unknown, opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
    const signal = this.signal(opts.signal, opts.timeoutMs);
    const res = await this.request(path, body, signal);
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw this.wrapError(err, signal);
    }
  }

  private async request(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.host}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw this.wrapError(err, signal);
    }
    if (!res.ok) {
      let message = `${path} failed with HTTP ${res.status}`;
      try {
        const json = (await res.json()) as { error?: string };
        if (json.error) message = json.error;
      } catch {
        /* ignore non-JSON error bodies */
      }
      if (res.status === 404 && /model/i.test(message)) {
        message += ` (run \`ollama pull <model>\` first)`;
      }
      throw new UpstreamError("ollama", message, res.status);
    }
    return res;
  }

  private signal(external?: AbortSignal, timeoutMs = this.opts.timeoutMs): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return external ? AbortSignal.any([external, timeout]) : timeout;
  }

  private wrapError(err: unknown, signal: AbortSignal): Error {
    if (err instanceof UpstreamError) return err;
    if (signal.aborted) {
      const reason = signal.reason as unknown;
      if (reason instanceof DOMException && reason.name === "TimeoutError") {
        const timeoutErr = new UpstreamError("ollama", "request timed out", 504, { cause: err });
        timeoutErr.timedOut = true;
        return timeoutErr;
      }
      // Caller cancelled: surface the abort as-is so callers can detect it.
      return reason instanceof Error ? reason : new DOMException("Aborted", "AbortError");
    }
    const message = err instanceof Error ? err.message : String(err);
    return new UpstreamError("ollama", `cannot reach Ollama at ${this.host} (${message})`, undefined, { cause: err });
  }
}

