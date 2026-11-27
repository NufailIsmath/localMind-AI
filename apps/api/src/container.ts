import type { PrismaClient } from "@prisma/client";
import { OllamaEmbeddingService } from "./ai/embeddings.service.js";
import { OllamaLlmService } from "./ai/llm.service.js";
import { OllamaClient } from "./ai/ollama.client.js";
import { Orchestrator } from "./ai/orchestrator.service.js";
import type { EmbeddingService, LlmService } from "./ai/types.js";
import type { AppConfig } from "./config/env.js";
import { createPrisma } from "./database/prisma.js";
import { AccessService } from "./modules/access/access.service.js";
import { AccessRequestService } from "./modules/access/access-requests.service.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { PrismaChatRepository } from "./modules/chat/chat.repository.js";
import { createToolRegistry } from "./modules/tools/index.js";
import type { ToolRegistry } from "./modules/tools/tool.registry.js";
import { IngestionService } from "./rag/ingestion.service.js";
import { ClassificationService } from "./rag/classification.service.js";
import { LeaveService, PrismaLeaveDataSource } from "./modules/leave/leave.service.js";
import { HttpHrLeaveClient, type HrLeaveClient } from "./modules/integrations/hr/hr-client.js";
import { HrSyncService } from "./modules/integrations/hr/hr-sync.service.js";
import { ModerationService, loadExtraTerms } from "./modules/moderation/moderation.service.js";
import { LlamaGuard, OpenAiLlamaGuard, type SafetyGuard } from "./modules/moderation/llama-guard.js";
import { OpenAiClient } from "./ai/openai.client.js";
import { OpenAiEmbeddingService, OpenAiLlmService } from "./ai/openai-llm.service.js";
import { RetrievalService } from "./rag/retrieval.service.js";
import { QdrantVectorStore, type VectorStore } from "./rag/vector.service.js";

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface Services {
  config: AppConfig;
  prisma: PrismaClient;
  ollama: OllamaClient;
  /** The hosted provider's client when AI_PROVIDER=openai. */
  aiClient?: OpenAiClient;
  llm: LlmService;
  embeddings: EmbeddingService;
  vectors: VectorStore;
  retrieval: RetrievalService;
  ingestion: IngestionService;
  tools: ToolRegistry;
  chatRepository: PrismaChatRepository;
  orchestrator: Orchestrator;
  auth: AuthService;
  access: AccessService;
  accessRequests: AccessRequestService;
  leave: LeaveService;
  hrSync: HrSyncService;
  moderation: ModerationService;
}

/** Infrastructure adapters that tests may replace. */
export interface ServiceOverrides {
  prisma?: PrismaClient;
  ollama?: OllamaClient;
  llm?: LlmService;
  embeddings?: EmbeddingService;
  vectors?: VectorStore;
  /** Lets tests point the HR sync at a mock server or a fake client. */
  hrClient?: HrLeaveClient;
  /** Replaces Llama Guard (tests). */
  guard?: SafetyGuard;
}

/** Composition root: wires every service from configuration. */
export function createServices(config: AppConfig, log: Logger, overrides: ServiceOverrides = {}): Services {
  const prisma = overrides.prisma ?? createPrisma(config.databaseUrl);
  const ollama =
    overrides.ollama ?? new OllamaClient({ host: config.ollama.host, timeoutMs: config.ollama.llmTimeoutMs });
  const embeddingClient = new OllamaClient({ host: config.ollama.host, timeoutMs: config.ollama.embeddingTimeoutMs });

  // Hosted, OpenAI-compatible provider (only built when something uses it).
  const hosted = (timeoutMs: number, retries?: number) =>
    new OpenAiClient({ baseUrl: config.ai.baseUrl!, apiKey: config.ai.apiKey!, label: config.ai.label, timeoutMs, retries });
  const aiClient = config.ai.provider === "openai" ? hosted(config.ollama.llmTimeoutMs) : undefined;

  const llm =
    overrides.llm ??
    (aiClient
      ? new OpenAiLlmService(aiClient, { model: config.ollama.chatModel, temperature: config.ollama.temperature })
      : new OllamaLlmService(ollama, {
          model: config.ollama.chatModel,
          think: config.ollama.think,
          numCtx: config.ollama.numCtx,
          temperature: config.ollama.temperature,
        }));
  const embeddings =
    overrides.embeddings ??
    (config.ai.embeddingProvider === "openai"
      ? new OpenAiEmbeddingService(hosted(config.ollama.embeddingTimeoutMs), {
          model: config.ollama.embeddingModel,
          dimensions: config.ollama.embeddingDimensions,
        })
      : new OllamaEmbeddingService(embeddingClient, {
          model: config.ollama.embeddingModel,
          dimensions: config.ollama.embeddingDimensions,
        }));
  const vectors =
    overrides.vectors ??
    new QdrantVectorStore({
      url: config.qdrant.url,
      apiKey: config.qdrant.apiKey,
      collection: config.qdrant.collection,
      dimensions: config.ollama.embeddingDimensions,
    });

  const access = new AccessService(prisma, vectors, log, { noticeHourlyLimit: config.rag.restrictedNoticeHourlyLimit });
  const retrieval = new RetrievalService(
    embeddings,
    vectors,
    { limit: config.rag.retrievalLimit, scoreThreshold: config.rag.scoreThreshold },
    (principal, documentIds) => access.readableIds(principal, documentIds),
    config.rag.accessDenialMode === "acknowledge"
      ? { finder: (p, candidates) => access.withheldMatches(p, candidates), scoreThreshold: config.rag.restrictedNoticeThreshold }
      : undefined,
  );
  const accessRequests = new AccessRequestService(prisma, access);
  const ingestion = new IngestionService(
    prisma,
    embeddings,
    vectors,
    {
      chunkSizeTokens: config.rag.chunkSizeTokens,
      overlapTokens: config.rag.chunkOverlapTokens,
      uploadDir: config.rag.uploadDir,
      maxUploadBytes: config.rag.maxUploadBytes,
    },
    log,
    config.rag.classificationSuggestions === "off"
      ? undefined
      : new ClassificationService(config.rag.classificationSuggestions === "model" ? llm : undefined, log),
  );
  const hrSync = new HrSyncService(
    prisma,
    overrides.hrClient ?? new HttpHrLeaveClient({ baseUrl: config.hrSync.baseUrl, token: config.hrSync.token, timeoutMs: config.hrSync.timeoutMs }),
    config.hrSync,
    log,
  );
  const leave = new LeaveService(prisma, new PrismaLeaveDataSource(prisma), access, { managerGroup: config.leaveManagerGroup }, hrSync);
  const tools = createToolRegistry({
    leave,
    prisma,
    retrieval,
    timeoutMs: config.orchestrator.toolTimeoutMs,
    acknowledgeRestricted: config.rag.accessDenialMode === "acknowledge",
    onUnexpectedError: (tool, err) => log.error({ tool, err }, "tool failed unexpectedly"),
  });
  const chatRepository = new PrismaChatRepository(prisma);
  const g = config.moderation.guard;
  const moderation = new ModerationService({
    enabled: config.moderation.enabled,
    profanityPolicy: config.moderation.profanityPolicy,
    extraTerms: loadExtraTerms(config.moderation.extraTermsFile),
    log,
    guard:
      g.scope === "off"
        ? undefined
        : {
            guard:
              overrides.guard ??
              (config.ai.guardProvider === "openai"
                ? new OpenAiLlamaGuard(hosted(g.timeoutMs, 1), g.model)
                : new LlamaGuard(new OllamaClient({ host: config.ollama.host, timeoutMs: g.timeoutMs, retries: 1 }), g.model)),
            scope: g.scope,
            enforced: g.categories,
            failMode: g.failMode,
          },
  });
  const orchestrator = new Orchestrator(
    llm,
    tools,
    chatRepository,
    { ...config.orchestrator, runsLocally: config.ai.provider === "ollama" },
    log,
    (e) =>
      access.audit(e.userId, "security.prompt_injection_detected", "document", e.documentId, {
        conversationId: e.conversationId,
        flags: e.flags,
      }),
    moderation,
    // Who/what category only; the message itself is never stored.
    (e) =>
      access.audit(e.userId, `moderation.${e.action}`, "conversation", e.conversationId, {
        category: e.category,
        ...(e.source === "llama-guard" ? { source: e.source, ...(e.codes ? { codes: e.codes } : {}) } : {}),
      }),
  );
  const auth = new AuthService(prisma, config.auth.registration);

  return { config, prisma, ollama, aiClient, llm, embeddings, vectors, retrieval, ingestion, tools, chatRepository, orchestrator, auth, access, accessRequests, leave, hrSync, moderation };
}
