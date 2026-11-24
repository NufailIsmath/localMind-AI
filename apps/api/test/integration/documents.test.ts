import type { DocumentDto } from "@localmind/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDocx, makePdf } from "../helpers/fixtures.js";
import { principal } from "../helpers/access.js";
import { auth, createHarness, infraReady, type Harness } from "./harness.js";

const POLICY = `Company Leave Policy.
Full-time employees are entitled to 14 days of paid annual leave per calendar year.
Unused annual leave can be carried over up to a maximum of 5 days.
Employees receive 10 days of paid sick leave each year. A medical certificate is required for absences longer than two consecutive days.
Parental leave is 16 weeks for the primary caregiver and 4 weeks for the secondary caregiver.
Remote work is permitted up to two days per week with manager approval.`;

describe.runIf(infraReady)("documents API (PostgreSQL + Qdrant)", () => {
  let h: Harness;
  let alice: string;
  let bob: string;
  let policyId: string;

  beforeAll(async () => {
    h = await createHarness();
    alice = (await h.register("alice@example.com")).token;
    bob = (await h.register("bob@example.com")).token;
  });
  afterAll(() => h?.close());

  const list = async (token: string) =>
    (await h.app.inject({ method: "GET", url: "/api/documents", headers: auth(token) })).json<DocumentDto[]>();

  it("accepts an upload, indexes it in the background and records chunk metadata", async () => {
    const res = await h.upload(alice, "leave-policy.txt", POLICY);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ filename: "leave-policy.txt", mimeType: "text/plain", visibility: "PRIVATE", owned: true });
    expect(["PENDING", "PROCESSING"]).toContain(res.body.status);
    policyId = res.body.id;

    await h.waitForIndexing();
    const [doc] = await list(alice);
    expect(doc).toMatchObject({ id: policyId, status: "READY", error: null });
    expect(doc!.chunkCount).toBeGreaterThan(1);

    const chunks = await h.app.services.prisma.documentChunk.findMany({ where: { documentId: policyId }, orderBy: { chunkIndex: "asc" } });
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    expect(await h.app.services.prisma.document.findUnique({ where: { id: policyId } })).toMatchObject({ embeddingModel: "nomic-embed-text" });
  });

  it("retrieves relevant chunks from Qdrant, scoped to the owner", async () => {
    const hits = await h.app.services.retrieval.retrieve(principal((await me(alice)).id), "How many days of sick leave do employees get?");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain("10 days of paid sick leave");
    expect(hits[0]!.fileName).toBe("leave-policy.txt");
    expect(hits.every((x, i) => i === 0 || hits[i - 1]!.score >= x.score)).toBe(true);

    const bobHits = await h.app.services.retrieval.retrieve(principal((await me(bob)).id), "How many days of sick leave do employees get?");
    expect(bobHits).toEqual([]);
  });

  it("indexes PDFs with page numbers and DOCX files", async () => {
    const pdf = await h.upload(alice, "benefits.pdf", makePdf(["Dental insurance covers two cleanings per year.", "The gym stipend is 50 dollars per month."]));
    const docx = await h.upload(alice, "onboarding.docx", await makeDocx(["Laptops are issued on the first day.", "Security training must be completed within one week."]));
    expect([pdf.status, docx.status]).toEqual([202, 202]);
    await h.waitForIndexing();

    const docs = await list(alice);
    expect(docs.find((d) => d.filename === "benefits.pdf")).toMatchObject({ status: "READY", pageCount: 2 });
    expect(docs.find((d) => d.filename === "onboarding.docx")).toMatchObject({ status: "READY", pageCount: null });

    const hits = await h.app.services.retrieval.retrieve(principal((await me(alice)).id), "gym stipend per month");
    // Both short pages fit in one chunk, which is cited as spanning pages 1–2.
    expect(hits[0]).toMatchObject({ fileName: "benefits.pdf", pageStart: 1, pageEnd: 2 });
    expect(hits[0]!.content).toContain("gym stipend is 50 dollars");
  });

  it("rejects duplicates, unsupported types, spoofed content and empty files", async () => {
    const dup = await h.upload(alice, "copy-of-policy.txt", POLICY);
    expect(dup.status).toBe(409);
    expect(dup.body.details.documentId).toBe(policyId);

    // The same file is fine for a different user.
    expect((await h.upload(bob, "leave-policy.txt", POLICY)).status).toBe(202);

    expect((await h.upload(alice, "malware.exe", "MZ....")).status).toBe(400);
    expect((await h.upload(alice, "fake.pdf", "not a pdf")).status).toBe(400);
    expect((await h.upload(alice, "empty.txt", "")).status).toBe(400);
    await h.waitForIndexing();
  });

  it("marks documents FAILED when extraction finds no text, and allows re-upload", async () => {
    const scanned = makePdf([""]);
    const res = await h.upload(alice, "scan.pdf", scanned);
    expect(res.status).toBe(202);
    await h.waitForIndexing();
    const doc = (await list(alice)).find((d) => d.id === res.body.id);
    expect(doc).toMatchObject({ status: "FAILED", chunkCount: 0 });
    expect(doc!.error).toMatch(/OCR/);
    // A failed upload does not block re-uploading the same bytes.
    expect((await h.upload(alice, "scan.pdf", scanned)).status).toBe(202);
    await h.waitForIndexing();
  });

  it("rejects oversized uploads", async () => {
    const small = await createHarness({ MAX_UPLOAD_MB: "0.001" }, { reset: false });
    try {
      const { token } = await small.register();
      const res = await small.upload(token, "big.txt", "x".repeat(5000));
      expect(res.status).toBe(413);
    } finally {
      await small.close();
    }
  });

  it("isolates documents between users", async () => {
    const bobDocs = await list(bob);
    expect(bobDocs.every((d) => d.id !== policyId)).toBe(true);
    expect((await h.app.inject({ method: "GET", url: `/api/documents/${policyId}`, headers: auth(bob) })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "DELETE", url: `/api/documents/${policyId}`, headers: auth(bob) })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: `/api/documents/not-a-uuid`, headers: auth(alice) })).statusCode).toBe(400);
  });

  it("re-indexes a document with fresh vectors", async () => {
    const before = await h.app.services.prisma.documentChunk.findMany({ where: { documentId: policyId } });
    const res = await h.app.inject({ method: "POST", url: `/api/documents/${policyId}/reindex`, headers: auth(alice) });
    expect(res.statusCode).toBe(202);
    await h.waitForIndexing();
    const after = await h.app.services.prisma.documentChunk.findMany({ where: { documentId: policyId } });
    expect(after).toHaveLength(before.length);
    expect(after.map((c) => c.vectorId).some((id) => before.some((b) => b.vectorId === id))).toBe(false);
    // Old vectors are gone from Qdrant: total points == chunk count.
    expect(await countPoints(h, policyId)).toBe(after.length);
  });

  it("deletes a document from PostgreSQL, Qdrant and disk", async () => {
    const res = await h.app.inject({ method: "DELETE", url: `/api/documents/${policyId}`, headers: auth(alice) });
    expect(res.statusCode).toBe(204);
    expect(await countPoints(h, policyId)).toBe(0);
    expect(await h.app.services.prisma.documentChunk.count({ where: { documentId: policyId } })).toBe(0);
    const hits = await h.app.services.retrieval.retrieve(principal((await me(alice)).id), "sick leave days");
    expect(hits.every((x) => x.documentId !== policyId)).toBe(true);
  });

  async function me(token: string) {
    return (await h.app.inject({ method: "GET", url: "/api/auth/me", headers: auth(token) })).json<{ id: string }>();
  }
});

async function countPoints(h: Harness, documentId: string): Promise<number> {
  const res = await fetch(`${process.env.TEST_QDRANT_URL ?? "http://localhost:6333"}/collections/${h.collection}/points/count`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ exact: true, filter: { must: [{ key: "documentId", match: { value: documentId } }] } }),
  });
  return ((await res.json()) as { result: { count: number } }).result.count;
}
