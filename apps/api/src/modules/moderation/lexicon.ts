/**
 * Word lists for the content guardrails.
 *
 * Kept deliberately small and specific: every entry here must be unambiguous in
 * a workplace context. Ambiguous words ("sex", "naked", "cock", "chink",
 * "dick", "crap", "hell", "damn") are left out on purpose, because flagging
 * "sex discrimination policy" or "a chink in the plan" would make the buddy
 * useless for exactly the conversations it should help with.
 *
 * Match kinds (applied to normalised tokens, see moderation.service.ts):
 *   word   – the whole token equals the term
 *   prefix – the token starts with the term (inflections: shitty, bitches)
 *   infix  – the term appears anywhere in the token (motherfucker)
 *
 * Organisations can add their own terms with MODERATION_EXTRA_TERMS_FILE.
 */

export type LexiconCategory = "sexual" | "hate" | "profanity" | "insult";
export type MatchKind = "word" | "prefix" | "infix";

export interface LexiconEntry {
  term: string;
  kind: MatchKind;
  category: LexiconCategory;
}

const words = (category: LexiconCategory, kind: MatchKind, list: string[]): LexiconEntry[] =>
  list.map((term) => ({ term, kind, category }));

export const LEXICON: LexiconEntry[] = [
  // ---- sexual / NSFW (explicit only; clinical and HR vocabulary is fine) ----
  ...words("sexual", "prefix", ["porn", "hentai", "masturbat", "blowjob", "handjob", "rimjob", "dildo", "cumshot", "sexting", "erotic", "camgirl", "onlyfans", "deepthroat", "bukkake"]),
  ...words("sexual", "word", [
    "nsfw", "nudes", "nudez", "xxx", "horny", "boobs", "boobies", "tits", "titties", "pussy", "pussies", "cum", "cumming", "orgasm", "orgasms",
    "sext", "sexts", "milf", "milfs", "bdsm", "threesome", "gangbang", "fetish", "fetishes", "stripper", "strippers", "nudity", "xvideos", "pornhub",
  ]),

  // ---- hate slurs (blocked; the reply still helps someone reporting them) ----
  ...words("hate", "prefix", ["nigger", "nigga", "faggot", "kike", "wetback", "raghead", "towelhead", "tranny", "trannies", "retard"]),
  ...words("hate", "word", ["spic", "spics", "gook", "gooks"]),

  // ---- profanity ----
  ...words("profanity", "infix", ["fuck"]),
  ...words("profanity", "prefix", ["shit", "bitch", "bastard", "asshole", "arsehole", "dickhead", "wanker", "cunt", "bollock", "goddamn", "douchebag", "motherf"]),
  ...words("profanity", "word", [
    "fck", "fcking", "fcked", "fk", "fkn", "fkin", "fking", "fuk", "fuks", "fukin", "fukn", "fuking", "stfu", "gtfo", "wtf", "ass", "asses", "arse",
    "jackass", "dumbass", "smartass", "bullshit", "horseshit", "apeshit", "batshit", "twat", "twats", "wank", "wanking",
  ]),

  // ---- insults (not blocked: the model is told not to write abuse) ----
  ...words("insult", "word", [
    "idiot", "idiots", "idiotic", "moron", "morons", "moronic", "imbecile", "imbeciles", "loser", "losers", "dumb", "stupid", "useless", "worthless",
    "pathetic", "clown", "clowns", "incompetent", "halfwit", "dimwit", "numbskull", "scumbag", "slut", "sluts", "whore", "whores", "skank",
  ]),
];

/**
 * Tokens that contain a listed term but are fine. Checked after matching, so
 * infix/prefix entries stay simple.
 */
export const ALLOW_TOKENS = new Set([
  "cumlaude", "scunthorpe", "shiitake", "shitake", "assess", "pissarro", "dickens", "titmouse", "titration", "bastardise", "bastardize",
  "retardant", "retardants", // flame retardant
  // Policy and legal vocabulary ("viewing pornography at work is gross misconduct").
  "pornography", "pornographic",
]);

/** Word pairs that make a listed word fine ("summa cum laude"). */
export const ALLOW_BIGRAMS = new Set(["cum laude", "summa cum", "magna cum"]);

/**
 * Phrases checked on the normalised, space-joined text (all lowercase, single
 * spaces, letters only). These catch explicit content no single word does.
 */
export const SEXUAL_PHRASES: RegExp[] = [
  /\bsend (me )?(your |some )?(nude|naked|sexy|dirty) (pic|pics|picture|pictures|photo|photos|selfie|selfies)\b/,
  /\b(dick|nude|naked|sexy) pics?\b/,
  /\b(phone|cyber) sex\b/,
  /\bsex (tape|tapes|chat|video|videos|story|stories|scene|scenes)\b/,
  /\b(write|tell|describe|roleplay|role play)\b.{0,40}\b(sex scene|sexual fantasy|sexual fantasies|explicit|erotic|dirty talk|naughty story)\b/,
  /\b(get|getting|are|r|im|i am|feel|feeling) (so )?naked\b/,
  /\btalk dirty\b/,
];

/** First-person statements of self-harm or suicidal thinking (answered with support, never refused). */
export const SELF_HARM_PHRASES: RegExp[] = [
  /\b(i|im|i am|ive|i have|i ve)\b.{0,30}\b(kill|killing|hurt|hurting|harm|harming|cut|cutting) myself\b/,
  /\b(want|wanna|planning|thinking about|thought about|think about) (to )?(die|dying|end it all|end my life|ending my life|take my (own )?life|commit suicide|kill myself)\b/,
  /\b(i|im|i am|i feel|feeling)\b.{0,15}\bsuicidal\b/,
  /\b(thinking about|thought about|considering|contemplating|thoughts of) (suicide|ending it|killing myself)\b/,
  /\b(dont|do not|no longer|don t) want to (live|be alive|be here|exist) anymore\b/,
  /\bno (reason|point) (to|in) (live|living|going on)\b/,
  /\bend my life\b/,
  /\b(i|im|i am|ive|i have|i ve)\b.{0,20}\bself harm(ing)?\b/,
];

/** Phrases that suggest a request to write or send something insulting. */
export const ABUSE_DRAFTING = /\b(write|draft|compose|send|reply|respond|email|message|text|tell|say|call|called|calling|roast|insult|make)\b/;
