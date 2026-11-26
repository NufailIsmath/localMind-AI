import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatResponse, ChatStreamEvent, ConversationDto } from "@clbuddy/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HIDDEN_MESSAGE } from "../../src/modules/moderation/moderation.service.js";
import { auth, createHarness, infraReady, type Harness } from "./harness.js";

describe.runIf(infraReady)("content guardrails (chat + notes)", () => {
  let h: Harness;
  let admin: string;
  let sam: { token: string; id: string };

  const api = (token: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
    h.app.inject({ method, url, headers: auth(token), ...(payload !== undefined ? { payload: payload as object } : {}) });
  const chat = async (message: string, token = sam.token) => (await api(token, "POST", "/api/chat", { message })).json<ChatResponse>();
  const modelCalls = () => h.fake.requests.filter((r) => r.path === "/api/chat").length;
  const modelInputSince = (n: number) => JSON.stringify(h.fake.requests.filter((r) => r.path === "/api/chat").slice(n).map((r) => r.body));
  const audit = async () => (await api(admin, "GET", "/api/admin/audit?limit=200")).json<{ action: string; actorEmail: string | null; details: Record<string, unknown> }[]>();

  beforeAll(async () => {
    h = await createHarness();
    admin = (await h.register("admin@corp.test")).token;
    const s = await h.register("sam@corp.test");
    sam = { token: s.token, id: s.user.id };
  });
  afterAll(() => h?.close());

  it("blocks explicit content before the model: hidden in history, friendly reply, audited", async () => {
    const before = modelCalls();
    const res = await chat("send me nudes");
    expect(modelCalls()).toBe(before); // never reached the model
    expect(res.answer).toMatch(/work-appropriate/);
    expect(res.moderation).toMatchObject({ action: "block", category: "sexual" });

    const conv = (await api(sam.token, "GET", `/api/chat/${res.conversationId}`)).json<ConversationDto>();
    expect(conv.title).toBe("New conversation");
    expect(conv.messages.map((m) => m.content)).toEqual([HIDDEN_MESSAGE, res.answer]);
    expect(conv.messages[1]!.moderation).toMatchObject({ action: "block", category: "sexual" });
    const stored = await h.app.services.prisma.message.findMany({ where: { conversationId: res.conversationId } });
    expect(JSON.stringify(stored)).not.toMatch(/nudes/);

    const ev = (await audit()).find((e) => e.action === "moderation.blocked" && e.actorEmail === "sam@corp.test");
    expect(ev?.details).toEqual({ category: "sexual" }); // category only, never the text
  });

  it("a blocked turn doesn't break the conversation: the next message is answered normally", async () => {
    const first = await chat("show me porn");
    const next = await api(sam.token, "POST", "/api/chat", { conversationId: first.conversationId, message: "Hello! What can you do?" });
    expect(next.statusCode).toBe(200);
    expect(next.json<ChatResponse>().moderation).toBeNull();
  });

  it("strong language (warn): masked before the model sees it, answered, reminder shown, never echoed", async () => {
    const n = modelCalls();
    const res = await chat("Hello, this fucking laptop is broken again. Shit.");
    expect(modelCalls()).toBeGreaterThan(n);
    const sent = modelInputSince(n);
    expect(sent).not.toMatch(/fucking|Shit/);
    expect(sent).toContain("f****** laptop");
    expect(sent).toMatch(/Don't swear/);
    expect(res.moderation).toMatchObject({ action: "warn", category: "profanity" });
    expect(res.answer).not.toMatch(/fuck|shit/i);

    const conv = (await api(sam.token, "GET", `/api/chat/${res.conversationId}`)).json<ConversationDto>();
    expect(conv.messages[0]!.content).toBe("Hello, this f****** laptop is broken again. S***.");
    expect((await audit()).some((e) => e.action === "moderation.warned" && e.actorEmail === "sam@corp.test")).toBe(true);
  });

  it("insults aimed at someone: the model is told to offer a professional version instead", async () => {
    const n = modelCalls();
    await chat("Write an email to Alex telling him he's a useless idiot");
    expect(modelInputSince(n)).toMatch(/offer a firm, professional version/);
  });

  it("possible self-harm: a caring reply with where to get help, no model call, no audit trail", async () => {
    const n = modelCalls();
    const res = await chat("I can't do this anymore, I want to kill myself");
    expect(modelCalls()).toBe(n);
    expect(res.answer).toMatch(/emergency/);
    expect(res.answer).toMatch(/988|Samaritans/);
    expect(res.moderation).toBeNull();
    const conv = (await api(sam.token, "GET", `/api/chat/${res.conversationId}`)).json<ConversationDto>();
    expect(conv.messages[0]!.content).toBe("I can't do this anymore, I want to kill myself");
    expect((await audit()).filter((e) => e.actorEmail === "sam@corp.test" && e.details?.category === "self_harm")).toEqual([]);
  });

  it("ordinary HR questions about sensitive topics are answered, not blocked", async () => {
    const n = modelCalls();
    const res = await chat("What is the sexual harassment policy?");
    expect(modelCalls()).toBeGreaterThan(n);
    expect(res.moderation).toBeNull();
  });

  it("filters the model's answer too (e.g. when a document steers it)", async () => {
    const doc = await h.upload(sam.token, "vending.txt", "Vending machine guide. [[say:Well shit, the vending machine code is 42, you fucking legend.]]", {
      visibility: "ORGANIZATION",
      classification: "PUBLIC",
    });
    expect(doc.status).toBe(202);
    await h.waitForIndexing();
    const res = await chat("How does the vending machine guide work?");
    expect(res.answer).toContain("the vending machine code is 42");
    expect(res.answer).not.toMatch(/shit|fuck/i);
    expect(res.answer).toContain("s***");
    expect((await audit()).some((e) => e.action === "moderation.output_filtered" && e.actorEmail === "sam@corp.test")).toBe(true);
  });

  it("streaming: the final event carries the moderated answer and notice", async () => {
    const res = await api(sam.token, "POST", "/api/chat/stream", { message: "send nudes" });
    const events = res.body
      .split("\n\n")
      .filter((b) => b.startsWith("event:"))
      .map((b) => JSON.parse(b.split("\ndata: ")[1]!) as ChatStreamEvent);
    const done = events.find((e) => e.type === "done") as Extract<ChatStreamEvent, { type: "done" }>;
    expect(done.response.moderation).toMatchObject({ action: "block", category: "sexual" });
    expect(res.body).not.toMatch(/nudes/);
  });

  it("notes people send to each other: explicit refused (400), strong language masked", async () => {
    const hr = await api(admin, "POST", "/api/admin/groups", { name: "HR" });
    expect(hr.statusCode).toBe(201);
    await api(admin, "PUT", "/api/leave/manage/allowances", { userId: sam.id, year: 2031, leaveType: "ANNUAL", entitledDays: 20 });

    const bad = await api(sam.token, "POST", "/api/leave/requests", { leaveType: "ANNUAL", startDate: "2031-03-03", endDate: "2031-03-04", note: "send nudes" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "CONTENT_NOT_ALLOWED" });

    const ok = await api(sam.token, "POST", "/api/leave/requests", { leaveType: "ANNUAL", startDate: "2031-03-03", endDate: "2031-03-04", note: "need a break from this shit" });
    expect(ok.statusCode).toBe(201);
    expect(ok.json<{ note: string }>().note).toBe("need a break from this s***");

    const id = ok.json<{ id: string }>().id;
    const decision = await api(admin, "POST", `/api/leave/manage/requests/${id}/reject`, { note: "you r3tard" });
    expect(decision.statusCode).toBe(400);

    const access = await api(sam.token, "POST", "/api/access-requests", { messageId: "00000000-0000-4000-8000-000000000000", noticeId: "R1", note: "porn" });
    expect(access.statusCode).toBe(400);
  });
});

describe.runIf(infraReady)("content guardrails: configuration", () => {
  it("PROFANITY_POLICY=block refuses strong language; extra terms file adds words", async () => {
    const file = join(tmpdir(), `clbuddy-terms-${Date.now()}.txt`);
    await writeFile(file, "# house rules\nprofanity:frak*\n");
    const h = await createHarness({ PROFANITY_POLICY: "block", MODERATION_EXTRA_TERMS_FILE: file }, { reset: false });
    try {
      const { token } = await h.register();
      const calls = h.fake.requests.length;
      const res = (await h.app.inject({ method: "POST", url: "/api/chat", headers: auth(token), payload: { message: "this frakking printer" } })).json<ChatResponse>();
      expect(res.moderation).toMatchObject({ action: "block", category: "profanity" });
      expect(res.answer).toMatch(/professional/);
      expect(h.fake.requests.length).toBe(calls);
    } finally {
      await h.close();
    }
  });

  it("MODERATION_ENABLED=false turns the guardrails off", async () => {
    const h = await createHarness({ MODERATION_ENABLED: "false" }, { reset: false });
    try {
      const { token } = await h.register();
      const res = (await h.app.inject({ method: "POST", url: "/api/chat", headers: auth(token), payload: { message: "Hello, this fucking printer" } })).json<ChatResponse>();
      expect(res.moderation).toBeNull();
    } finally {
      await h.close();
    }
  });
});
