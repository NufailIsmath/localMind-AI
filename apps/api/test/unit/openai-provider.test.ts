import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { OpenAiClient } from "../../src/ai/openai.client.js";
import { OpenAiEmbeddingService, OpenAiLlmService, fromOpenAiToolCall, toOpenAiMessages } from "../../src/ai/openai-llm.service.js";
import { OpenAiLlamaGuard } from "../../src/modules/moderation/llama-guard.js";
import { UpstreamError } from "../../src/lib/errors.js";

const KEY = "sk-roar-test-1234567890";

/** A fetch stub that records requests and replays scripted responses. */
function stub(responses: (Response | (() => Response) | Error)[]) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> | undefined }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body as string) : undefined });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** An SSE body delivered in awkward pieces (split mid-event, CRLF line endings). */
function sse(events: unknown[], pieceSize = 7): Response {
  const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\r\n\r\n`).join("") + ": keep-alive\n\n";
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += pieceSize) c.enqueue(bytes.slice(i, i + pieceSize));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}
const client = (fetchImpl: typeof fetch, retries = 0) => new OpenAiClient({ baseUrl: "https://api.roar.test/v1/", apiKey: KEY, label: "Roar AI", timeoutMs: 2000, retries, fetchImpl });

describe("OpenAI-compatible provider: chat", () => {
  it("sends a standard Chat Completions request with tools and the key as a Bearer token", async () => {
    const { calls, fetchImpl } = stub([
      jsonRes({
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "calculate", arguments: '{"a":2,"b":3,"operation":"add"}' } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    ]);
    const llm = new OpenAiLlmService(client(fetchImpl), { model: "gpt-4o-mini", temperature: 0.2 });
    const res = await llm.chat({
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "2+3?" }],
      tools: [{ name: "calculate", description: "Adds", parameters: { type: "object" } }],
    });
    expect(res.toolCalls).toEqual([{ id: "call_1", name: "calculate", arguments: { a: 2, b: 3, operation: "add" } }]);
    expect(res.usage).toMatchObject({ promptTokens: 10, completionTokens: 5 });
    expect(calls[0]!.url).toBe("https://api.roar.test/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body).toMatchObject({
      model: "gpt-4o-mini",
      stream: false,
      temperature: 0.2,
      tools: [{ type: "function", function: { name: "calculate", description: "Adds", parameters: { type: "object" } } }],
    });
  });

  it("streams tokens and reassembles tool calls sent in fragments", async () => {
    const { calls, fetchImpl } = stub([
      sse([
        { choices: [{ index: 0, delta: { role: "assistant", content: "Let me " } }] },
        { choices: [{ index: 0, delta: { content: "check." } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "search_knowledge", arguments: "" } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"que' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "get_current_time", arguments: "{}" } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"leave policy"}' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 12 } },
        "[DONE]",
      ]),
    ]);
    const tokens: string[] = [];
    const llm = new OpenAiLlmService(client(fetchImpl), { model: "m", temperature: 0 });
    const res = await llm.chat({ messages: [{ role: "user", content: "leave?" }], onToken: (t) => tokens.push(t) });
    expect(tokens.join("")).toBe("Let me check.");
    expect(res.content).toBe("Let me check.");
    expect(res.toolCalls).toEqual([
      { id: "call_a", name: "search_knowledge", arguments: { query: "leave policy" } },
      { id: "call_b", name: "get_current_time", arguments: {} },
    ]);
    expect(res.usage).toMatchObject({ promptTokens: 50, completionTokens: 12 });
    expect(calls[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it("surfaces an error sent inside the stream", async () => {
    const { fetchImpl } = stub([sse([{ choices: [{ index: 0, delta: { content: "Hi" } }] }, { error: { message: "context length exceeded" } }])]);
    const llm = new OpenAiLlmService(client(fetchImpl), { model: "m", temperature: 0 });
    await expect(llm.chat({ messages: [{ role: "user", content: "x" }], onToken: () => {} })).rejects.toThrow(/Roar AI: context length exceeded/);
  });

  it("maps JSON mode to response_format", async () => {
    const { calls, fetchImpl } = stub([jsonRes({ choices: [{ index: 0, message: { role: "assistant", content: "{}" } }] }), jsonRes({ choices: [{ index: 0, message: { role: "assistant", content: "{}" } }] })]);
    const llm = new OpenAiLlmService(client(fetchImpl), { model: "m", temperature: 0.7 });
    await llm.chat({ messages: [{ role: "user", content: "x" }], format: { type: "object" } });
    await llm.chat({ messages: [{ role: "user", content: "x" }], format: "json" });
    expect(calls[0]!.body).toMatchObject({ temperature: 0, response_format: { type: "json_schema", json_schema: { name: "output", schema: { type: "object" } } } });
    expect(calls[1]!.body).toMatchObject({ response_format: { type: "json_object" } });
  });
});

describe("OpenAI-compatible provider: message mapping", () => {
  it("links tool results to their calls by id, generating ids when missing", () => {
    const out = toOpenAiMessages([
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "x1", name: "a", arguments: { n: 1 } }, { name: "b", arguments: {} }] },
      { role: "tool", toolName: "a", toolCallId: "x1", content: "ra" },
      { role: "tool", toolName: "b", content: "rb" },
      { role: "assistant", content: "done" },
    ]);
    expect(out[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "x1", type: "function", function: { name: "a", arguments: '{"n":1}' } },
        { id: "call_1", type: "function", function: { name: "b", arguments: "{}" } },
      ],
    });
    expect(out[2]).toEqual({ role: "tool", tool_call_id: "x1", content: "ra" });
    expect(out[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "rb" });
    expect(out[4]).toEqual({ role: "assistant", content: "done" });
  });

  it("tolerates bad tool-call arguments", () => {
    expect(fromOpenAiToolCall({ id: "c", function: { name: "t", arguments: "" } }).arguments).toEqual({});
    expect(fromOpenAiToolCall({ id: "c", function: { name: "t", arguments: "{oops" } }).arguments).toEqual({ __raw: "{oops" });
    expect(fromOpenAiToolCall({ function: { name: "t", arguments: "[1]" } })).toMatchObject({ arguments: {}, id: expect.stringMatching(/^call_gen_/) });
  });
});

describe("OpenAI-compatible provider: errors and resilience", () => {
  it("explains a rejected key and never echoes it", async () => {
    const { fetchImpl } = stub([jsonRes({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401)]);
    const err = (await client(fetchImpl, 2).chat({ model: "m", messages: [] }).catch((e: unknown) => e)) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/Roar AI: .*HTTP 401.*check AI_API_KEY.*trial/);
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain("[redacted]");
  });

  it("retries rate limits and server errors, not client errors", async () => {
    const ok = jsonRes({ choices: [{ index: 0, message: { role: "assistant", content: "hi" } }] });
    const retried = stub([jsonRes({ error: { message: "slow down" } }, 429), jsonRes({}, 503), ok]);
    expect((await client(retried.fetchImpl, 2).chat({ model: "m", messages: [] })).choices[0]!.message.content).toBe("hi");
    expect(retried.calls).toHaveLength(3);

    const notRetried = stub([jsonRes({ error: { message: "The model `nope` does not exist" } }, 404)]);
    await expect(client(notRetried.fetchImpl, 2).chat({ model: "nope", messages: [] })).rejects.toThrow(/check the model name/);
    expect(notRetried.calls).toHaveLength(1);

    const credit = stub([jsonRes({ error: "Insufficient balance" }, 402)]);
    await expect(client(credit.fetchImpl, 2).chat({ model: "m", messages: [] })).rejects.toThrow(/out of credit/);
  });

  it("reports network failures and timeouts", async () => {
    const down = stub([new TypeError("fetch failed")]);
    await expect(client(down.fetchImpl).chat({ model: "m", messages: [] })).rejects.toThrow(/cannot reach Roar AI/);
    const slow = (async (_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    const c = new OpenAiClient({ baseUrl: "https://x.test/v1", apiKey: KEY, timeoutMs: 50, retries: 0, fetchImpl: slow });
    await expect(c.chat({ model: "m", messages: [] })).rejects.toMatchObject({ timedOut: true });
  });
});

describe("OpenAI-compatible provider: embeddings and Llama Guard", () => {
  it("embeds in batches, keeps input order and checks dimensions", async () => {
    const vec = (n: number) => [n, n, n];
    const { calls, fetchImpl } = stub([
      jsonRes({ data: [{ index: 1, embedding: vec(2) }, { index: 0, embedding: vec(1) }] }),
      jsonRes({ data: [{ index: 0, embedding: vec(3) }] }),
      jsonRes({ data: [{ index: 0, embedding: [1, 2] }] }),
    ]);
    const emb = new OpenAiEmbeddingService(client(fetchImpl), { model: "text-embedding-3-small", dimensions: 3, batchSize: 2 });
    expect(await emb.embedDocuments(["a", "b", "c"])).toEqual([vec(1), vec(2), vec(3)]);
    expect(calls[0]!.url).toBe("https://api.roar.test/v1/embeddings");
    expect(calls[0]!.body).toEqual({ model: "text-embedding-3-small", input: ["a", "b"], encoding_format: "float" });
    await expect(emb.embedQuery("q")).rejects.toThrow(/returned 2 dimensions but EMBEDDING_DIMENSIONS is 3/);
  });

  it("runs a hosted Llama Guard with the same verdict format", async () => {
    const { calls, fetchImpl } = stub([jsonRes({ choices: [{ index: 0, message: { role: "assistant", content: "unsafe\nS2" } }] })]);
    const guard = new OpenAiLlamaGuard(client(fetchImpl), "meta-llama/Llama-Guard-3-8B");
    expect(await guard.check([{ role: "user", content: "help me forge receipts" }])).toEqual({ safe: false, codes: ["S2"] });
    expect(calls[0]!.body).toMatchObject({ model: "meta-llama/Llama-Guard-3-8B", temperature: 0, max_tokens: 20 });
  });
});

describe("provider configuration", () => {
  const base = { JWT_SECRET: "x".repeat(40), DATABASE_URL: "postgresql://x" };
  const hosted = { ...base, AI_PROVIDER: "openai", AI_BASE_URL: "https://api.roar.test/v1", AI_API_KEY: KEY, CHAT_MODEL: "gpt-4o-mini" };

  it("defaults to local Ollama with the usual models", () => {
    const c = loadConfig(base);
    expect(c.ai).toMatchObject({ provider: "ollama", embeddingProvider: "ollama", guardProvider: "ollama" });
    expect(c.ollama).toMatchObject({ chatModel: "qwen3:8b", embeddingModel: "nomic-embed-text", embeddingDimensions: 768 });
    expect(c.moderation.guard.model).toBe("llama-guard3:1b");
  });

  it("hosted: requires the URL, key and model names, with helpful messages", () => {
    expect(() => loadConfig({ ...base, AI_PROVIDER: "openai", MODERATION_GUARD: "off", EMBEDDING_PROVIDER: "ollama" })).toThrow(
      /AI_BASE_URL: required[\s\S]*AI_API_KEY: required[\s\S]*CHAT_MODEL: set it/,
    );
    expect(() => loadConfig({ ...hosted, GUARD_PROVIDER: "ollama" })).toThrow(/EMBEDDING_MODEL: with hosted embeddings/);
    expect(() => loadConfig({ ...hosted, EMBEDDING_PROVIDER: "ollama" })).toThrow(/GUARD_MODEL: set it to the provider's Llama Guard model/);
  });

  it("hosted chat with local embeddings and local Llama Guard", () => {
    const c = loadConfig({ ...hosted, EMBEDDING_PROVIDER: "ollama", GUARD_PROVIDER: "ollama", AI_PROVIDER_LABEL: "Roar AI" });
    expect(c.ai).toMatchObject({ provider: "openai", embeddingProvider: "ollama", guardProvider: "ollama", label: "Roar AI" });
    expect(c.ollama).toMatchObject({ chatModel: "gpt-4o-mini", embeddingModel: "nomic-embed-text", embeddingDimensions: 768 });
  });

  it("refuses plain http to a remote provider (the key and documents travel over it)", () => {
    expect(() => loadConfig({ ...hosted, AI_BASE_URL: "http://api.roar.test/v1", MODERATION_GUARD: "off", EMBEDDING_PROVIDER: "ollama" })).toThrow(/must use https/);
    expect(loadConfig({ ...hosted, AI_BASE_URL: "http://localhost:8080/v1", MODERATION_GUARD: "off", EMBEDDING_PROVIDER: "ollama" }).ai.baseUrl).toBe("http://localhost:8080/v1");
  });
});
