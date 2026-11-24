import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { OllamaEmbeddingService, taskPrefixes } from "../../src/ai/embeddings.service.js";
import { OllamaLlmService, fromOllamaToolCall } from "../../src/ai/llm.service.js";
import { OllamaClient } from "../../src/ai/ollama.client.js";
import { UpstreamError } from "../../src/lib/errors.js";

type Handler = (req: { url: string; body: any }, res: import("node:http").ServerResponse, n: number) => void | Promise<void>;
let server: Server | undefined;

async function serve(handler: Handler): Promise<string> {
  let n = 0;
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    await handler({ url: req.url ?? "", body }, res, n++);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

const llmOpts = { model: "qwen3:8b", think: false, numCtx: 4096, temperature: 0.2 };

describe("OllamaClient + OllamaLlmService", () => {
  it("sends tools and maps tool calls (non-streaming)", async () => {
    let received: any;
    const host = await serve(({ body }, res) => {
      received = body;
      res.end(JSON.stringify({
        message: { role: "assistant", content: "", tool_calls: [{ function: { name: "calculate", arguments: { a: 1, b: 2, operation: "add" } } }] },
        done: true,
        prompt_eval_count: 10,
        eval_count: 5,
        total_duration: 2_000_000,
      }));
    });
    const llm = new OllamaLlmService(new OllamaClient({ host, timeoutMs: 2000 }), llmOpts);
    const res = await llm.chat({
      messages: [
        { role: "user", content: "1+2" },
        { role: "assistant", content: "", toolCalls: [{ name: "x", arguments: {} }] },
        { role: "tool", toolName: "x", content: "{}" },
      ],
      tools: [{ name: "calculate", description: "calc", parameters: { type: "object" } }],
    });
    expect(res.toolCalls).toEqual([{ name: "calculate", arguments: { a: 1, b: 2, operation: "add" } }]);
    expect(res.usage).toEqual({ promptTokens: 10, completionTokens: 5, durationMs: 2 });
    expect(received).toMatchObject({
      model: "qwen3:8b",
      stream: false,
      think: false,
      options: { temperature: 0.2, num_ctx: 4096 },
      tools: [{ type: "function", function: { name: "calculate" } }],
    });
    expect(received.messages[1]).toEqual({ role: "assistant", content: "", tool_calls: [{ function: { name: "x", arguments: {} } }] });
    expect(received.messages[2]).toEqual({ role: "tool", content: "{}", tool_name: "x" });
  });

  it("parses NDJSON streams even when lines are split across TCP chunks", async () => {
    const host = await serve(async (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const lines =
        [
          { message: { role: "assistant", content: "Hel" }, done: false },
          { message: { role: "assistant", content: "lo ☕" }, done: false },
          { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "t", arguments: "{\"q\":1}" } }] }, done: false },
          { message: { role: "assistant", content: "" }, done: true, eval_count: 3 },
        ]
          .map((l) => JSON.stringify(l))
          .join("\n") + "\n";
      const bytes = Buffer.from(lines);
      // Write in awkward 7-byte slices, splitting JSON lines and multi-byte characters.
      for (let i = 0; i < bytes.length; i += 7) {
        res.write(bytes.subarray(i, i + 7));
        await new Promise((r) => setTimeout(r, 1));
      }
      res.end();
    });
    const tokens: string[] = [];
    const llm = new OllamaLlmService(new OllamaClient({ host, timeoutMs: 2000 }), llmOpts);
    const res = await llm.chat({ messages: [{ role: "user", content: "hi" }], onToken: (t) => tokens.push(t) });
    expect(tokens.join("")).toBe("Hello ☕");
    expect(res.content).toBe("Hello ☕");
    expect(res.toolCalls).toEqual([{ name: "t", arguments: { q: 1 } }]);
    expect(res.usage?.completionTokens).toBe(3);
  });

  it("retries transient 503s but not 404s", async () => {
    const host = await serve(({ url }, res, n) => {
      if (url === "/api/embed" && n < 2) {
        res.writeHead(503).end(JSON.stringify({ error: "loading model" }));
        return;
      }
      if (url === "/api/chat") {
        res.writeHead(404).end(JSON.stringify({ error: "model 'nope' not found" }));
        return;
      }
      res.end(JSON.stringify({ embeddings: [[1, 2, 3]] }));
    });
    const client = new OllamaClient({ host, timeoutMs: 2000, retries: 2 });
    expect(await client.embed("m", ["x"])).toEqual([[1, 2, 3]]);
    await expect(client.chat({ model: "nope", messages: [] })).rejects.toThrow(/not found.*ollama pull/);
  });

  it("times out without retrying and surfaces caller aborts", async () => {
    let calls = 0;
    const host = await serve(() => {
      calls++; // never respond
    });
    const client = new OllamaClient({ host, timeoutMs: 100, retries: 2 });
    const err = await client.chat({ model: "m", messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.timedOut).toBe(true);
    expect(calls).toBe(1);

    const controller = new AbortController();
    const p = new OllamaClient({ host, timeoutMs: 5000 }).chat({ model: "m", messages: [] }, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("user went away")), 20);
    await expect(p).rejects.toThrow("user went away");
  });

  it("reports an unreachable host clearly", async () => {
    const client = new OllamaClient({ host: "http://127.0.0.1:1", timeoutMs: 1000, retries: 0 });
    await expect(client.listModels()).rejects.toThrow(/cannot reach Ollama/);
  });

  it("propagates in-stream errors", async () => {
    const host = await serve((_req, res) => {
      res.end(JSON.stringify({ error: "out of memory" }) + "\n");
    });
    const llm = new OllamaLlmService(new OllamaClient({ host, timeoutMs: 1000 }), llmOpts);
    await expect(llm.chat({ messages: [], onToken: () => {} })).rejects.toThrow("out of memory");
  });
});

describe("OllamaEmbeddingService", () => {
  it("batches inputs, applies nomic task prefixes and checks dimensions", async () => {
    const batches: string[][] = [];
    const host = await serve(({ body }, res) => {
      batches.push(body.input);
      res.end(JSON.stringify({ embeddings: body.input.map(() => [0.1, 0.2]) }));
    });
    const svc = new OllamaEmbeddingService(new OllamaClient({ host, timeoutMs: 1000 }), {
      model: "nomic-embed-text",
      dimensions: 2,
      batchSize: 2,
    });
    const out = await svc.embedDocuments(["a", "b", "c"]);
    expect(out).toHaveLength(3);
    expect(batches).toEqual([["search_document: a", "search_document: b"], ["search_document: c"]]);
    await svc.embedQuery("q");
    expect(batches.at(-1)).toEqual(["search_query: q"]);

    const wrongDims = new OllamaEmbeddingService(new OllamaClient({ host, timeoutMs: 1000 }), { model: "nomic-embed-text", dimensions: 768 });
    await expect(wrongDims.embedQuery("q")).rejects.toThrow(/returned 2 dimensions/);
  });

  it("uses no prefixes for other models", () => {
    expect(taskPrefixes("mxbai-embed-large")).toEqual({ document: "", query: "" });
  });
});

describe("fromOllamaToolCall", () => {
  it("tolerates string, empty and malformed arguments", () => {
    expect(fromOllamaToolCall({ function: { name: "a", arguments: "" } }).arguments).toEqual({});
    expect(fromOllamaToolCall({ function: { name: "a", arguments: "not json" } }).arguments).toEqual({ __raw: "not json" });
    expect(fromOllamaToolCall({ function: { name: "a", arguments: "[1]" } }).arguments).toEqual({});
    expect(fromOllamaToolCall({ id: "c1", function: { name: "a", arguments: { x: 1 } } })).toEqual({ id: "c1", name: "a", arguments: { x: 1 } });
  });
});
