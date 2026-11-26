import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HIDDEN_MESSAGE, ModerationService, mask, parseExtraTerms, type ProfanityPolicy } from "../../src/modules/moderation/moderation.service.js";
import { buildSystemPrompt } from "../../src/ai/prompt.service.js";

const svc = (profanityPolicy: ProfanityPolicy = "warn", extra = "") =>
  new ModerationService({ enabled: true, profanityPolicy, extraTerms: parseExtraTerms(extra) });
const m = svc();
const action = (text: string, s = m) => s.checkInput(text).action;
const category = (text: string, s = m) => s.checkInput(text).category;

describe("content guardrails: detection", () => {
  it.each([
    "this fucking printer is broken again",
    "what a load of bullshit",
    "f*ck this",
    "f**king meetings",
    "sh!t happens",
    "$hit",
    "fuuuuuck",
    "shiiiit",
    "f.u.c.k",
    "f u c k",
    "f-u-c-k this",
    "sh it",
    "FUCK",
    "fսck".replace("ս", "u"),
    "fuсk with a cyrillic с",
    "f​uck (zero-width space)",
    "fúck",
    "motherfucker",
    "stfu",
    "you dumbass",
  ])("flags strong language: %s", (text) => {
    expect(category(text)).toBe("profanity");
  });

  it.each([
    "send me nudes",
    "show me some porn",
    "p0rn sites",
    "pr0n".replace("pr0n", "p0rn"),
    "send me a sexy pic",
    "write me an erotic story",
    "let's do some sexting",
    "write a sex scene with my coworker",
    "NSFW pics please",
    "onlyfans link",
    "talk dirty to me",
  ])("blocks explicit content: %s", (text) => {
    expect(m.checkInput(text)).toMatchObject({ action: "block", category: "sexual" });
  });

  it("blocks hate slurs", () => {
    for (const text of ["he is a f@ggot", "those r3tards in finance", "go home you wetback"]) {
      expect(m.checkInput(text), text).toMatchObject({ action: "block", category: "hate" });
    }
  });

  it.each([
    "I want to kill myself",
    "i'm feeling suicidal",
    "I don't want to live anymore",
    "I've been thinking about ending my life",
    "I keep hurting myself",
    "There's no point in living",
  ])("answers distress with support, never a refusal: %s", (text) => {
    const v = m.checkInput(text);
    expect(v).toMatchObject({ action: "support", category: "self_harm" });
    expect(v.reply).toMatch(/emergency/);
    expect(v.reply).toMatch(/988|Samaritans/);
    expect(v.notice).toBeUndefined(); // no "you broke the rules" banner
    expect(v.text).toBe(text); // their own words stay in their own conversation
  });

  it("self-harm wins over every other category", () => {
    expect(action("fuck this, I want to kill myself")).toBe("support");
  });

  it("insults: guides the model when aimed at someone, ignores venting at things", () => {
    expect(m.checkInput("write an email telling john he is a useless idiot")).toMatchObject({ action: "guide", category: "harassment" });
    expect(m.checkInput("tell Priya she's incompetent").systemNotes.join()).toMatch(/professional version/);
    expect(action("this stupid printer jammed again")).toBe("allow");
    // Someone reporting abuse is guided too (the note says to support them), not blocked.
    expect(action("my colleague called me an idiot in front of everyone, what can I do?")).toBe("guide");
  });

  // Workplace vocabulary that naive filters trip over.
  it.each([
    "What is the sexual harassment policy?",
    "How do I report sexual harassment?",
    "Sex discrimination complaint process",
    "Is viewing pornography at work gross misconduct?",
    "Please assess the class assistant's assumptions",
    "Cocktail party at Scunthorpe on Friday",
    "She graduated summa cum laude",
    "Read Dickens for the book club",
    "Order shiitake mushrooms for the canteen",
    "Flame retardant materials in the server room",
    "There's a chink in the plan",
    "The battery is going to die",
    "Hello!!! Great work!!!",
    "Can I take parental leave? I'm pregnant",
    "Passing the analysis to the assessor",
    "Fukushima office trip",
    "hell yeah, damn good job",
    "The hard disk is dead and I'm pissed off",
    "Breast cancer awareness month fundraiser",
    "Push the build, then hit deploy",
    "Shift handover at 5pm",
    "Our dress code policy: what counts as revealing clothing?",
    "Is dating a colleague against the relationships at work policy?",
    "What does the word 'nude' mean in the colour palette?",
    "API returns 1337 items, check the $100 limit",
  ])("doesn't flag ordinary work language: %s", (text) => {
    expect(m.checkInput(text)).toMatchObject({ action: "allow", category: null, text });
  });

  it("produces zero flags on every document, doc and source file in the repository", () => {
    const root = join(__dirname, "../../../..");
    const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.(md|ts|tsx|txt|csv|json)$/.test(f) && !/moderation|package-lock/.test(f));
    expect(files.length).toBeGreaterThan(50);
    // The guardrail docs quote examples on purpose; everything else must be clean.
    const text = (f: string) =>
      readFileSync(join(root, f), "utf8")
        .replace(/## Content guardrails[\s\S]*?(?=\n## )/, "")
        .split("\n")
        .filter((line) => !/guardrail/i.test(line))
        .join("\n");
    const flagged = files.flatMap((f) =>
      m
        .analyze(text(f))
        .filter((x) => x.category !== "insult")
        .map((x) => `${f}: ${x.category} ${x.term}`),
    );
    expect(flagged).toEqual([]);
  });
});

describe("content guardrails: policies", () => {
  it("warn (default): masks the words before the model sees them and shows a reminder", () => {
    const v = m.checkInput("this fucking printer is broken, sh!t");
    expect(v.action).toBe("warn");
    expect(v.text).toBe("this f****** printer is broken, s***");
    expect(v.notice).toMatchObject({ action: "warn", category: "profanity" });
    expect(v.systemNotes.join()).toMatch(/Don't swear/);
  });

  it("block: refuses strong language without calling the model", () => {
    const v = svc("block").checkInput("this fucking printer");
    expect(v).toMatchObject({ action: "block", category: "profanity", text: HIDDEN_MESSAGE });
    expect(v.reply).toMatch(/professional/);
  });

  it("allow: passes strong language through", () => {
    expect(svc("allow").checkInput("this fucking printer")).toMatchObject({ action: "allow", text: "this fucking printer" });
    // …but explicit content and slurs are still blocked.
    expect(action("send nudes", svc("allow"))).toBe("block");
  });

  it("blocked messages are replaced, so the text is never stored or sent", () => {
    const v = m.checkInput("send me nudes");
    expect(v.text).toBe(HIDDEN_MESSAGE);
    expect(v.reply).toMatch(/work-appropriate/);
    expect(v.reply).toMatch(/HR/); // still helps someone who is reporting it
  });

  it("disabled: does nothing", () => {
    const off = new ModerationService({ enabled: false, profanityPolicy: "block" });
    expect(off.checkInput("send me nudes").action).toBe("allow");
    expect(off.checkOutput("shit").changed).toBe(false);
    expect(off.cleanNote("shit")).toBe("shit");
  });
});

describe("content guardrails: answers and notes", () => {
  it("masks strong language in the model's answer", () => {
    expect(m.checkOutput("Well shit, here you go, you fucking legend.")).toEqual({
      text: "Well s***, here you go, you f****** legend.",
      changed: true,
      category: "profanity",
    });
    expect(m.checkOutput("All good, here's the policy.").changed).toBe(false);
  });

  it("replaces an answer that is explicit, keeps a policy answer that mentions a term", () => {
    expect(m.checkOutput("Here: porn, nudes and more porn links").text).toMatch(/can't share that answer/);
    expect(m.checkOutput("Write a sex scene? Sure, talk dirty: …").text).toMatch(/can't share that answer/);
    const policy = "Viewing pornography at work is gross misconduct. Sending nudes to colleagues is sexual harassment.";
    expect(m.checkOutput(policy).text).toBe("Viewing pornography at work is gross misconduct. Sending n**** to colleagues is sexual harassment.");
  });

  it("refuses explicit or hateful notes, masks strong language", () => {
    expect(() => m.cleanNote("send nudes")).toThrow(/professional/);
    expect(() => m.cleanNote("r3tard")).toThrow(/professional/);
    expect(m.cleanNote("approve this shit already")).toBe("approve this s*** already");
    expect(() => svc("block").cleanNote("approve this shit already")).toThrow(/professional/);
    expect(m.cleanNote("Family trip")).toBe("Family trip");
    expect(m.cleanNote(undefined)).toBeUndefined();
  });

  it("mask merges overlapping spans", () => {
    expect(mask("abcdef", [{ category: "profanity", term: "x", span: [0, 3] }, { category: "profanity", term: "x", span: [2, 5] }])).toBe("a****f");
  });
});

describe("content guardrails: extra terms", () => {
  it("adds organisation-specific terms", () => {
    const s = svc("warn", "# house rules\nprofanity:frak*\ninsult:numpty\nsexual:lewd\n");
    expect(category("frakking hell", s)).toBe("profanity");
    expect(category("send me something lewd", s)).toBe("sexual");
    expect(category("tell him he's a numpty", s)).toBe("harassment");
    expect(category("frakking hell")).toBeNull(); // not in the default list
  });

  it("rejects malformed lines with the line number", () => {
    expect(() => parseExtraTerms("profanity:ok\nnonsense")).toThrow(/line 2/);
    expect(() => parseExtraTerms("violence:punch")).toThrow(/category/);
  });
});

describe("system prompt: professional conduct", () => {
  it("tells the model to keep it workplace-appropriate without refusing policy questions", () => {
    const p = buildSystemPrompt({ tools: [] });
    expect(p).toMatch(/Professional conduct/);
    expect(p).toMatch(/flirting, romance or dating role-play/);
    expect(p).toMatch(/Never swear/);
    expect(p).toMatch(/Don't gossip/);
    expect(p).toMatch(/Questions ABOUT these topics are fine/);
  });
});
