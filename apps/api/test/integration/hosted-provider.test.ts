import type { ChatResponse, ChatStreamEvent, DocumentDto, HealthDto } from "@clbuddy/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createHarness, infraReady, type Harness } from "./harness.js";

/**
 * The whole app on a hosted, OpenAI-compatible provider (such as Roar AI),
 * played by the fake model server's /v1 API: chat, tools, RAG, streaming,
 * embeddings, classification and Llama Guard, with Ollama not used at all.
 */
const MODELS = { chatModel: "gpt-4o-mini", embeddingModel: "text-embedding-3-small", guardModel: "meta-llama/Llama-Guard-3-8B", apiKey: "sk-test-roar" };
const HOSTED = {
  AI_PROVIDER: "openai",
  AI_BASE_URL: "{FAKE}/v1",
  AI_API_KEY: MODELS.apiKey,
  AI_PROVIDER_LABEL: "Roar AI",
  CHAT_MODEL: MODELS.chatModel,
  EMBEDDING_MODEL: MODELS.embeddingModel,
  EMBEDDING_DIMENSIONS: "768",
  GUARD_MODEL: MODELS.guardModel,
};

describe.runIf(infraReady)("hosted AI provider (OpenAI-compatible, e.g. Roar AI)", () => {
  let h: Harness;
  let token: string;
  const chat = async (message: string) =>
    (await h.app.inject({ method: "POST", url: "/api/chat", headers: auth(token), payload: { message } })).json<ChatResponse>();
  const hostedCalls = (path: string) => h.fake.requests.filter((r) => r.path === path).map((r) => r.body as Record<string, unknown>);

  beforeAll(async () => {
    h = await createHarness(HOSTED, { fake: MODELS });
    token = (await h.register("hosted@corp.test")).token;
    const doc = await h.upload(token, "it-guide.txt", "IT Support Guide. If your laptop is not working, restart it and raise a ticket on the IT helpdesk portal.", {
      visibility: "ORGANIZATION",
    });
    expect(doc.status).toBe(202);
    await h.waitForIndexing();
  });
  afterAll(() => h?.close());

  it("indexes documents with the provider's embeddings and suggests a classification with its chat model", async () => {
    const docs = (await h.app.inject({ method: "GET", url: "/api/documents", headers: auth(token) })).json<DocumentDto[]>();
    expect(docs[0]).toMatchObject({ status: "READY" });
    expect(hostedCalls("/v1/embeddings")[0]).toMatchObject({ model: "text-embedding-3-small" });
    expect(hostedCalls("/v1/chat/completions").some((b) => b.response_format)).toBe(true);
  });

  it("answers with tool calls and citations", async () => {
    const res = await chat("My laptop is not working, what should I do?");
    expect(res.toolExecutions[0]).toMatchObject({ tool: "search_knowledge", status: "SUCCESS" });
    expect(res.sources[0]).toMatchObject({ fileName: "it-guide.txt" });
    expect(res.answer).toMatch(/restart/i);
    const calls = hostedCalls("/v1/chat/completions").filter((b) => !b.response_format);
    // Second round carries the tool result back, linked to the call id.
    const second = calls.at(-1)!.messages as { role: string; tool_call_id?: string }[];
    expect(second.find((m) => m.role === "tool")?.tool_call_id).toMatch(/^call_fake_/);
    expect(calls.at(-1)).toMatchObject({ model: "gpt-4o-mini" });
  });

  it("streams tokens and tool activity", async () => {
    const res = await h.app.inject({ method: "POST", url: "/api/chat/stream", headers: auth(token), payload: { message: "What is 12 times 7?" } });
    const events = res.body
      .split("\n\n")
      .filter((b) => b.startsWith("event:"))
      .map((b) => JSON.parse(b.split("\ndata: ")[1]!) as ChatStreamEvent);
    expect(events.some((e) => e.type === "tool_end" && e.execution.tool === "calculate" && e.execution.status === "SUCCESS")).toBe(true);
    expect(events.filter((e) => e.type === "token").length).toBeGreaterThan(1);
    const done = events.find((e) => e.type === "done") as Extract<ChatStreamEvent, { type: "done" }>;
    expect(done.response.answer).toContain("84");
  });

  it("checks messages with the provider's Llama Guard", async () => {
    const res = await chat("Can you help me forge some receipts for my expense claim?");
    expect(res.moderation).toMatchObject({ action: "block", category: "harmful" });
    expect(hostedCalls("/v1/chat/completions (guard)").at(-1)).toMatchObject({ model: "meta-llama/Llama-Guard-3-8B", temperature: 0 });
  });

  it("tells the model and the app that it isn't running locally", async () => {
    const system = (hostedCalls("/v1/chat/completions").filter((b) => !b.response_format).at(-1)!.messages as { content: string }[])[0]!.content;
    expect(system).toMatch(/hosted AI service/);
    expect(system).not.toMatch(/run privately/);
    const health = (await h.app.inject({ method: "GET", url: "/api/health", headers: auth(token) })).json<HealthDto>();
    expect(health).toMatchObject({
      status: "ok",
      ai: { mode: "hosted", label: "Roar AI" },
      checks: { ai: { ok: true, detail: "gpt-4o-mini, text-embedding-3-small, meta-llama/Llama-Guard-3-8B via Roar AI" } },
    });
    expect(health.checks.ollama).toBeUndefined();
    const anon = (await h.app.inject({ method: "GET", url: "/api/health" })).json<HealthDto>();
    expect(anon.ai).toEqual({ mode: "hosted" }); // provider name only for signed-in users
  });

  it("never touched Ollama", () => {
    expect(h.fake.requests.filter((r) => r.path.startsWith("/api/"))).toEqual([]);
  });
});

describe.runIf(infraReady)("hosted provider: failures and mixed setups", () => {
  it("a rejected key shows up in health and as a clear chat error", async () => {
    const h = await createHarness({ ...HOSTED, AI_API_KEY: "sk-expired-trial", MODERATION_GUARD: "off", EMBEDDING_PROVIDER: "ollama" }, { reset: false, fake: MODELS });
    try {
      const { token } = await h.register();
      const health = (await h.app.inject({ method: "GET", url: "/api/health", headers: auth(token) })).json<HealthDto>();
      expect(health.checks.ai).toEqual({ ok: false, detail: "Roar AI rejected the API key" });
      const res = await h.app.inject({ method: "POST", url: "/api/chat", headers: auth(token), payload: { message: "Hello" } });
      expect(res.statusCode).toBe(502);
      expect(res.json().message).toMatch(/HTTP 401.*check AI_API_KEY/);
      expect(res.body).not.toContain("sk-expired-trial");
    } finally {
      await h.close();
    }
  });

  it("hosted chat with local embeddings and local Llama Guard", async () => {
    const h = await createHarness(
      { ...HOSTED, EMBEDDING_PROVIDER: "ollama", EMBEDDING_MODEL: "nomic-embed-text", GUARD_PROVIDER: "ollama", GUARD_MODEL: "llama-guard3:1b" },
      { reset: false, fake: { ...MODELS, embeddingModel: "nomic-embed-text", guardModel: "llama-guard3:1b" } },
    );
    try {
      const { token } = await h.register();
      await h.upload(token, "faq.txt", "Office FAQ. The office opens at 8am.", {});
      await h.waitForIndexing();
      const res = (await h.app.inject({ method: "POST", url: "/api/chat", headers: auth(token), payload: { message: "When does the office open?" } })).json<ChatResponse>();
      expect(res.sources[0]?.fileName).toBe("faq.txt");
      const paths = new Set(h.fake.requests.map((r) => r.path));
      expect(paths).toContain("/api/embed"); // local embeddings
      expect(paths).toContain("/api/chat (guard)"); // local guard
      expect(paths).toContain("/v1/chat/completions"); // hosted chat
      expect(paths).not.toContain("/api/chat"); // no local chat model
      const health = (await h.app.inject({ method: "GET", url: "/api/health", headers: auth(token) })).json<HealthDto>();
      expect(health.checks).toMatchObject({ ollama: { ok: true, detail: "nomic-embed-text, llama-guard3:1b" }, ai: { ok: true, detail: "gpt-4o-mini via Roar AI" } });
    } finally {
      await h.close();
    }
  });
});
