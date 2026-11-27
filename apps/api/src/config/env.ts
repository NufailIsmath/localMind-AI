import { z } from "zod";
import { parseHazardList, type HazardCode } from "../modules/moderation/llama-guard.js";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    API_HOST: z.string().default("127.0.0.1"),
    API_PORT: int(4000, 1),
    CORS_ORIGINS: z.string().default("http://localhost:3000"),
    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    JWT_EXPIRES_IN: z.string().default("7d"),
    /**
     * Self-service sign-up:
     *   first-user (default): open only until the first (admin) account exists; admins add everyone else.
     *   true: always open (convenient for demos; reveals whether an email is registered).
     *   false: closed.
     */
    ALLOW_REGISTRATION: z
      .enum(["true", "false", "1", "0", "first-user"])
      .default("first-user")
      .transform((v) => (v === "first-user" ? "first-user" : v === "true" || v === "1" ? "open" : "closed")),
    /** Per-user hourly cap on "that's confidential" notices (slows probing for what exists). */
    RESTRICTED_NOTICE_HOURLY_LIMIT: int(30, 0),
    RATE_LIMIT_ENABLED: bool.default(true),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

    DATABASE_URL: z.string().min(1),

    QDRANT_URL: z.url().default("http://localhost:6333"),
    QDRANT_API_KEY: z.string().optional(),
    QDRANT_COLLECTION: z.string().min(1).default("documents"),

    /**
     * Where the AI runs. ollama: local models (default). openai: any hosted
     * OpenAI-compatible API (Roar AI, OpenAI, OpenRouter, Together, Groq…).
     */
    AI_PROVIDER: z.enum(["ollama", "openai"]).default("ollama"),
    /** OpenAI-compatible base URL, including the version path (e.g. https://api.example.com/v1). */
    AI_BASE_URL: z.url().optional(),
    AI_API_KEY: z.string().optional(),
    /** Shown in the app and in errors, e.g. "Roar AI" (defaults to the host name). */
    AI_PROVIDER_LABEL: z.string().optional(),
    /** Embeddings and Llama Guard can run elsewhere than chat (e.g. chat hosted, embeddings local). */
    EMBEDDING_PROVIDER: z.enum(["ollama", "openai"]).optional(),
    GUARD_PROVIDER: z.enum(["ollama", "openai"]).optional(),

    OLLAMA_HOST: z.url().default("http://localhost:11434"),
    /** Defaults suit Ollama; with a hosted provider they must name models it offers. */
    CHAT_MODEL: z.string().min(1).optional(),
    EMBEDDING_MODEL: z.string().min(1).optional(),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).optional(),
    OLLAMA_THINK: bool.default(false),
    OLLAMA_NUM_CTX: int(8192, 512),
    LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
    LLM_TIMEOUT_MS: int(180_000, 1000),
    EMBEDDING_TIMEOUT_MS: int(60_000, 1000),

    CHUNK_SIZE_TOKENS: int(600, 50),
    CHUNK_OVERLAP_TOKENS: int(100, 0),
    RETRIEVAL_LIMIT: int(5, 1),
    RETRIEVAL_SCORE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.35),
    /**
     * acknowledge: tell users when a strong match exists in a team/org document they
     * can't read ("that's confidential") and let them request access.
     * silent: behave as if nothing matched (reveals nothing about what exists).
     */
    ACCESS_DENIAL_MODE: z.enum(["acknowledge", "silent"]).default("acknowledge"),
    /** Minimum similarity before a restricted document is acknowledged (keeps probing imprecise). */
    RESTRICTED_NOTICE_SCORE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.55),
    /** model: rules + local model; rules: pattern rules only; off: no suggestions. */
    /**
     * Push leave changes to the company's external HR leave system. OFF by default;
     * the base URL is a placeholder until the real API details are available.
     */
    HR_SYNC_ENABLED: bool.default(false),
    HR_API_BASE_URL: z.url().default("https://hr-api.example.com/v1"),
    HR_API_TOKEN: z.string().optional(),
    HR_API_TIMEOUT_MS: int(10_000, 500),
    /** How often the background sender runs (0 = never; tests call it directly). */
    HR_SYNC_INTERVAL_MS: int(15_000, 0),
    HR_SYNC_MAX_ATTEMPTS: int(8, 1),
    /** Members of this group (plus admins) manage everyone's leave records. */
    LEAVE_MANAGER_GROUP: z.string().min(1).default("HR"),
    CLASSIFICATION_SUGGESTIONS: z.enum(["model", "rules", "off"]).default("model"),
    MAX_UPLOAD_MB: z.coerce.number().positive().default(20),
    UPLOAD_DIR: z.string().default("./data/uploads"),

    /** Content guardrails (explicit content, hate speech, strong language) on chat and notes. */
    MODERATION_ENABLED: bool.default(true),
    /** Strong language: warn (answer, mask it, show a reminder), block (refuse), allow. */
    PROFANITY_POLICY: z.enum(["warn", "block", "allow"]).default("warn"),
    /** Optional file of extra terms, one "category:term" per line (see docs). */
    MODERATION_EXTRA_TERMS_FILE: z.string().optional(),
    /**
     * Llama Guard (local safety classifier via Ollama) as a second layer behind the rules:
     * both = messages and answers, input = messages only, off.
     */
    MODERATION_GUARD: z.enum(["both", "input", "off"]).default("both"),
    GUARD_MODEL: z.string().min(1).optional(),
    /** Hazard codes to act on (S1–S14 or "all"); the default leaves out ones that misfire at work. */
    GUARD_CATEGORIES: z.string().default("S1,S2,S3,S4,S9,S10,S11,S12"),
    /** closed: refuse when the classifier is unavailable; open: skip it (logged). */
    GUARD_FAIL_MODE: z.enum(["closed", "open"]).default("closed"),
    GUARD_TIMEOUT_MS: int(20_000, 500),

    MAX_TOOL_ROUNDS: int(5, 1),
    MAX_TOOL_CALLS_PER_ROUND: int(5, 1),
    TOOL_TIMEOUT_MS: int(15_000, 100),
    HISTORY_MESSAGE_LIMIT: int(12, 0),
  })
  .refine((e) => e.CHUNK_OVERLAP_TOKENS < e.CHUNK_SIZE_TOKENS, {
    message: "CHUNK_OVERLAP_TOKENS must be smaller than CHUNK_SIZE_TOKENS",
    path: ["CHUNK_OVERLAP_TOKENS"],
  })
  .superRefine((e, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    const embeddingProvider = e.EMBEDDING_PROVIDER ?? e.AI_PROVIDER;
    const guardProvider = e.GUARD_PROVIDER ?? e.AI_PROVIDER;
    const hosted = e.AI_PROVIDER === "openai" || embeddingProvider === "openai" || (guardProvider === "openai" && e.MODERATION_GUARD !== "off");
    if (!hosted) return;
    if (!e.AI_BASE_URL) issue("AI_BASE_URL", "required for the hosted provider (the provider's OpenAI-compatible base URL, e.g. https://api.example.com/v1)");
    else if (new URL(e.AI_BASE_URL).protocol !== "https:" && !/^(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal|[\w-]+)$/.test(new URL(e.AI_BASE_URL).hostname)) {
      // The API key and company documents go over this connection.
      issue("AI_BASE_URL", "must use https:// for a remote provider");
    }
    if (!e.AI_API_KEY) issue("AI_API_KEY", "required for the hosted provider");
    if (e.AI_PROVIDER === "openai" && !e.CHAT_MODEL) issue("CHAT_MODEL", "set it to a chat model your provider offers (one that supports tool calling)");
    if (embeddingProvider === "openai" && (!e.EMBEDDING_MODEL || !e.EMBEDDING_DIMENSIONS)) {
      issue("EMBEDDING_MODEL", "with hosted embeddings, set EMBEDDING_MODEL and EMBEDDING_DIMENSIONS (or EMBEDDING_PROVIDER=ollama to keep embeddings local)");
    }
    if (guardProvider === "openai" && e.MODERATION_GUARD !== "off" && !e.GUARD_MODEL) {
      issue("GUARD_MODEL", "set it to the provider's Llama Guard model, or use GUARD_PROVIDER=ollama (local) or MODERATION_GUARD=off");
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  env: Env["NODE_ENV"];
  host: string;
  port: number;
  corsOrigins: string[];
  logLevel: Env["LOG_LEVEL"];
  rateLimitEnabled: boolean;
  leaveManagerGroup: string;
  hrSync: { enabled: boolean; baseUrl: string; token?: string; timeoutMs: number; intervalMs: number; maxAttempts: number };
  auth: { jwtSecret: string; jwtExpiresIn: string; registration: "open" | "closed" | "first-user" };
  databaseUrl: string;
  moderation: {
    enabled: boolean;
    profanityPolicy: "warn" | "block" | "allow";
    extraTermsFile?: string;
    guard: { scope: "both" | "input" | "off"; model: string; categories: HazardCode[]; failMode: "closed" | "open"; timeoutMs: number };
  };
  qdrant: { url: string; apiKey?: string; collection: string };
  ai: {
    provider: "ollama" | "openai";
    embeddingProvider: "ollama" | "openai";
    guardProvider: "ollama" | "openai";
    baseUrl?: string;
    apiKey?: string;
    label: string;
  };
  ollama: {
    host: string;
    chatModel: string;
    embeddingModel: string;
    embeddingDimensions: number;
    think: boolean;
    numCtx: number;
    temperature: number;
    llmTimeoutMs: number;
    embeddingTimeoutMs: number;
  };
  rag: {
    chunkSizeTokens: number;
    chunkOverlapTokens: number;
    retrievalLimit: number;
    scoreThreshold: number;
    accessDenialMode: "acknowledge" | "silent";
    restrictedNoticeThreshold: number;
    restrictedNoticeHourlyLimit: number;
    classificationSuggestions: "model" | "rules" | "off";
    maxUploadBytes: number;
    uploadDir: string;
  };
  orchestrator: {
    maxToolRounds: number;
    maxToolCallsPerRound: number;
    toolTimeoutMs: number;
    historyMessageLimit: number;
  };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // An empty variable means "not set" (Docker Compose passes unset ones as "").
  const parsed = EnvSchema.safeParse(Object.fromEntries(Object.entries(source).filter(([, v]) => v !== "")));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    host: e.API_HOST,
    port: e.API_PORT,
    corsOrigins: e.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    logLevel: e.LOG_LEVEL,
    rateLimitEnabled: e.RATE_LIMIT_ENABLED,
    leaveManagerGroup: e.LEAVE_MANAGER_GROUP,
    hrSync: {
      enabled: e.HR_SYNC_ENABLED,
      baseUrl: e.HR_API_BASE_URL,
      token: e.HR_API_TOKEN || undefined,
      timeoutMs: e.HR_API_TIMEOUT_MS,
      intervalMs: e.HR_SYNC_INTERVAL_MS,
      maxAttempts: e.HR_SYNC_MAX_ATTEMPTS,
    },
    auth: { jwtSecret: e.JWT_SECRET, jwtExpiresIn: e.JWT_EXPIRES_IN, registration: e.ALLOW_REGISTRATION },
    databaseUrl: e.DATABASE_URL,
    moderation: {
      enabled: e.MODERATION_ENABLED,
      profanityPolicy: e.PROFANITY_POLICY,
      extraTermsFile: e.MODERATION_EXTRA_TERMS_FILE || undefined,
      guard: {
        scope: e.MODERATION_GUARD,
        model: e.GUARD_MODEL ?? "llama-guard3:1b",
        categories: parseHazardList(e.GUARD_CATEGORIES),
        failMode: e.GUARD_FAIL_MODE,
        timeoutMs: e.GUARD_TIMEOUT_MS,
      },
    },
    qdrant: { url: e.QDRANT_URL, apiKey: e.QDRANT_API_KEY || undefined, collection: e.QDRANT_COLLECTION },
    ai: {
      provider: e.AI_PROVIDER,
      embeddingProvider: e.EMBEDDING_PROVIDER ?? e.AI_PROVIDER,
      guardProvider: e.GUARD_PROVIDER ?? e.AI_PROVIDER,
      baseUrl: e.AI_BASE_URL,
      apiKey: e.AI_API_KEY || undefined,
      label: e.AI_PROVIDER_LABEL ?? (e.AI_BASE_URL ? new URL(e.AI_BASE_URL).hostname : "Ollama"),
    },
    ollama: {
      host: e.OLLAMA_HOST,
      chatModel: e.CHAT_MODEL ?? "qwen3:8b",
      embeddingModel: e.EMBEDDING_MODEL ?? "nomic-embed-text",
      embeddingDimensions: e.EMBEDDING_DIMENSIONS ?? 768,
      think: e.OLLAMA_THINK,
      numCtx: e.OLLAMA_NUM_CTX,
      temperature: e.LLM_TEMPERATURE,
      llmTimeoutMs: e.LLM_TIMEOUT_MS,
      embeddingTimeoutMs: e.EMBEDDING_TIMEOUT_MS,
    },
    rag: {
      chunkSizeTokens: e.CHUNK_SIZE_TOKENS,
      chunkOverlapTokens: e.CHUNK_OVERLAP_TOKENS,
      retrievalLimit: e.RETRIEVAL_LIMIT,
      scoreThreshold: e.RETRIEVAL_SCORE_THRESHOLD,
      accessDenialMode: e.ACCESS_DENIAL_MODE,
      restrictedNoticeThreshold: e.RESTRICTED_NOTICE_SCORE_THRESHOLD,
      restrictedNoticeHourlyLimit: e.RESTRICTED_NOTICE_HOURLY_LIMIT,
      classificationSuggestions: e.CLASSIFICATION_SUGGESTIONS,
      maxUploadBytes: Math.floor(e.MAX_UPLOAD_MB * 1024 * 1024),
      uploadDir: e.UPLOAD_DIR,
    },
    orchestrator: {
      maxToolRounds: e.MAX_TOOL_ROUNDS,
      maxToolCallsPerRound: e.MAX_TOOL_CALLS_PER_ROUND,
      toolTimeoutMs: e.TOOL_TIMEOUT_MS,
      historyMessageLimit: e.HISTORY_MESSAGE_LIMIT,
    },
  };
}
