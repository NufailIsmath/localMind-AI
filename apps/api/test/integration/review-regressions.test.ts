import { randomUUID } from "node:crypto";
import type { ChatResponse, DocumentDto } from "@localmind/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { principal, privateAccess } from "../helpers/access.js";
import { auth, createHarness, infraReady, type Harness } from "./harness.js";

/** Regression tests for issues found in code review. */
describe.runIf(infraReady)("review regressions", () => {
  let h: Harness;
  let token: string;
  let userId: string;

  beforeAll(async () => {
    h = await createHarness();
    const res = await h.register("carol@example.com");
    token = res.token;
    userId = res.user.id;
  });
  afterAll(() => h?.close());

  const qdrantCount = async (documentId: string) => {
    const res = await fetch(`${process.env.TEST_QDRANT_URL ?? "http://localhost:6333"}/collections/${h.collection}/points/count`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exact: true, filter: { must: [{ key: "documentId", match: { value: documentId } }] } }),
    });
    return ((await res.json()) as { result: { count: number } }).result.count;
  };

  it("deleting a document while it is being indexed leaves no vectors behind", async () => {
    const up = await h.upload(token, "slow.txt", "SLOW_EMBED_MARKER This document embeds slowly. It mentions zebras.");
    const id = (up.body as DocumentDto).id;
    // Wait until the job is in the embedding step.
    for (let i = 0; i < 50; i++) {
      const doc = await h.app.services.prisma.document.findUnique({ where: { id } });
      if (doc?.status === "PROCESSING") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const del = await h.app.inject({ method: "DELETE", url: `/api/documents/${id}`, headers: auth(token) });
    expect(del.statusCode).toBe(204);
    await h.waitForIndexing();
    expect(await qdrantCount(id)).toBe(0);
    expect(await h.app.services.prisma.document.findUnique({ where: { id } })).toBeNull();
    expect(await h.app.services.retrieval.retrieve(principal(userId), "zebras")).toEqual([]);
  });

  it("on restart, interrupted PROCESSING documents are failed (no crash loop) and PENDING ones re-queued", async () => {
    const a = (await h.upload(token, "a.txt", "Alpha document about apples.")).body as DocumentDto;
    const b = (await h.upload(token, "b.txt", "Beta document about bananas.")).body as DocumentDto;
    await h.waitForIndexing();
    const prisma = h.app.services.prisma;
    await prisma.document.update({ where: { id: a.id }, data: { status: "PROCESSING" } });
    await prisma.document.update({ where: { id: b.id }, data: { status: "PENDING" } });

    expect(await h.app.services.ingestion.recoverInterrupted()).toBe(1);
    await h.waitForIndexing();
    expect(await prisma.document.findUnique({ where: { id: a.id } })).toMatchObject({ status: "FAILED", chunkCount: 0 });
    expect(await prisma.documentChunk.count({ where: { documentId: a.id } })).toBe(0);
    expect(await qdrantCount(a.id)).toBe(0);
    expect(await prisma.document.findUnique({ where: { id: b.id } })).toMatchObject({ status: "READY" });

    // ...and the failed one can be re-indexed by the user.
    const re = await h.app.inject({ method: "POST", url: `/api/documents/${a.id}/reindex`, headers: auth(token) });
    expect(re.statusCode).toBe(202);
    await h.waitForIndexing();
    expect(await prisma.document.findUnique({ where: { id: a.id } })).toMatchObject({ status: "READY" });
  });

  it("ignores orphaned vectors whose document no longer exists", async () => {
    const ghost = randomUUID();
    const vector = await h.app.services.embeddings.embedQuery("orphaned walrus facts");
    await h.app.services.vectors.upsert([
      {
        id: randomUUID(),
        vector,
        payload: { ...privateAccess(userId), documentId: ghost, fileName: "ghost.txt", chunkIndex: 0, content: "orphaned walrus facts", pageStart: null, pageEnd: null },
      },
    ]);
    expect(await qdrantCount(ghost)).toBe(1);
    expect(await h.app.services.retrieval.retrieve(principal(userId), "orphaned walrus facts")).toEqual([]);
  });

  it("accepts messages containing NUL characters instead of failing with 500", async () => {
    const res = await h.app.inject({ method: "POST", url: "/api/chat", headers: auth(token), payload: { message: "hello\u0000 there" } });
    expect(res.statusCode).toBe(200);
    expect((await h.app.inject({ method: "POST", url: "/api/chat", headers: auth(token), payload: { message: "\u0000" } })).statusCode).toBe(400);
  });

  it("does not replay unanswered user messages from failed turns", async () => {
    const first = (await h.app.inject({ method: "POST", url: "/api/chat", headers: auth(token), payload: { message: "hello" } })).json<ChatResponse>();
    const failed = await h.app.inject({
      method: "POST",
      url: "/api/chat",
      headers: auth(token),
      payload: { conversationId: first.conversationId, message: "[fail-llm] boom" },
    });
    expect(failed.statusCode).toBe(502);
    await h.app.inject({ method: "POST", url: "/api/chat", headers: auth(token), payload: { conversationId: first.conversationId, message: "hi again" } });
    const last = h.fake.requests.filter((r) => r.path === "/api/chat").at(-1)!.body as { messages: { role: string; content: string }[] };
    expect(last.messages.map((m) => m.content)).not.toContain("[fail-llm] boom");
    expect(last.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("does not expose internal hostnames from the unauthenticated health endpoint", async () => {
    const down = await createHarness({ OLLAMA_HOST: "http://127.0.0.1:1" }, { reset: false });
    try {
      const { token } = await down.register();
      const body = (await down.app.inject({ method: "GET", url: "/api/health", headers: auth(token) })).json();
      expect(body.checks.ollama).toEqual({ ok: false, detail: "cannot reach Ollama" });
      expect(JSON.stringify(body)).not.toContain("127.0.0.1");
    } finally {
      await down.close();
    }
  });

  it("concurrent first registrations produce exactly one admin", async () => {
    await h.app.services.prisma.$executeRawUnsafe('TRUNCATE "User" CASCADE');
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        h.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: `race${i}@example.com`, password: "password123" } }),
      ),
    );
    const roles = results.map((r) => r.json().user.role);
    expect(roles.filter((r: string) => r === "ADMIN")).toHaveLength(1);
  });
});
