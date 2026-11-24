import type { AddressInfo } from "node:net";
import type { ChatResponse, ChatStreamEvent, ConversationDto, ConversationSummaryDto, ToolInfoDto } from "@localmind/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createHarness, infraReady, type Harness } from "./harness.js";

const HANDBOOK = `Employee Handbook.
Full-time employees are entitled to 14 days of paid annual leave per calendar year.
Employees receive 10 days of paid sick leave each year.
The office is open from 8am to 6pm on weekdays.
Expense claims must be submitted within 30 days with receipts attached.`;

describe.runIf(infraReady)("chat API: orchestration, RAG and tool calling end-to-end", () => {
  let h: Harness;
  let admin: string;
  let alice: string;
  let bob: string;
  let conversationId: string;

  beforeAll(async () => {
    h = await createHarness();
    admin = (await h.register("admin@example.com")).token; // first user => ADMIN
    alice = (await h.register("alice@example.com")).token;
    bob = (await h.register("bob@example.com")).token;
    expect((await h.upload(alice, "handbook.txt", HANDBOOK)).status).toBe(202);
    await h.waitForIndexing();
  });
  afterAll(() => h?.close());

  const chat = (token: string, payload: object) => h.app.inject({ method: "POST", url: "/api/chat", headers: auth(token), payload });

  it("answers a document question through search_knowledge with citations", async () => {
    const res = await chat(alice, { message: "How many days of sick leave do employees receive?" });
    expect(res.statusCode).toBe(200);
    const body = res.json<ChatResponse>();
    conversationId = body.conversationId;
    expect(body.answer).toContain("10 days of paid sick leave");
    expect(body.answer).toContain("[S1]");
    expect(body.sources).toEqual([
      expect.objectContaining({ ref: "S1", fileName: "handbook.txt", excerpt: expect.stringContaining("sick leave") }),
    ]);
    expect(body.toolExecutions).toEqual([
      expect.objectContaining({ tool: "search_knowledge", status: "SUCCESS", arguments: { query: "How many days of sick leave do employees receive" } }),
    ]);

    // The model received the tool definitions and the tool result.
    const chatCalls = h.fake.requests.filter((r) => r.path === "/api/chat").map((r) => r.body as any);
    const last = chatCalls.at(-1);
    expect(last.tools.map((t: any) => t.function.name)).toEqual(
      expect.arrayContaining(["search_knowledge", "calculate", "get_current_time", "list_documents", "get_usage_stats"]),
    );
    expect(last.tools.map((t: any) => t.function.name)).not.toContain("get_system_stats");
    expect(last.messages.at(-1)).toMatchObject({ role: "tool", tool_name: "search_knowledge" });
  });

  it("persists the conversation, messages, sources and tool audit trail", async () => {
    const list = await h.app.inject({ method: "GET", url: "/api/chat", headers: auth(alice) });
    expect(list.json<ConversationSummaryDto[]>()).toEqual([
      expect.objectContaining({ id: conversationId, title: "How many days of sick leave do employees receive?" }),
    ]);
    const conv = (await h.app.inject({ method: "GET", url: `/api/chat/${conversationId}`, headers: auth(alice) })).json<ConversationDto>();
    expect(conv.messages.map((m) => m.role)).toEqual(["USER", "ASSISTANT"]);
    expect(conv.messages[1]!.sources[0]).toMatchObject({ fileName: "handbook.txt" });
    expect(conv.messages[1]!.toolExecutions[0]).toMatchObject({ tool: "search_knowledge", status: "SUCCESS" });
    expect(conv.messages[1]!.toolExecutions[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("continues a conversation with history", async () => {
    const res = await chat(alice, { conversationId, message: "What is 1250 divided by 5?" });
    const body = res.json<ChatResponse>();
    expect(body.conversationId).toBe(conversationId);
    expect(body.answer).toBe("The result of 1250 divide 5 is **250**.");
    expect(body.toolExecutions[0]).toMatchObject({ tool: "calculate", arguments: { a: 1250, b: 5, operation: "divide" } });
    const lastRequest = h.fake.requests.filter((r) => r.path === "/api/chat").at(-1)!.body as any;
    const roles = lastRequest.messages.map((m: any) => m.role);
    expect(roles.slice(0, 4)).toEqual(["system", "user", "assistant", "user"]);
    // Stale citation markers are stripped from replayed history.
    expect(lastRequest.messages[2].content).not.toContain("[S1]");
  });

  it("handles tool errors gracefully", async () => {
    const body = (await chat(alice, { message: "What is 7 divided by 0?" })).json<ChatResponse>();
    expect(body.toolExecutions[0]).toMatchObject({ tool: "calculate", status: "ERROR", error: "Division by zero" });
    expect(body.answer).toContain("Division by zero");
  });

  it("queries PostgreSQL through the list_documents and get_usage_stats tools", async () => {
    const docs = (await chat(alice, { message: "Which documents have I uploaded?" })).json<ChatResponse>();
    expect(docs.answer).toBe("You have 1 document(s): handbook.txt (READY).");
    const bobDocs = (await chat(bob, { message: "Which documents have I uploaded?" })).json<ChatResponse>();
    expect(bobDocs.answer).toBe("You have 0 document(s).");
    const stats = (await chat(alice, { message: "Show my usage stats" })).json<ChatResponse>();
    expect(stats.toolExecutions[0]!.tool).toBe("get_usage_stats");
    expect(stats.answer).toMatch(/You have 1 documents, \d+ conversations/);
  });

  it("does not leak documents across users through RAG", async () => {
    const body = (await chat(bob, { message: "How many days of sick leave do employees receive?" })).json<ChatResponse>();
    expect(body.toolExecutions[0]).toMatchObject({ tool: "search_knowledge", status: "SUCCESS" });
    expect(body.sources).toEqual([]);
    expect(body.answer).toBe("I couldn't find anything about that in your documents.");
  });

  it("enforces tool permissions even if the model requests a forbidden tool", async () => {
    const asUser = (await chat(alice, { message: "[admin] system stats please" })).json<ChatResponse>();
    expect(asUser.toolExecutions[0]).toMatchObject({ tool: "get_system_stats", status: "DENIED" });
    expect(asUser.answer).toContain("not allowed");

    const asAdmin = (await chat(admin, { message: "[admin] system stats please" })).json<ChatResponse>();
    expect(asAdmin.toolExecutions[0]).toMatchObject({ tool: "get_system_stats", status: "SUCCESS" });
    expect(asAdmin.answer).toContain('"users":3');
  });

  it("limits tool rounds and still answers", async () => {
    const body = (await chat(alice, { message: "[loop] keep calling tools" })).json<ChatResponse>();
    expect(body.toolExecutions).toHaveLength(5);
    expect(body.answer).toContain("Based on the information gathered so far");
  });

  it("returns 502 when the model backend fails", async () => {
    const res = await chat(alice, { message: "[fail-llm] crash" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "UPSTREAM_ERROR" });
  });

  it("validates input and conversation ownership", async () => {
    expect((await chat(alice, { message: "   " })).statusCode).toBe(400);
    expect((await chat(alice, { message: "x".repeat(8001) })).statusCode).toBe(400);
    expect((await chat(bob, { conversationId, message: "let me in" })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: `/api/chat/${conversationId}`, headers: auth(bob) })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "DELETE", url: `/api/chat/${conversationId}`, headers: auth(bob) })).statusCode).toBe(404);
  });

  it("lists tools by role and exposes the execution audit log", async () => {
    const userTools = (await h.app.inject({ method: "GET", url: "/api/tools", headers: auth(alice) })).json<ToolInfoDto[]>();
    const adminTools = (await h.app.inject({ method: "GET", url: "/api/tools", headers: auth(admin) })).json<ToolInfoDto[]>();
    expect(userTools.map((t) => t.name)).not.toContain("get_system_stats");
    expect(adminTools.find((t) => t.name === "get_system_stats")).toMatchObject({ requiredRole: "ADMIN" });
    expect(userTools.find((t) => t.name === "search_knowledge")!.parameters).toMatchObject({ type: "object", required: ["query"] });

    const log = (await h.app.inject({ method: "GET", url: "/api/tools/executions?limit=100", headers: auth(alice) })).json<any[]>();
    expect(log.length).toBeGreaterThan(5);
    expect(new Set(log.map((e) => e.status))).toEqual(new Set(["SUCCESS", "ERROR", "DENIED"]));
    const bobLog = (await h.app.inject({ method: "GET", url: "/api/tools/executions", headers: auth(bob) })).json<any[]>();
    expect(bobLog.every((e) => e.conversationId !== conversationId)).toBe(true);
  });

  it("streams tokens and tool activity over Server-Sent Events", async () => {
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = h.app.server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
      method: "POST",
      headers: { ...auth(alice), "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ message: "When is the office open?" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");

    const events: ChatStreamEvent[] = [];
    const text = await res.text();
    for (const block of text.split("\n\n")) {
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      if (data) events.push(JSON.parse(data.slice(6)));
    }
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("conversation");
    expect(types).toEqual(expect.arrayContaining(["tool_start", "tool_end", "token", "done"]));
    expect(types.at(-1)).toBe("done");
    const streamed = events.filter((e) => e.type === "token").map((e) => (e as { content: string }).content).join("");
    const done = events.at(-1) as Extract<ChatStreamEvent, { type: "done" }>;
    expect(streamed).toBe(done.response.answer);
    expect(done.response.answer).toContain("8am to 6pm");
    expect(done.response.sources[0]).toMatchObject({ fileName: "handbook.txt" });
  });

  it("reports stream failures as an SSE error event", async () => {
    const { port } = h.app.server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
      method: "POST",
      headers: { ...auth(alice), "content-type": "application/json" },
      body: JSON.stringify({ message: "[fail-llm] crash" }),
    });
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain("simulated model crash");
  });

  it("deletes conversations with their messages and tool logs", async () => {
    const res = await h.app.inject({ method: "DELETE", url: `/api/chat/${conversationId}`, headers: auth(alice) });
    expect(res.statusCode).toBe(204);
    expect(await h.app.services.prisma.message.count({ where: { conversationId } })).toBe(0);
    expect(await h.app.services.prisma.toolExecution.count({ where: { conversationId } })).toBe(0);
  });

  it("reports health of every dependency", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "ok",
      checks: {
        database: { ok: true },
        qdrant: { ok: true },
        ollama: { ok: true, detail: "qwen3:8b, nomic-embed-text" },
      },
    });
  });
});

describe.runIf(infraReady)("health when Ollama is down", () => {
  it("reports degraded status with a reason", async () => {
    const h = await createHarness({ OLLAMA_HOST: "http://127.0.0.1:1" }, { reset: false });
    try {
      const res = await h.app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(503);
      expect(res.json().checks.ollama).toMatchObject({ ok: false, detail: expect.stringContaining("cannot reach Ollama") });
    } finally {
      await h.close();
    }
  });
});
