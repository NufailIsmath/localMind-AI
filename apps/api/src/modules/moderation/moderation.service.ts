import { readFileSync } from "node:fs";
import type { ModerationCategory, ModerationNoticeDto } from "@clbuddy/shared";
import { AppError, UpstreamError, errorMessage } from "../../lib/errors.js";
import { HAZARDS, type GuardTurn, type HazardCode, type SafetyGuard } from "./llama-guard.js";
import { ABUSE_DRAFTING, ALLOW_BIGRAMS, ALLOW_TOKENS, LEXICON, SELF_HARM_PHRASES, SEXUAL_PHRASES, type LexiconCategory, type LexiconEntry } from "./lexicon.js";

export type ProfanityPolicy = "warn" | "block" | "allow";

export interface GuardOptions {
  guard: SafetyGuard;
  /** input: check messages only; both: also check the model's answers. */
  scope: "input" | "both";
  /** Hazard codes acted on; others are logged and allowed. */
  enforced: HazardCode[];
  /** closed: if the classifier is unavailable, refuse rather than skip the check. */
  failMode: "closed" | "open";
}

export interface ModerationLogger {
  warn(obj: object, msg?: string): void;
}

export interface ModerationOptions {
  enabled: boolean;
  profanityPolicy: ProfanityPolicy;
  extraTerms?: LexiconEntry[];
  /** Model-based second layer (Llama Guard). Rules always run first. */
  guard?: GuardOptions;
  log?: ModerationLogger;
}

export interface Finding {
  category: LexiconCategory | "self_harm";
  /** The normalised form that matched (never shown to users). */
  term: string;
  /** Span in the original text, when the finding is a word that can be masked. */
  span?: [number, number];
}

/**
 * What to do with a chat message:
 *  - allow:   send as is
 *  - guide:   send, with an extra instruction to the model (e.g. don't write insults)
 *  - warn:    send with strong language masked, and show the user a gentle reminder
 *  - block:   don't send to the model; answer with `reply`
 *  - support: the user may be in distress; answer with a caring `reply`, never a telling-off
 */
export interface InputVerdict {
  action: "allow" | "guide" | "warn" | "block" | "support";
  category: ModerationCategory | null;
  /** The message to pass on and store (strong language masked when warning). */
  text: string;
  reply?: string;
  notice?: ModerationNoticeDto;
  systemNotes: string[];
  /** Which layer decided (for auditing). */
  source?: "rules" | "llama-guard";
  /** Llama Guard hazard codes, when it flagged the message. */
  codes?: HazardCode[];
}

export interface OutputVerdict {
  text: string;
  changed: boolean;
  category: ModerationCategory | null;
  source?: "rules" | "llama-guard";
  codes?: HazardCode[];
}

// ---------------------------------------------------------------- normalisation

const ZERO_WIDTH = /[​-‍⁠﻿­]/g;
const HOMOGLYPHS: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ѕ": "s", "ԁ": "d", "ӏ": "l", "κ": "k", "ν": "v", "ο": "o", "τ": "t",
};
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i", "|": "i", "+": "t", "€": "e" };
/** A word, including the symbols people use to dodge filters (sh!t, $hit, f*ck) and invisible characters. */
const TOKEN = /[\p{L}\p{M}\p{N}@$!|+*#€'’​-‍⁠﻿­]+/gu;
/** Letters spelled out one at a time: f.u.c.k, f u c k, f-u-c-k. */
const SPELLED = /(?<![\p{L}\p{N}])(?:[\p{L}\p{N}@$](?:[ .\-_·*]{1,3}))+[\p{L}\p{N}@$](?![\p{L}\p{N}])/gu;
const MASK = /[*#]/;

interface Token {
  /** Letters only, lowercase, accents/leetspeak removed. */
  norm: string;
  /** The token had masking characters in the middle (f*ck). */
  masked: boolean;
  /** How many real letters were visible. */
  letters: number;
  start: number;
  end: number;
}

function normaliseWord(raw: string): Omit<Token, "start" | "end"> {
  let s = raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(ZERO_WIDTH, "")
    .replace(/['’]/g, "")
    .toLowerCase();
  s = [...s].map((c) => HOMOGLYPHS[c] ?? c).join("");
  // Punctuation at the edges is just punctuation ("great!", "*really*").
  s = s.replace(/^[!|+*#]+|[!|+*#]+$/g, "");
  const hasLetter = /\p{L}/u.test(s);
  if (hasLetter) s = [...s].map((c) => LEET[c] ?? c).join("");
  const masked = hasLetter && MASK.test(s);
  return { norm: masked ? s.replace(/[^\p{L}*#]/gu, "") : s.replace(/[^\p{L}\p{N}]/gu, ""), masked, letters: (s.match(/\p{L}/gu) ?? []).length };
}

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const t = normaliseWord(m[0]);
    if (t.norm) out.push({ ...t, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const collapseRuns = (s: string) => s.replace(/(.)\1+/g, "$1");
const isStretched = (s: string) => /(.)\1\1/.test(s);

// ---------------------------------------------------------------- matcher

class Matcher {
  private readonly entries: LexiconEntry[];
  /** Every lexicon term plus common inflections, used to resolve masked words like f**king. */
  private readonly forms: { form: string; entry: LexiconEntry }[];

  constructor(extra: LexiconEntry[] = []) {
    this.entries = [...LEXICON, ...extra];
    const suffixes = ["", "s", "es", "ed", "er", "ers", "ing", "in", "y", "ty", "head", "hole"];
    this.forms = this.entries.flatMap((entry) => (entry.kind === "word" ? [{ form: entry.term, entry }] : suffixes.map((s) => ({ form: entry.term + s, entry }))));
  }

  /** The entry a normalised word matches, if any. */
  match(word: string): LexiconEntry | undefined {
    if (word.length < 2 || ALLOW_TOKENS.has(word)) return undefined;
    const direct = this.find(word, false);
    if (direct) return direct;
    // Stretched letters (fuuuck, shiiit): compare with runs collapsed on both sides.
    return isStretched(word) ? this.find(collapseRuns(word), true) : undefined;
  }

  /** Resolves a masked word (f*ck, sh*t, b**ch) when at least two real letters show. */
  matchMasked(word: string, letters: number): LexiconEntry | undefined {
    if (letters < 2 || !/^\p{L}/u.test(word)) return undefined;
    const re = new RegExp(`^${word.replace(/[*#]+/g, (run) => `\\p{L}{1,${run.length + 1}}`)}$`, "u");
    return this.forms.find((f) => re.test(f.form))?.entry;
  }

  private find(word: string, collapsed: boolean): LexiconEntry | undefined {
    for (const e of this.entries) {
      const term = collapsed ? collapseRuns(e.term) : e.term;
      if (e.kind === "word" ? word === term : e.kind === "prefix" ? word.startsWith(term) : word.includes(term)) return e;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------- replies

export const REPLIES = {
  sexual:
    "Whoa, let's keep it work-appropriate! 🙈 I can't help with explicit or sexual content.\n\n" +
    "If you're dealing with something that happened at work, like unwanted messages, images or comments, that's serious and I'd like to help. " +
    "Describe it without the explicit details and I'll walk you through reporting it to HR confidentially.\n\nOtherwise, what can I help you get done today?",
  hate:
    "Let's not use that kind of language. It's hurtful, and it goes against how we treat each other at work.\n\n" +
    "If someone used words like that toward you or a colleague, that's serious. I can help you raise it with HR or your manager, and you won't need to repeat the words.\n\nWhat would you like to do?",
  profanity: "Let's keep it professional 🙂 Mind rephrasing that without the strong language? I'll jump right on it.",
  selfHarm:
    "I'm really sorry you're feeling this way, and I'm glad you said something. You don't have to handle this on your own.\n\n" +
    "- **If you're in immediate danger, call your local emergency number now.**\n" +
    "- **Talk to a crisis line.** They're free, confidential and open any time: for example 988 in the US and Canada, or Samaritans on 116 123 in the UK and Ireland. findahelpline.com lists lines in other countries.\n" +
    "- **Reach out to someone you trust**: a friend, family member, your manager or HR. If the company has an Employee Assistance Programme, it's confidential too.\n\n" +
    "If it would help, I can look up the company's wellbeing or EAP information, or help you write a message to someone you trust. " +
    "And if I've misread you and it's just been a rough day, that's okay too. I'm here either way.",
  harmful:
    "I can't help with that one. 🙅\n\n" +
    "If someone could get hurt, please contact emergency services or your security team right away. " +
    "And if there's a work problem behind this, like a conflict, money worries or pressure to cut corners, I'm happy to help you find the right person to talk to, confidentially.",
  output: "Sorry, I can't share that answer. It didn't meet the content guidelines. Could you ask in a different way?",
  guardDown: "Sorry, I couldn't run the safety check on my answer, so I'm not showing it. Please try again in a moment.",
} as const;

export const NOTICES: Record<"warn" | "block", Partial<Record<ModerationCategory, string>>> = {
  warn: { profanity: "Friendly reminder: let's keep the language professional 🙂" },
  block: {
    sexual: "That message wasn't sent to the assistant: explicit content isn't allowed.",
    hate: "That message wasn't sent to the assistant: it contained hateful language.",
    profanity: "That message wasn't sent to the assistant: strong language isn't allowed here.",
    harmful: "That message wasn't sent to the assistant: it asked for something harmful or against the law.",
  },
};

/** How a Llama Guard verdict maps onto CL Buddy's categories. */
export function categoryForHazards(codes: HazardCode[]): "self_harm" | "sexual" | "hate" | "harmful" {
  if (codes.includes("S11")) return "self_harm";
  if (codes.some((c) => c === "S3" || c === "S4" || c === "S12")) return "sexual";
  if (codes.includes("S10")) return "hate";
  return "harmful";
}

/** Stored instead of a blocked message, so the text never lands in the database or the model's history. */
export const HIDDEN_MESSAGE = "[Message hidden: it didn't meet the content guidelines]";

const NOTE_INSULT =
  "Content note for this turn: the user's message contains insulting language. If they want you to write, send or say something insulting, demeaning or threatening about someone, " +
  "don't. Briefly and kindly say you'll keep it respectful, then offer a firm, professional version that still gets their point across (what happened, its impact, what they need). " +
  "If they're describing how someone treated them, be supportive and help them deal with it or report it.";
const NOTE_PROFANITY =
  "Content note for this turn: the user used strong language (masked as ***). Answer helpfully and calmly. Don't swear, don't repeat or unmask it, and don't lecture; the app already showed them a short reminder.";

// ---------------------------------------------------------------- service

/**
 * Content guardrails for chat and free-text notes.
 *
 * Rule-based and local: it runs before the model sees a message and after it
 * answers, so it works with any model and costs nothing per message. Detection
 * normalises the usual dodges (accents, look-alike letters, leetspeak, masked
 * letters, stretched letters, spelled-out letters, invisible characters) and
 * matches whole words against a deliberately conservative lexicon, so
 * workplace vocabulary ("sexual harassment policy", "class", "assess",
 * "Scunthorpe", "summa cum laude") isn't flagged.
 *
 * Tone and topic (flirting, gossip, role-play) can't be judged by word lists;
 * those are handled by the "professional conduct" section of the system prompt,
 * and, when enabled, by Llama Guard (a local safety classifier) as a second
 * layer behind the rules: see screenInput / screenOutput / screenNote.
 */
export class ModerationService {
  private readonly matcher: Matcher;

  constructor(private readonly opts: ModerationOptions) {
    this.matcher = new Matcher(opts.extraTerms);
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  get profanityPolicy(): ProfanityPolicy {
    return this.opts.profanityPolicy;
  }

  /** Everything that looks inappropriate in a piece of text. */
  analyze(text: string): Finding[] {
    const findings: Finding[] = [];
    const tokens = tokenize(text);
    for (const [i, t] of tokens.entries()) {
      if (ALLOW_BIGRAMS.has(`${t.norm} ${tokens[i + 1]?.norm}`) || ALLOW_BIGRAMS.has(`${tokens[i - 1]?.norm} ${t.norm}`)) continue;
      const entry = t.masked ? this.matcher.matchMasked(t.norm, t.letters) : this.matcher.match(t.norm);
      if (entry) findings.push({ category: entry.category, term: entry.term, span: [t.start, t.end] });
    }
    // Words split to dodge the filter: "f uck", "sh it".
    for (let i = 0; i + 1 < tokens.length; i++) {
      const [a, b] = [tokens[i]!, tokens[i + 1]!];
      if (a.masked || b.masked || Math.min(a.norm.length, b.norm.length) > 2 || /\S/.test(text.slice(a.end, b.start).replace(/[ .\-_]/g, ""))) continue;
      const joined = a.norm + b.norm;
      const entry = this.matcher.match(joined);
      // Only when the pieces together are about the size of the word ("pornography at" isn't a split word).
      if (entry && entry.term.length >= 4 && joined.length <= entry.term.length + 3 && entry.category !== "insult") findings.push({ category: entry.category, term: entry.term, span: [a.start, b.end] });
    }
    // Spelled-out letters: f.u.c.k, f u c k.
    for (const m of text.matchAll(SPELLED)) {
      const word = normaliseWord(m[0].replace(/[ .\-_·*]/g, "")).norm;
      const entry = word.length >= 3 ? this.matcher.match(word) : undefined;
      if (entry && entry.category !== "insult") findings.push({ category: entry.category, term: entry.term, span: [m.index, m.index + m[0].length] });
    }
    // Phrases (on letters-only text, so punctuation and spacing don't matter).
    const flat = ` ${tokens.map((t) => t.norm).join(" ")} `;
    for (const re of SEXUAL_PHRASES) {
      const m = flat.match(re);
      if (m) findings.push({ category: "sexual", term: m[0].trim() });
    }
    for (const re of SELF_HARM_PHRASES) {
      const m = flat.match(re);
      if (m) findings.push({ category: "self_harm", term: m[0].trim() });
    }
    if (findings.some((f) => f.category === "insult") && !ABUSE_DRAFTING.test(flat) && !/\b(you|youre|ur|u|he|hes|she|shes|they|theyre|him|her|them|is|are)\b/.test(flat)) {
      // An insult word with nobody to direct it at ("this stupid printer") is just venting.
      return findings.filter((f) => f.category !== "insult");
    }
    return findings;
  }

  /** Decides what happens to a chat message before it reaches the model. */
  checkInput(text: string): InputVerdict {
    const pass: InputVerdict = { action: "allow", category: null, text, systemNotes: [] };
    if (!this.opts.enabled) return pass;
    const findings = this.analyze(text);
    if (findings.length === 0) return pass;
    const has = (c: Finding["category"]) => findings.some((f) => f.category === c);

    // Someone who may be in crisis gets support first, whatever words they used.
    if (has("self_harm")) return { ...pass, action: "support", category: "self_harm", reply: REPLIES.selfHarm };
    for (const category of ["hate", "sexual"] as const) {
      if (has(category)) return this.block(text, category);
    }
    const notes: string[] = [];
    let verdict: InputVerdict = pass;
    if (has("profanity") && this.opts.profanityPolicy !== "allow") {
      if (this.opts.profanityPolicy === "block") return this.block(text, "profanity");
      verdict = {
        ...pass,
        action: "warn",
        category: "profanity",
        text: mask(text, findings.filter((f) => f.category === "profanity")),
        notice: { action: "warn", category: "profanity", message: NOTICES.warn.profanity! },
      };
      notes.push(NOTE_PROFANITY);
    }
    if (has("insult")) {
      notes.push(NOTE_INSULT);
      if (verdict.action === "allow") verdict = { ...verdict, action: "guide", category: "harassment" };
    }
    return { ...verdict, systemNotes: notes };
  }

  /**
   * Last check on the model's answer (it can be steered by documents or odd
   * prompts). Strong language is masked; an answer that is mostly explicit or
   * hateful is replaced.
   */
  checkOutput(text: string): OutputVerdict {
    if (!this.opts.enabled) return { text, changed: false, category: null };
    const findings = this.analyze(text).filter((f) => f.category !== "insult" && f.category !== "self_harm");
    const severe = findings.filter((f) => f.category === "sexual" || f.category === "hate");
    if (severe.length >= 3 || severe.some((f) => !f.span)) {
      return { text: REPLIES.output, changed: true, category: severe[0]!.category as ModerationCategory };
    }
    const maskable = findings.filter((f) => f.span && (f.category !== "profanity" || this.opts.profanityPolicy !== "allow"));
    if (maskable.length === 0) return { text, changed: false, category: null };
    return { text: mask(text, maskable), changed: true, category: maskable[0]!.category as ModerationCategory };
  }

  /**
   * Free-text notes people send to each other (access requests, leave
   * requests, HR decisions). Explicit or hateful notes are refused; strong
   * language is masked (or refused when PROFANITY_POLICY=block).
   */
  cleanNote(text: string | undefined, field = "note"): string | undefined {
    if (text === undefined || !this.opts.enabled) return text;
    const findings = this.analyze(text).filter((f) => f.category !== "insult" && f.category !== "self_harm");
    const refused = findings.find((f) => f.category === "sexual" || f.category === "hate" || (f.category === "profanity" && this.opts.profanityPolicy === "block"));
    if (refused) {
      throw new AppError(400, "CONTENT_NOT_ALLOWED", `Please keep the ${field} professional: it contains language that isn't allowed.`, { category: refused.category });
    }
    const profane = findings.filter((f) => f.category === "profanity" && f.span);
    return profane.length && this.opts.profanityPolicy === "warn" ? mask(text, profane) : text;
  }

  // ------------------------------------------------ rules + Llama Guard

  get guardModel(): string | undefined {
    return this.opts.enabled ? this.opts.guard?.guard.model : undefined;
  }

  /**
   * Full check of a chat message: the rules first (instant, and they handle
   * strong language, masking and distress), then Llama Guard for what word
   * lists can't see: harmful requests in clean words, euphemisms, other
   * languages.
   */
  async screenInput(text: string, signal?: AbortSignal): Promise<InputVerdict> {
    const rules = { ...this.checkInput(text), source: "rules" as const };
    if (rules.action === "block" || rules.action === "support" || !this.guardActive()) return rules;
    const flagged = await this.classify([{ role: "user", content: text }], signal);
    if (!flagged) return rules;
    const category = categoryForHazards(flagged);
    if (category === "self_harm") return { ...rules, action: "support", category, reply: REPLIES.selfHarm, notice: undefined, text, systemNotes: [], source: "llama-guard", codes: flagged };
    return { ...this.block(text, category), source: "llama-guard", codes: flagged };
  }

  /** Full check of the model's answer: rules (masking), then Llama Guard on the exchange. */
  async screenOutput(question: string, answer: string, signal?: AbortSignal): Promise<OutputVerdict> {
    const rules: OutputVerdict = { ...this.checkOutput(answer), source: "rules" };
    if (!this.guardActive() || this.opts.guard!.scope !== "both" || rules.text === REPLIES.output) return rules;
    let flagged: HazardCode[] | null;
    try {
      flagged = await this.classify([{ role: "user", content: question }, { role: "assistant", content: rules.text }], signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      // Fail closed: an answer that couldn't be checked isn't shown.
      return { text: REPLIES.guardDown, changed: true, category: null, source: "llama-guard" };
    }
    if (!flagged) return rules;
    return { text: REPLIES.output, changed: true, category: categoryForHazards(flagged), source: "llama-guard", codes: flagged };
  }

  /** Notes people send each other: rules, then Llama Guard (harmful notes are refused). */
  async screenNote(text: string | undefined, field = "note", signal?: AbortSignal): Promise<string | undefined> {
    const cleaned = this.cleanNote(text, field);
    if (!cleaned || !this.guardActive()) return cleaned;
    const flagged = await this.classify([{ role: "user", content: cleaned }], signal);
    const category = flagged ? categoryForHazards(flagged) : null;
    // A note that sounds like distress isn't refused; the person needs help, not an error.
    if (category && category !== "self_harm") {
      throw new AppError(400, "CONTENT_NOT_ALLOWED", `Please keep the ${field} professional: it contains content that isn't allowed.`, { category });
    }
    return cleaned;
  }

  private guardActive(): boolean {
    return this.opts.enabled && !!this.opts.guard;
  }

  /**
   * Enforced hazard codes for the conversation's last turn, or null when it's
   * safe. With failMode=open an unavailable classifier counts as safe (logged);
   * with closed (the default) the error propagates.
   */
  private async classify(turns: GuardTurn[], signal?: AbortSignal): Promise<HazardCode[] | null> {
    const g = this.opts.guard!;
    let verdict;
    try {
      verdict = await g.guard.check(turns, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (g.failMode === "open") {
        this.opts.log?.warn({ err: errorMessage(err) }, "Llama Guard unavailable; continuing without it (GUARD_FAIL_MODE=open)");
        return null;
      }
      throw new UpstreamError(
        "llama-guard",
        `the safety check is unavailable (${errorMessage(err).replace(/^ollama: /, "")}). Check that ${g.guard.model} is pulled in Ollama`,
        503,
      );
    }
    if (verdict.safe) return null;
    const enforced = verdict.codes.filter((c) => g.enforced.includes(c));
    if (enforced.length === 0) {
      // "unsafe" with no codes is treated as the most generic enforced category.
      if (verdict.codes.length === 0 && g.enforced.length) return [g.enforced.includes("S2") ? "S2" : g.enforced[0]!];
      this.opts.log?.warn({ codes: verdict.codes.map((c) => `${c} ${HAZARDS[c]}`) }, "Llama Guard flagged a category that isn't enforced; allowed");
      return null;
    }
    return enforced;
  }

  private block(text: string, category: "sexual" | "hate" | "profanity" | "harmful"): InputVerdict {
    return {
      action: "block",
      category,
      text: HIDDEN_MESSAGE,
      reply: REPLIES[category],
      notice: { action: "block", category, message: NOTICES.block[category]! },
      systemNotes: [],
    };
  }
}

/** Replaces each flagged word with its first letter and asterisks (f******). */
export function mask(text: string, findings: Finding[]): string {
  const spans = findings
    .flatMap((f) => (f.span ? [f.span] : []))
    .sort((a, b) => a[0] - b[0])
    .reduce<[number, number][]>((acc, s) => {
      const last = acc[acc.length - 1];
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
      else acc.push([...s]);
      return acc;
    }, []);
  let out = "";
  let pos = 0;
  for (const [start, end] of spans) {
    const word = text.slice(start, end);
    const first = [...word].find((c) => /\S/u.test(c)) ?? "*";
    out += text.slice(pos, start) + first + "*".repeat(Math.max(2, [...word].length - 1));
    pos = end;
  }
  return out + text.slice(pos);
}

/**
 * Parses MODERATION_EXTRA_TERMS_FILE. One term per line, "category:term";
 * a trailing * matches anything starting with the term. # starts a comment.
 *
 *   profanity:frak*
 *   sexual:lewd
 *   insult:numpty
 */
export function parseExtraTerms(content: string): LexiconEntry[] {
  const out: LexiconEntry[] = [];
  content.split(/\r?\n/).forEach((line, i) => {
    const s = line.replace(/#.*/, "").trim();
    if (!s) return;
    const m = /^(sexual|hate|profanity|insult)\s*:\s*([\p{L}\p{N}]+)(\*)?$/iu.exec(s);
    if (!m) throw new Error(`MODERATION_EXTRA_TERMS_FILE line ${i + 1}: expected "category:term" (category: sexual, hate, profanity or insult)`);
    out.push({ category: m[1]!.toLowerCase() as LexiconCategory, term: normaliseWord(m[2]!).norm, kind: m[3] ? "prefix" : "word" });
  });
  return out;
}

export function loadExtraTerms(path: string | undefined): LexiconEntry[] {
  return path ? parseExtraTerms(readFileSync(path, "utf8")) : [];
}
