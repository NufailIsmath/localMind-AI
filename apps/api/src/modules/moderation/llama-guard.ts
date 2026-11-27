import type { OllamaClient } from "../../ai/ollama.client.js";
import { UpstreamError } from "../../lib/errors.js";

/**
 * Llama Guard 3 hazard categories (MLCommons taxonomy). The model answers
 * "safe", or "unsafe" plus the codes that apply.
 */
export const HAZARDS = {
  S1: "Violent crimes",
  S2: "Non-violent crimes",
  S3: "Sex-related crimes",
  S4: "Child sexual exploitation",
  S5: "Defamation",
  S6: "Specialized advice",
  S7: "Privacy",
  S8: "Intellectual property",
  S9: "Indiscriminate weapons",
  S10: "Hate",
  S11: "Suicide & self-harm",
  S12: "Sexual content",
  S13: "Elections",
  S14: "Code interpreter abuse",
} as const;
export type HazardCode = keyof typeof HAZARDS;
export const HAZARD_CODES = Object.keys(HAZARDS) as HazardCode[];

/**
 * Enforced by default. Left out on purpose, because at work they'd mostly
 * flag legitimate requests: S5 (feedback about a colleague reads as defamation),
 * S6 (payroll, benefits and sick-leave guidance reads as "specialised advice"),
 * S7 (looking up a colleague's work email reads as "privacy"), S8, S13, S14.
 */
export const DEFAULT_ENFORCED: HazardCode[] = ["S1", "S2", "S3", "S4", "S9", "S10", "S11", "S12"];

export interface GuardTurn {
  role: "user" | "assistant";
  content: string;
}

export interface GuardVerdict {
  safe: boolean;
  /** Hazard codes the model reported (enforced or not). */
  codes: HazardCode[];
}

/** A safety classifier for a conversation's last turn (Llama Guard, or a test double). */
export interface SafetyGuard {
  readonly model: string;
  check(turns: GuardTurn[], signal?: AbortSignal): Promise<GuardVerdict>;
}

/** Keeps classification fast on long inputs: the start and end of the text carry the intent. */
const MAX_CHARS = 6000;
const clip = (s: string) => (s.length <= MAX_CHARS ? s : `${s.slice(0, MAX_CHARS / 2)}\n…\n${s.slice(-MAX_CHARS / 2)}`);

/**
 * Llama Guard 3 served by Ollama (`ollama pull llama-guard3:1b`).
 *
 * Ollama's chat template for the model wraps the conversation in Llama
 * Guard's classification prompt: if the last turn is the user's, it rates the
 * request; if it's the assistant's, it rates the response.
 */
export class LlamaGuard implements SafetyGuard {
  constructor(
    private readonly client: OllamaClient,
    readonly model: string,
  ) {}

  async check(turns: GuardTurn[], signal?: AbortSignal): Promise<GuardVerdict> {
    const res = await this.client.chat(
      {
        model: this.model,
        messages: turns.map((t) => ({ role: t.role, content: clip(t.content) })),
        keep_alive: "30m",
        options: { temperature: 0, num_predict: 20 },
      },
      { signal },
    );
    return parseGuardOutput(res.message?.content ?? "");
  }
}

/** Parses "safe" / "unsafe\nS1,S10". Anything else is an error (never assumed safe). */
export function parseGuardOutput(text: string): GuardVerdict {
  const t = text.trim();
  if (/^safe\b/i.test(t)) return { safe: true, codes: [] };
  if (/^unsafe\b/i.test(t)) {
    const codes = [...new Set((t.match(/\bS(\d{1,2})\b/gi) ?? []).map((c) => c.toUpperCase()))].filter((c): c is HazardCode => c in HAZARDS);
    return { safe: false, codes };
  }
  throw new UpstreamError("llama-guard", `unexpected classifier output: ${JSON.stringify(t.slice(0, 60))}`);
}

/** Parses GUARD_CATEGORIES ("S1,S2,S10" or "all"). */
export function parseHazardList(value: string): HazardCode[] {
  if (value.trim().toLowerCase() === "all") return [...HAZARD_CODES];
  const codes = value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const bad = codes.filter((c) => !(c in HAZARDS));
  if (bad.length) throw new Error(`GUARD_CATEGORIES: unknown categor${bad.length > 1 ? "ies" : "y"} ${bad.join(", ")} (use S1–S14 or "all")`);
  return codes as HazardCode[];
}
