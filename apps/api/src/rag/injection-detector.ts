/**
 * Heuristic detector for prompt-injection attempts in retrieved text.
 *
 * This is NOT the security boundary — tools are read-only, scoped to the
 * authenticated user and validated server-side, so an injected model can't
 * escalate. Detection adds defence in depth: flagged passages are labelled as
 * suspicious to the model, shown with a warning in the UI and audited, so an
 * attempted attack is visible rather than silent.
 */
const PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your|system)\b[^.\n]{0,30}\b(?:instructions?|prompts?|rules|guidelines|directions)\b/i, label: "asks the AI to ignore its instructions" },
  { re: /\b(?:reveal|print|show|repeat|output|leak)\b[^.\n]{0,30}\b(?:system prompt|hidden instructions|your instructions|initial prompt)\b/i, label: "asks the AI to reveal its instructions" },
  { re: /\byou are now\b|\bfrom now on,? you\b|\bact as (?:an? )?(?:admin|administrator|system|developer|root)\b|\b(?:developer|jailbreak|dan|god) mode\b/i, label: "tries to change the AI's role" },
  { re: /^\s*(?:system|assistant|developer)\s*:/im, label: "impersonates a system or assistant message" },
  { re: /<\/?\s*(?:system|instructions?|im_start|im_end)\s*>|<\|im_(?:start|end)\|>|\[\/?INST\]/i, label: "contains chat-template control tokens" },
  { re: /\[\[\s*(?:call|say)\s*:/i, label: "contains embedded tool-call directives" },
  { re: /\b(?:call|use|invoke|run)\b[^.\n]{0,15}\b(?:the )?(?:search_knowledge|find_team|get_my_leave_balance|check_leave_dates|list_documents|get_usage_stats|get_system_stats|calculate|get_current_time)\b/i, label: "tells the AI which tools to call" },
  { re: /\b(?:send|post|forward|exfiltrate|upload)\b[^.\n]{0,60}\b(?:https?:\/\/|webhook|to this (?:url|link|address))/i, label: "asks the AI to send data elsewhere" },
];

export function detectInjection(text: string): string[] {
  const sample = text.length > 20_000 ? text.slice(0, 20_000) : text;
  return PATTERNS.filter((p) => p.re.test(sample)).map((p) => p.label);
}
