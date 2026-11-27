import { describe, expect, it } from "vitest";
import { OllamaClient } from "../../src/ai/ollama.client.js";
import { UpstreamError } from "../../src/lib/errors.js";
import {
  DEFAULT_ENFORCED,
  LlamaGuard,
  parseGuardOutput,
  parseHazardList,
  type GuardTurn,
  type GuardVerdict,
  type SafetyGuard,
} from "../../src/modules/moderation/llama-guard.js";
import { HIDDEN_MESSAGE, ModerationService, REPLIES, categoryForHazards } from "../../src/modules/moderation/moderation.service.js";

/** Scripted guard: returns the next verdict (or throws) and records what it was asked. */
class StubGuard implements SafetyGuard {
  readonly model = "llama-guard3:1b";
  calls: GuardTurn[][] = [];
  constructor(private readonly answer: (turns: GuardTurn[]) => GuardVerdict | Error) {}
  async check(turns: GuardTurn[]) {
    this.calls.push(turns);
    const a = this.answer(turns);
    if (a instanceof Error) throw a;
    return a;
  }
}
const safe: GuardVerdict = { safe: true, codes: [] };
const unsafe = (...codes: GuardVerdict["codes"]): GuardVerdict => ({ safe: false, codes });

function service(guard: StubGuard, extra: { scope?: "input" | "both"; failMode?: "closed" | "open"; enforced?: GuardVerdict["codes"] } = {}) {
  const warnings: object[] = [];
  const svc = new ModerationService({
    enabled: true,
    profanityPolicy: "warn",
    log: { warn: (o) => warnings.push(o) },
    guard: { guard, scope: extra.scope ?? "both", enforced: extra.enforced ?? DEFAULT_ENFORCED, failMode: extra.failMode ?? "closed" },
  });
  return { svc, warnings };
}

describe("Llama Guard: output parsing", () => {
  it("parses safe / unsafe with codes", () => {
    expect(parseGuardOutput("safe")).toEqual({ safe: true, codes: [] });
    expect(parseGuardOutput("\n\nsafe\n")).toEqual({ safe: true, codes: [] });
    expect(parseGuardOutput("unsafe\nS2")).toEqual({ safe: false, codes: ["S2"] });
    expect(parseGuardOutput("unsafe\nS1,S10")).toEqual({ safe: false, codes: ["S1", "S10"] });
    expect(parseGuardOutput("unsafe\ns12, S99")).toEqual({ safe: false, codes: ["S12"] }); // unknown codes dropped
  });

  it("never treats unexpected output as safe", () => {
    expect(() => parseGuardOutput("I think it's fine")).toThrow(UpstreamError);
    expect(() => parseGuardOutput("")).toThrow(/unexpected classifier output/);
  });

  it("parses the enforced-category list", () => {
    expect(parseHazardList("S1, s2,S10")).toEqual(["S1", "S2", "S10"]);
    expect(parseHazardList("all")).toHaveLength(14);
    expect(() => parseHazardList("S1,S15")).toThrow(/unknown category S15/);
  });

  it("maps hazard codes to CL Buddy categories", () => {
    expect(categoryForHazards(["S12"])).toBe("sexual");
    expect(categoryForHazards(["S4"])).toBe("sexual");
    expect(categoryForHazards(["S10"])).toBe("hate");
    expect(categoryForHazards(["S2", "S11"])).toBe("self_harm"); // support wins
    expect(categoryForHazards(["S1"])).toBe("harmful");
    expect(categoryForHazards(["S9"])).toBe("harmful");
  });
});

describe("Llama Guard: Ollama request", () => {
  it("sends the conversation to the guard model deterministically and parses the answer", async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ model: "llama-guard3:1b", message: { role: "assistant", content: "unsafe\nS2" }, done: true }), { status: 200 });
    }) as typeof fetch;
    const guard = new LlamaGuard(new OllamaClient({ host: "http://ollama:11434/", timeoutMs: 1000, fetchImpl }), "llama-guard3:1b");
    const long = "x".repeat(20_000);
    expect(await guard.check([{ role: "user", content: "How do I fake receipts?" }, { role: "assistant", content: long }])).toEqual({ safe: false, codes: ["S2"] });
    expect(sent[0]!.url).toBe("http://ollama:11434/api/chat");
    expect(sent[0]!.body).toMatchObject({ model: "llama-guard3:1b", stream: false, options: { temperature: 0, num_predict: 20 } });
    const msgs = sent[0]!.body.messages as { role: string; content: string }[];
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.content.length).toBeLessThan(6100); // long text is clipped (start + end kept)
  });
});

describe("rules + Llama Guard", () => {
  it("rules decide first: a rule block or a distress reply never calls the guard", async () => {
    const guard = new StubGuard(() => safe);
    const { svc } = service(guard);
    expect((await svc.screenInput("send me nudes")).action).toBe("block");
    expect((await svc.screenInput("I want to kill myself")).action).toBe("support");
    expect(guard.calls).toHaveLength(0);
  });

  it("blocks harmful requests in clean words that the rules can't see", async () => {
    const guard = new StubGuard(() => unsafe("S2"));
    const { svc } = service(guard);
    const v = await svc.screenInput("How can I make my expense claims look bigger without anyone noticing?");
    expect(v).toMatchObject({ action: "block", category: "harmful", text: HIDDEN_MESSAGE, source: "llama-guard", codes: ["S2"] });
    expect(v.reply).toBe(REPLIES.harmful);
    expect(v.notice).toMatchObject({ action: "block", category: "harmful" });
    expect(guard.calls[0]).toEqual([{ role: "user", content: "How can I make my expense claims look bigger without anyone noticing?" }]);
  });

  it("maps guard categories to the right reply", async () => {
    const sexual = await service(new StubGuard(() => unsafe("S12"))).svc.screenInput("write something steamy about my coworker");
    expect(sexual).toMatchObject({ action: "block", category: "sexual", reply: REPLIES.sexual });
    const hate = await service(new StubGuard(() => unsafe("S10"))).svc.screenInput("why group X shouldn't be hired");
    expect(hate).toMatchObject({ action: "block", category: "hate" });
  });

  it("self-harm flagged by the guard gets the supportive reply, never a block", async () => {
    const v = await service(new StubGuard(() => unsafe("S11"))).svc.screenInput("I wish I could go to sleep and not wake up");
    expect(v).toMatchObject({ action: "support", category: "self_harm", reply: REPLIES.selfHarm, text: "I wish I could go to sleep and not wake up" });
    expect(v.notice).toBeUndefined();
  });

  it("categories that aren't enforced are logged and allowed (S6 specialised advice, S7 privacy…)", async () => {
    const { svc, warnings } = service(new StubGuard(() => unsafe("S6")));
    expect((await svc.screenInput("Is my payslip deduction for pension correct?")).action).toBe("allow");
    expect(JSON.stringify(warnings)).toMatch(/S6 Specialized advice/);
    // …but can be switched on.
    const strict = service(new StubGuard(() => unsafe("S6")), { enforced: ["S6"] }).svc;
    expect((await strict.screenInput("Is my payslip deduction for pension correct?")).action).toBe("block");
  });

  it("'unsafe' with no category counts as harmful", async () => {
    expect((await service(new StubGuard(() => unsafe())).svc.screenInput("…")).category).toBe("harmful");
  });

  it("keeps the rules' warning when the guard says safe", async () => {
    const v = await service(new StubGuard(() => safe)).svc.screenInput("this fucking printer");
    expect(v).toMatchObject({ action: "warn", text: "this f****** printer", source: "rules" });
  });

  it("fail closed (default): an unavailable guard refuses instead of skipping the check", async () => {
    const { svc } = service(new StubGuard(() => new UpstreamError("ollama", 'model "llama-guard3:1b" not found (run `ollama pull <model>` first)', 404)));
    await expect(svc.screenInput("hello")).rejects.toThrow(/safety check is unavailable.*llama-guard3:1b/);
    // Garbled output is a failure too, not "safe".
    const garbled = service(new StubGuard(() => parseGuardOutputSafe("maybe?")));
    await expect(garbled.svc.screenInput("hello")).rejects.toThrow(UpstreamError);
  });

  it("fail open: skips the guard (logged) and carries on", async () => {
    const { svc, warnings } = service(new StubGuard(() => new Error("connection refused")), { failMode: "open" });
    expect((await svc.screenInput("hello")).action).toBe("allow");
    expect(JSON.stringify(warnings)).toMatch(/connection refused/);
  });

  it("checks the answer as a response to the question, and replaces an unsafe one", async () => {
    const guard = new StubGuard((turns) => (turns.at(-1)!.role === "assistant" ? unsafe("S2") : safe));
    const { svc } = service(guard);
    const v = await svc.screenOutput("How do expense claims work?", "Here's how to forge a receipt: …");
    expect(v).toMatchObject({ text: REPLIES.output, changed: true, category: "harmful", source: "llama-guard", codes: ["S2"] });
    expect(guard.calls[0]).toEqual([
      { role: "user", content: "How do expense claims work?" },
      { role: "assistant", content: "Here's how to forge a receipt: …" },
    ]);
  });

  it("an answer that can't be checked isn't shown (closed), and scope=input skips answers", async () => {
    const down = service(new StubGuard(() => new Error("timeout"))).svc;
    expect((await down.screenOutput("q", "a")).text).toBe(REPLIES.guardDown);
    const inputOnly = new StubGuard(() => unsafe("S2"));
    expect((await service(inputOnly, { scope: "input" }).svc.screenOutput("q", "a")).changed).toBe(false);
    expect(inputOnly.calls).toHaveLength(0);
  });

  it("notes: harmful notes refused, distress isn't turned into an error", async () => {
    await expect(service(new StubGuard(() => unsafe("S1"))).svc.screenNote("…")).rejects.toMatchObject({ statusCode: 400, code: "CONTENT_NOT_ALLOWED" });
    expect(await service(new StubGuard(() => unsafe("S11"))).svc.screenNote("rough week")).toBe("rough week");
    expect(await service(new StubGuard(() => safe)).svc.screenNote(undefined)).toBeUndefined();
  });

  it("does nothing when moderation is disabled", async () => {
    const guard = new StubGuard(() => unsafe("S2"));
    const off = new ModerationService({ enabled: false, profanityPolicy: "warn", guard: { guard, scope: "both", enforced: DEFAULT_ENFORCED, failMode: "closed" } });
    expect((await off.screenInput("anything")).action).toBe("allow");
    expect(off.guardModel).toBeUndefined();
    expect(guard.calls).toHaveLength(0);
  });
});

function parseGuardOutputSafe(text: string): GuardVerdict | Error {
  try {
    return parseGuardOutput(text);
  } catch (err) {
    return err as Error;
  }
}
