import { z } from "zod";

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

    OLLAMA_HOST: z.url().default("http://localhost:11434"),
    CHAT_MODEL: z.string().min(1).default("qwen3:8b"),
    EMBEDDING_MODEL: z.string().min(1).default("nomic-embed-text"),
    EMBEDDING_DIMENSIONS: int(768, 1),
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
    CLASSIFICATION_SUGGESTIONS: z.enum(["model", "rules", "off"]).default("model"),
    MAX_UPLOAD_MB: z.coerce.number().positive().default(20),
    UPLOAD_DIR: z.string().default("./data/uploads"),

    MAX_TOOL_ROUNDS: int(5, 1),
    MAX_TOOL_CALLS_PER_ROUND: int(5, 1),
    TOOL_TIMEOUT_MS: int(15_000, 100),
    HISTORY_MESSAGE_LIMIT: int(12, 0),
  })
  .refine((e) => e.CHUNK_OVERLAP_TOKENS < e.CHUNK_SIZE_TOKENS, {
    message: "CHUNK_OVERLAP_TOKENS must be smaller than CHUNK_SIZE_TOKENS",
    path: ["CHUNK_OVERLAP_TOKENS"],
  });

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  env: Env["NODE_ENV"];
  host: string;
  port: number;
  corsOrigins: string[];
  logLevel: Env["LOG_LEVEL"];
  rateLimitEnabled: boolean;
  auth: { jwtSecret: string; jwtExpiresIn: string; registration: "open" | "closed" | "first-user" };
  databaseUrl: string;
  qdrant: { url: string; apiKey?: string; collection: string };
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
  const parsed = EnvSchema.safeParse(source);
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
    auth: { jwtSecret: e.JWT_SECRET, jwtExpiresIn: e.JWT_EXPIRES_IN, registration: e.ALLOW_REGISTRATION },
    databaseUrl: e.DATABASE_URL,
    qdrant: { url: e.QDRANT_URL, apiKey: e.QDRANT_API_KEY || undefined, collection: e.QDRANT_COLLECTION },
    ollama: {
      host: e.OLLAMA_HOST,
      chatModel: e.CHAT_MODEL,
      embeddingModel: e.EMBEDDING_MODEL,
      embeddingDimensions: e.EMBEDDING_DIMENSIONS,
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
