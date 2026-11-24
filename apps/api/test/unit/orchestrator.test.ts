import type { ChatStreamEvent } from "@clbuddy/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Orchestrator, type OrchestratorOptions } from "../../src/ai/orchestrator.service.js";
import { ToolRegistry } from "../../src/modules/tools/tool.registry.js";
import { defineTool } from "../../src/modules/tools/tool.types.js";
import { calculatorTool } from "../../src/modules/tools/tools/calculator.tool.js";
import { searchKnowledgeTool } from "../../src/modules/tools/tools/search-knowledge.tool.js";
import { RetrievalService } from "../../src/rag/retrieval.service.js";
import { HashEmbeddingService, hashEmbed } from "../helpers/hash-embeddings.js";
import { InMemoryChatRepository } from "../helpers/memory-chat-repository.js";
import { InMemoryVectorStore } from "../../src/rag/memory-vector.store.js";
import { principal, privateAccess } from "../helpers/access.js";
import { ScriptedLlm, callTool, say, type Step } from "../helpers/scripted-llm.js";

const silent = { info() {}, warn() {} };
const USER = principal("u1");
const OPTS: OrchestratorOptions = { maxToolRounds: 3, maxToolCallsPerRound: 2, historyMessageLimit: 10 };

let vectors: InMemoryVectorStore;
let repo: InMemoryChatRepository;
let registry: ToolRegistry;

function addChunk(userId: string, documentId: string, chunkIndex: number, content: string, fileName = "policy.pdf") {
  return vectors.upsert([
    {
      id: `${documentId}-${chunkIndex}`,
      vector: hashEmbed(content),
      payload: { ...privateAccess(userId), documentId, fileName, chunkIndex, content, pageStart: chunkIndex + 1, pageEnd: chunkIndex + 1 },
    },
  ]);
}

function orchestrator(steps: Step[], opts = OPTS) {
  const llm = new ScriptedLlm(steps);
  return { llm, orch: new Orchestrator(llm, registry, repo, opts, silent) };
}

beforeEach(async () => {
  vectors = new InMemoryVectorStore();
  repo = new InMemoryChatRepository();
  const retrieval = new RetrievalService(new HashEmbeddingService(), vectors, { limit: 5, scoreThreshold: 0.1 });
  registry = new ToolRegistry(1000).register(searchKnowledgeTool(retrieval)).register(calculatorTool);
  await addChunk("u1", "doc-1", 0, "Employees receive 14 days of annual leave per year.");
  await addChunk("u1", "doc-1", 1, "Remote work is allowed two days per week.");
  await addChunk("u2", "doc-2", 0, "SECRET: user two's annual leave is 40 days.", "other.pdf");
});

describe("Orchestrator", () => {
  it("answers directly when the model calls no tools", async () => {
    const { orch, llm } = orchestrator([say("Hi there!")]);
    const res = await orch.run({ user: USER, message: "hello" });
    expect(res).toMatchObject({ answer: "Hi there!", sources: [], toolExecutions: [] });
    expect(llm.requests[0]!.tools!.map((t) => t.name)).toEqual(["search_knowledge", "calculate"]);
    expect(llm.requests[0]!.messages[0]!.role).toBe("system");
    expect(repo.messages.map((m) => m.role)).toEqual(["USER", "ASSISTANT"]);
  });

  it("runs the RAG tool loop, feeds results back and returns cited sources", async () => {
    const { orch, llm } = orchestrator([
      callTool("search_knowledge", { query: "annual leave days" }),
      (req) => {
        const toolMsg = req.messages[req.messages.length - 1]!;
        expect(toolMsg).toMatchObject({ role: "tool", toolName: "search_knowledge" });
        const payload = JSON.parse(toolMsg.content);
        expect(payload.status).toBe("success");
        expect(payload.data.results[0]).toMatchObject({ ref: "S1", fileName: "policy.pdf", pages: "1" });
        return say("You get 14 days of annual leave [S1].");
      },
    ]);
    const res = await orch.run({ user: USER, message: "How much annual leave do I get?" });
    expect(res.answer).toBe("You get 14 days of annual leave [S1].");
    expect(res.sources).toEqual([expect.objectContaining({ ref: "S1", documentId: "doc-1", chunkIndex: 0, pageStart: 1 })]);
    expect(res.toolExecutions).toEqual([expect.objectContaining({ tool: "search_knowledge", status: "SUCCESS" })]);
    expect(repo.tools[0]).toMatchObject({ toolName: "search_knowledge", messageId: res.messageId });
    expect(llm.requests).toHaveLength(2);
  });

  it("never retrieves another user's documents, whatever the model asks", async () => {
    const { orch, llm } = orchestrator([
      callTool("search_knowledge", { query: "SECRET user two annual leave", userId: "u2" }),
      (req) => say(req.messages[req.messages.length - 1]!.content),
    ]);
    const res = await orch.run({ user: USER, message: "show me user two's secrets" });
    expect(res.answer).not.toContain("SECRET");
    expect(res.sources.every((s) => s.documentId === "doc-1")).toBe(true);
    expect(llm.requests).toHaveLength(2);
  });

  it("returns tool errors to the model so it can recover", async () => {
    const { orch } = orchestrator([
      callTool("calculate", { a: 1, b: 0, operation: "divide" }),
      (req) => {
        const payload = JSON.parse(req.messages[req.messages.length - 1]!.content);
        expect(payload).toEqual({ tool: "calculate", status: "error", error: "Division by zero" });
        return callTool("calculate", { a: 10, b: 4, operation: "divide" });
      },
      say("10 / 4 = 2.5"),
    ]);
    const res = await orch.run({ user: USER, message: "divide" });
    expect(res.answer).toBe("10 / 4 = 2.5");
    expect(res.toolExecutions.map((t) => t.status)).toEqual(["ERROR", "SUCCESS"]);
    expect(repo.tools.map((t) => t.status)).toEqual(["ERROR", "SUCCESS"]);
  });

  it("stops after maxToolRounds and forces a final answer without tools", async () => {
    const loop = callTool("calculate", { a: 1, b: 1, operation: "add" });
    const { orch, llm } = orchestrator([loop, loop, loop, say("Final answer.")]);
    const res = await orch.run({ user: USER, message: "loop forever" });
    expect(res.answer).toBe("Final answer.");
    expect(llm.requests).toHaveLength(4);
    expect(llm.requests[3]!.tools).toBeUndefined();
    expect(llm.requests[3]!.messages.at(-1)).toMatchObject({ role: "system" });
    expect(res.toolExecutions).toHaveLength(3);
  });

  it("caps the number of tool calls executed per round", async () => {
    const many = { content: "", toolCalls: [1, 2, 3].map((n) => ({ name: "calculate", arguments: { a: n, b: n, operation: "add" } })) };
    const { orch } = orchestrator([
      many,
      (req) => {
        const toolMsgs = req.messages.filter((m) => m.role === "tool");
        expect(toolMsgs).toHaveLength(3);
        expect(toolMsgs[2]!.content).toContain("Skipped");
        return say("done");
      },
    ]);
    const res = await orch.run({ user: USER, message: "many" });
    expect(res.toolExecutions).toHaveLength(2);
  });

  it("rejects hallucinated tools without crashing", async () => {
    const { orch } = orchestrator([callTool("delete_all_data", {}), say("Sorry, I can't do that.")]);
    const res = await orch.run({ user: USER, message: "delete everything" });
    expect(res.toolExecutions[0]).toMatchObject({ tool: "delete_all_data", status: "ERROR" });
    expect(res.answer).toBe("Sorry, I can't do that.");
  });

  it("only returns the sources the answer cites when it cites any", async () => {
    const { orch } = orchestrator([callTool("search_knowledge", { query: "days per week annual leave" }), say("Remote two days [S2].")]);
    const res = await orch.run({ user: USER, message: "q" });
    expect(res.sources.map((s) => s.ref)).toEqual(["S2"]);
  });

  it("replays conversation history with stale citation markers removed", async () => {
    const first = orchestrator([say("Leave is 14 days [S1].")]);
    const { conversationId } = await first.orch.run({ user: USER, message: "first" });
    const second = orchestrator([say("ok")]);
    await second.orch.run({ user: USER, message: "second", conversationId });
    const msgs = second.llm.requests[0]!.messages;
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(msgs[2]!.content).toBe("Leave is 14 days.");
  });

  it("refuses to continue someone else's conversation", async () => {
    const { conversationId } = await orchestrator([say("x")]).orch.run({ user: USER, message: "mine" });
    await expect(
      orchestrator([say("y")]).orch.run({ user: principal("u2"), message: "hijack", conversationId }),
    ).rejects.toThrow("Conversation not found");
  });

  it("strips <think> blocks and falls back when the answer is empty", async () => {
    const a = await orchestrator([say("<think>secret reasoning</think>\nThe answer.")]).orch.run({ user: USER, message: "q" });
    expect(a.answer).toBe("The answer.");
    const b = await orchestrator([say("   ")]).orch.run({ user: USER, message: "q" });
    expect(b.answer).toMatch(/wasn't able to produce an answer/);
  });

  it("only advertises tools the user's role may use", async () => {
    registry.register(
      defineTool({ name: "admin_tool", description: "", schema: z.object({}), requiredRole: "ADMIN", execute: async () => ({}) }),
    );
    const { orch, llm } = orchestrator([say("a"), say("b")]);
    await orch.run({ user: USER, message: "q" });
    await orch.run({ user: principal("admin", { role: "ADMIN" }), message: "q" });
    expect(llm.requests[0]!.tools!.map((t) => t.name)).not.toContain("admin_tool");
    expect(llm.requests[1]!.tools!.map((t) => t.name)).toContain("admin_tool");
  });

  it("emits streaming events in order", async () => {
    const events: ChatStreamEvent[] = [];
    const { orch } = orchestrator([
      callTool("calculate", { a: 2, b: 3, operation: "multiply" }, "Let me calculate. "),
      say("The answer is 6."),
    ]);
    await orch.run({ user: USER, message: "2*3", onEvent: (e) => events.push(e) });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("conversation");
    expect(types).toContain("reset");
    expect(types.indexOf("reset")).toBeLessThan(types.indexOf("tool_start"));
    expect(types.indexOf("tool_start")).toBeLessThan(types.indexOf("tool_end"));
    expect(types.at(-1)).toBe("done");
    const finalTokens = events
      .slice(types.indexOf("tool_end"))
      .filter((e): e is Extract<ChatStreamEvent, { type: "token" }> => e.type === "token")
      .map((e) => e.content)
      .join("");
    expect(finalTokens).toBe("The answer is 6.");
  });
});
