import type { AccessRequestDto, ChatResponse, ConversationDto, DocumentDto, GroupDto } from "@clbuddy/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toPrincipal } from "../../src/modules/access/access.service.js";
import { auth, createHarness, infraReady, type Harness } from "./harness.js";

/**
 * "Ah-ah, that's confidential" notices and the request-access workflow.
 *
 *   hr      CONFIDENTIAL, HR         owns all three documents
 *   eng     CONFIDENTIAL, Engineering
 *   intern  INTERNAL,     Engineering
 *
 *   compensation  HR group   CONFIDENTIAL → intern: above clearance; eng: not shared (requestable)
 *   onboarding    HR group   INTERNAL     → eng & intern: not shared (requestable)
 *   diary         PRIVATE    INTERNAL     → never acknowledged to anyone
 */
const DOCS = {
  compensation: "Executive compensation. The CEO salary is 480000 dollars per year plus bonus.",
  onboarding: "HR onboarding checklist. New hires receive their laptop and building badge on the first morning.",
  diary: "Private reminder: buy anniversary flowers and book the restaurant for Friday.",
};

describe.runIf(infraReady)("restricted-content notices and access requests", () => {
  let h: Harness;
  const t = {} as Record<"admin" | "hr" | "eng" | "intern", string>;
  const id = {} as Record<keyof typeof t, string>;
  const doc = {} as Record<keyof typeof DOCS, string>;
  let hrGroup: string;

  const api = (who: keyof typeof t, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
    h.app.inject({ method, url, headers: auth(t[who]), ...(payload ? { payload } : {}) });
  const chat = async (who: keyof typeof t, message: string) => (await api(who, "POST", "/api/chat", { message })).json<ChatResponse>();
  const canRetrieve = async (who: keyof typeof t, d: keyof typeof DOCS, q: string) => {
    const p = toPrincipal((await h.app.services.access.loadProfile(id[who]))!);
    return (await h.app.services.retrieval.retrieve(p, q)).some((c) => c.documentId === doc[d]);
  };

  beforeAll(async () => {
    h = await createHarness({ RESTRICTED_NOTICE_SCORE_THRESHOLD: "0.2" });
    for (const who of ["admin", "hr", "eng", "intern"] as const) {
      const r = await h.register(`${who}@corp.test`);
      t[who] = r.token;
      id[who] = r.user.id;
    }
    hrGroup = (await api("admin", "POST", "/api/admin/groups", { name: "HR" })).json<GroupDto>().id;
    const eng = (await api("admin", "POST", "/api/admin/groups", { name: "Engineering" })).json<GroupDto>().id;
    await api("admin", "PATCH", `/api/admin/users/${id.hr}`, { clearance: "CONFIDENTIAL", groupIds: [hrGroup] });
    await api("admin", "PATCH", `/api/admin/users/${id.eng}`, { clearance: "CONFIDENTIAL", groupIds: [eng] });
    await api("admin", "PATCH", `/api/admin/users/${id.intern}`, { clearance: "INTERNAL", groupIds: [eng] });
    const up = async (d: keyof typeof DOCS, fields: Record<string, string>) => {
      const res = await h.upload(t.hr, `${d}.txt`, DOCS[d], fields);
      expect(res.status).toBe(202);
      doc[d] = (res.body as DocumentDto).id;
    };
    await up("compensation", { visibility: "GROUPS", classification: "CONFIDENTIAL", groupIds: hrGroup });
    await up("onboarding", { visibility: "GROUPS", classification: "INTERNAL", groupIds: hrGroup });
    await up("diary", { visibility: "PRIVATE" });
    await h.waitForIndexing();
  });
  afterAll(() => h?.close());

  it("an intern asking for the CEO's salary gets a playful 'confidential' — and nothing else", async () => {
    const res = await chat("intern", "What is the CEO salary?");
    expect(res.answer).toMatch(/confidential/i);
    expect(res.answer).toMatch(/above your clearance/i);
    expect(res.sources).toEqual([]);
    expect(res.restricted).toEqual([
      { id: "R1", reason: "above_clearance", classification: "CONFIDENTIAL", sharedWith: ["HR"], canRequest: false, requestStatus: null },
    ]);
    // No title, content or document id reaches the client…
    const body = JSON.stringify(res);
    for (const leak of ["480000", "compensation", doc.compensation]) expect(body).not.toContain(leak);
    // …or the model.
    const toModel = JSON.stringify(h.fake.requests.filter((r) => r.path === "/api/chat").slice(-2));
    for (const leak of ["480000", "compensation", doc.compensation]) expect(toModel).not.toContain(leak);

    // Requesting access above your clearance is refused.
    const req = await api("intern", "POST", "/api/access-requests", { messageId: res.messageId, noticeId: "R1" });
    expect(req.statusCode).toBe(400);
    expect(req.json().message).toMatch(/clearance/);
  });

  it("shows at most one 'above your clearance' notice, however many restricted documents match", async () => {
    const extra = await h.upload(t.hr, "comp-2025.txt", "Executive compensation 2025. The CEO salary was 450000 dollars per year.", {
      visibility: "GROUPS",
      classification: "CONFIDENTIAL",
      groupIds: hrGroup,
    });
    await h.waitForIndexing();
    const res = await chat("intern", "What is the CEO salary per year?");
    expect(res.restricted.filter((n) => n.reason === "above_clearance")).toHaveLength(1);
    await api("hr", "DELETE", `/api/documents/${(extra.body as DocumentDto).id}`);
  });

  it("can't be silenced by flooding the index with similar private files", async () => {
    // Regression: candidates used to be the top 10 matches across ALL documents, so a pile of
    // private look-alikes could push the real shared document out and suppress the notice.
    for (let i = 0; i < 12; i++) {
      // Near-exact matches for the question (whitespace varies so each file is distinct) outrank the real document.
      await h.upload(t.eng, `decoy-${i}.txt`, `What is the CEO salary?${" ".repeat(i + 1)}`);
    }
    await h.waitForIndexing();
    const res = await chat("intern", "What is the CEO salary?");
    expect(res.restricted).toEqual([expect.objectContaining({ reason: "above_clearance", sharedWith: ["HR"] })]);
  });

  it("never acknowledges someone's private files", async () => {
    const res = await chat("intern", "anniversary flowers restaurant reminder");
    expect(res.restricted).toEqual([]);
    expect(res.answer).toMatch(/couldn't find/);
  });

  describe("request → approve", () => {
    let request: AccessRequestDto;
    let messageId: string;
    let conversationId: string;

    it("offers a request when clearance is sufficient but the document isn't shared", async () => {
      const res = await chat("eng", "What do new hires receive on the first morning according to the onboarding checklist?");
      expect(res.restricted).toEqual([expect.objectContaining({ reason: "not_shared", sharedWith: ["HR"], canRequest: true })]);
      expect(res.answer).toMatch(/confidential/i);
      expect(res.answer).toContain("Ask for access");
      messageId = res.messageId;
      conversationId = res.conversationId;
    });

    it("creates a pending request without revealing the file name, and dedupes repeats", async () => {
      const first = await api("eng", "POST", "/api/access-requests", { messageId, noticeId: "R1", note: "Onboarding a new hire next week" });
      expect(first.statusCode).toBe(201);
      request = first.json<AccessRequestDto>();
      expect(request).toMatchObject({ status: "PENDING", filename: null, documentId: null, sharedWith: ["HR"] });
      const again = await api("eng", "POST", "/api/access-requests", { messageId, noticeId: "R1" });
      expect(again.json<AccessRequestDto>().id).toBe(request.id);

      const conv = (await api("eng", "GET", `/api/chat/${conversationId}`)).json<ConversationDto>();
      expect(conv.messages[1]!.restricted[0]).toMatchObject({ id: "R1", requestStatus: "PENDING" });
    });

    it("rejects forged or foreign notices", async () => {
      expect((await api("intern", "POST", "/api/access-requests", { messageId, noticeId: "R1" })).statusCode).toBe(404);
      expect((await api("eng", "POST", "/api/access-requests", { messageId, noticeId: "R9" })).statusCode).toBe(404);
      expect((await api("eng", "POST", "/api/access-requests", { messageId, noticeId: "../x" })).statusCode).toBe(400);
    });

    it("shows the owner who wants what; non-owners can't decide", async () => {
      const { incoming } = (await api("hr", "GET", "/api/access-requests")).json<{ incoming: AccessRequestDto[] }>();
      expect(incoming).toEqual([
        expect.objectContaining({ id: request.id, filename: "onboarding.txt", requesterEmail: "eng@corp.test", note: "Onboarding a new hire next week" }),
      ]);
      expect((await api("intern", "POST", `/api/access-requests/${request.id}/approve`)).statusCode).toBe(403);
      expect((await api("eng", "POST", `/api/access-requests/${request.id}/approve`)).statusCode).toBe(403);
    });

    it("approval grants that one person access, immediately", async () => {
      const q = "what do new hires receive on the first morning";
      expect(await canRetrieve("eng", "onboarding", q)).toBe(false);
      const res = await api("hr", "POST", `/api/access-requests/${request.id}/approve`);
      expect(res.statusCode).toBe(200);
      expect(await canRetrieve("eng", "onboarding", q)).toBe(true);
      expect(await canRetrieve("intern", "onboarding", q)).toBe(false);

      const { outgoing } = (await api("eng", "GET", "/api/access-requests")).json<{ outgoing: AccessRequestDto[] }>();
      expect(outgoing[0]).toMatchObject({ status: "APPROVED", filename: "onboarding.txt" });
      const conv = (await api("eng", "GET", `/api/chat/${conversationId}`)).json<ConversationDto>();
      expect(conv.messages[1]!.restricted[0]!.requestStatus).toBe("APPROVED");

      const again = await chat("eng", "What do new hires receive on the first morning according to the onboarding checklist?");
      expect(again.restricted).toEqual([]);
      expect(again.sources[0]).toMatchObject({ documentId: doc.onboarding, shared: true });
      expect((await api("hr", "POST", `/api/access-requests/${request.id}/deny`)).statusCode).toBe(409);
      const grants = (await api("hr", "GET", `/api/documents/${doc.onboarding}`)).json<DocumentDto>().grants;
      expect(grants).toEqual([{ id: id.eng, email: "eng@corp.test" }]);
      // Readers don't see the grant list.
      expect((await api("eng", "GET", `/api/documents/${doc.onboarding}`)).json<DocumentDto>().grants).toEqual([]);
    });

    it("the owner can revoke the grant", async () => {
      expect((await api("hr", "DELETE", `/api/documents/${doc.onboarding}/grants/${id.eng}`)).statusCode).toBe(204);
      expect(await canRetrieve("eng", "onboarding", "what do new hires receive on the first morning")).toBe(false);
    });
  });

  it("a denied request leaves access unchanged", async () => {
    const res = await chat("intern", "What do new hires receive on the first morning according to the onboarding checklist?");
    expect(res.restricted[0]).toMatchObject({ reason: "not_shared", canRequest: true });
    const req = (await api("intern", "POST", "/api/access-requests", { messageId: res.messageId, noticeId: "R1" })).json<AccessRequestDto>();
    expect((await api("hr", "POST", `/api/access-requests/${req.id}/deny`)).json()).toMatchObject({ status: "DENIED" });
    expect(await canRetrieve("intern", "onboarding", "what do new hires receive on the first morning")).toBe(false);
  });

  it("approval can't exceed the requester's clearance", async () => {
    const res = await chat("eng", "What is the CEO salary?");
    expect(res.restricted[0]).toMatchObject({ reason: "not_shared", canRequest: true, classification: "CONFIDENTIAL" });
    const req = (await api("eng", "POST", "/api/access-requests", { messageId: res.messageId, noticeId: "R1" })).json<AccessRequestDto>();
    await api("admin", "PATCH", `/api/admin/users/${id.eng}`, { clearance: "INTERNAL" });
    const approve = await api("hr", "POST", `/api/access-requests/${req.id}/approve`);
    expect(approve.statusCode).toBe(409);
    expect(approve.json().message).toMatch(/raise their clearance/);
    await api("admin", "PATCH", `/api/admin/users/${id.eng}`, { clearance: "CONFIDENTIAL" });
  });

  it("records requests and decisions in the audit log", async () => {
    const actions = (await api("admin", "GET", "/api/admin/audit?limit=200")).json<{ action: string }[]>().map((e) => e.action);
    for (const a of ["access_request.created", "access_request.approved", "access_request.denied", "document.grant.revoked"]) {
      expect(actions).toContain(a);
    }
  });
});

describe.runIf(infraReady)("silent mode", () => {
  it("reveals nothing about restricted documents", async () => {
    const h = await createHarness({ ACCESS_DENIAL_MODE: "silent", RESTRICTED_NOTICE_SCORE_THRESHOLD: "0.2" });
    try {
      const owner = await h.register("owner@corp.test");
      const other = await h.register("other@corp.test");
      await h.upload(owner.token, "secret.txt", "The CEO salary is 480000 dollars per year.", { visibility: "ORGANIZATION", classification: "RESTRICTED" });
      await h.waitForIndexing();
      const res = (await h.app.inject({ method: "POST", url: "/api/chat", headers: auth(other.token), payload: { message: "What is the CEO salary?" } })).json<ChatResponse>();
      expect(res.restricted).toEqual([]);
      expect(res.answer).not.toMatch(/confidential/i);
      expect(res.answer).toMatch(/couldn't find/);
    } finally {
      await h.close();
    }
  });
});

describe.runIf(infraReady)("restricted-notice rate limit", () => {
  it("goes silent after the hourly cap and audits it", async () => {
    const h = await createHarness({ RESTRICTED_NOTICE_SCORE_THRESHOLD: "0.2", RESTRICTED_NOTICE_HOURLY_LIMIT: "2" });
    try {
      const admin = await h.register("admin@corp.test");
      const owner = await h.register("owner@corp.test");
      const prober = await h.register("prober@corp.test");
      await h.upload(owner.token, "secret.txt", "The CEO salary is 480000 dollars per year.", { visibility: "ORGANIZATION", classification: "RESTRICTED" });
      await h.waitForIndexing();
      const ask = async () =>
        (await h.app.inject({ method: "POST", url: "/api/chat", headers: auth(prober.token), payload: { message: "What is the CEO salary?" } })).json<ChatResponse>();
      expect((await ask()).restricted).toHaveLength(1);
      expect((await ask()).restricted).toHaveLength(1);
      const third = await ask();
      expect(third.restricted).toEqual([]);
      expect(third.answer).not.toMatch(/confidential/i);
      const audit = (await h.app.inject({ method: "GET", url: "/api/admin/audit", headers: auth(admin.token) })).json<{ action: string }[]>();
      expect(audit.map((e) => e.action)).toContain("security.notice_limit_reached");
    } finally {
      await h.close();
    }
  });
});
