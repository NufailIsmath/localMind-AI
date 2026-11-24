import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  cleanAssistantContent,
  conversationTitle,
  formatToolResult,
  stripCitations,
} from "../../src/ai/prompt.service.js";
import { loadConfig } from "../../src/config/env.js";
import { TimeoutError, mapWithConcurrency, retry, withTimeout } from "../../src/lib/async.js";
import { JobQueue } from "../../src/lib/job-queue.js";
import { hashPassword, verifyPassword } from "../../src/modules/auth/password.js";

const baseEnv = { JWT_SECRET: "x".repeat(32), DATABASE_URL: "postgresql://u:p@localhost/db" };

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const c = loadConfig(baseEnv);
    expect(c.ollama).toMatchObject({ chatModel: "qwen3:8b", embeddingModel: "nomic-embed-text", embeddingDimensions: 768, think: false });
    expect(c.rag).toMatchObject({ chunkSizeTokens: 600, chunkOverlapTokens: 100, retrievalLimit: 5, maxUploadBytes: 20 * 1024 * 1024 });
    expect(c.corsOrigins).toEqual(["http://localhost:3000"]);
  });
  it("rejects weak secrets and inconsistent chunking", () => {
    expect(() => loadConfig({ ...baseEnv, JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...baseEnv, CHUNK_SIZE_TOKENS: "100", CHUNK_OVERLAP_TOKENS: "100" })).toThrow(/CHUNK_OVERLAP/);
    expect(() => loadConfig({ JWT_SECRET: "x".repeat(32) })).toThrow(/DATABASE_URL/);
  });
  it("parses booleans and lists", () => {
    const c = loadConfig({ ...baseEnv, OLLAMA_THINK: "true", ALLOW_REGISTRATION: "0", CORS_ORIGINS: "http://a, http://b" });
    expect(c.ollama.think).toBe(true);
    expect(c.auth.allowRegistration).toBe(false);
    expect(c.corsOrigins).toEqual(["http://a", "http://b"]);
  });
});

describe("prompt helpers", () => {
  it("only describes tools that are available and includes injection guidance", () => {
    const p = buildSystemPrompt({ tools: [{ name: "calculate", description: "", parameters: {} }], now: new Date("2026-01-02T00:00:00Z") });
    expect(p).toContain("calculate");
    expect(p).not.toContain("search_knowledge");
    expect(p).toMatch(/untrusted DATA/);
    expect(p).toContain("2026-01-02");
  });
  it("serialises and clips tool results", () => {
    expect(JSON.parse(formatToolResult("t", { status: "DENIED", error: "no", durationMs: 1 }))).toEqual({ tool: "t", status: "denied", error: "no" });
    const big = formatToolResult("t", { status: "SUCCESS", output: "x".repeat(50_000), durationMs: 1 });
    expect(big.length).toBeLessThan(17_000);
    expect(JSON.parse(big).truncated).toBe(true);
  });
  it("cleans model output", () => {
    expect(cleanAssistantContent("<think>a\nb</think>  Answer ")).toBe("Answer");
    expect(cleanAssistantContent("dangling reasoning</think>Answer")).toBe("Answer");
    expect(stripCitations("Leave is 14 days [S1][S2].")).toBe("Leave is 14 days.");
  });
  it("derives conversation titles", () => {
    expect(conversationTitle("  What is RAG?\nMore text")).toBe("What is RAG?");
    expect(conversationTitle("x".repeat(100))).toHaveLength(81);
    expect(conversationTitle("   ")).toBe("New conversation");
  });
});

describe("passwords", () => {
  it("hashes with a random salt and verifies", async () => {
    const a = await hashPassword("correct horse");
    const b = await hashPassword("correct horse");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword("correct horse", a)).toBe(true);
    expect(await verifyPassword("wrong", a)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("async utilities", () => {
  it("withTimeout rejects slow work", async () => {
    await expect(withTimeout(new Promise((r) => setTimeout(r, 200)), 10, "op")).rejects.toBeInstanceOf(TimeoutError);
    await expect(withTimeout(Promise.resolve(1), 100, "op")).resolves.toBe(1);
  });
  it("retry stops when shouldRetry says no", async () => {
    let n = 0;
    await expect(retry(async () => { n++; throw new Error("fatal"); }, { retries: 3, baseDelayMs: 1, shouldRetry: () => false })).rejects.toThrow("fatal");
    expect(n).toBe(1);
    let m = 0;
    expect(await retry(async () => { if (++m < 3) throw new Error("flaky"); return "ok"; }, { retries: 3, baseDelayMs: 1 })).toBe("ok");
  });
  it("mapWithConcurrency preserves order and bounds parallelism", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 3, 2], 2, async (x) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, x));
      active--;
      return x * 10;
    });
    expect(out).toEqual([50, 10, 30, 20]);
    expect(peak).toBe(2);
  });
});

describe("JobQueue", () => {
  it("dedupes keys, respects concurrency, survives failures and signals idle", async () => {
    const errors: string[] = [];
    const q = new JobQueue(1, (key) => errors.push(key));
    const order: string[] = [];
    const job = (k: string, fail = false) => async () => {
      order.push(k);
      await new Promise((r) => setTimeout(r, 5));
      if (fail) throw new Error(k);
    };
    expect(q.push("a", job("a", true))).toBe(true);
    expect(q.push("a", job("a"))).toBe(false);
    q.push("b", job("b"));
    await q.onIdle();
    expect(order).toEqual(["a", "b"]);
    expect(errors).toEqual(["a"]);
    await expect(q.onIdle()).resolves.toBeUndefined();
  });
});
