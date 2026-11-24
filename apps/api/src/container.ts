import type { PrismaClient } from "@prisma/client";
import { OllamaEmbeddingService } from "./ai/embeddings.service.js";
import { OllamaLlmService } from "./ai/llm.service.js";
import { OllamaClient } from "./ai/ollama.client.js";
import { Orchestrator } from "./ai/orchestrator.service.js";
import type { EmbeddingService, LlmService } from "./ai/types.js";
import type { AppConfig } from "./config/env.js";
import { createPrisma } from "./database/prisma.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { PrismaChatRepository } from "./modules/chat/chat.repository.js";
import { createToolRegistry } from "./modules/tools/index.js";
import type { ToolRegistry } from "./modules/tools/tool.registry.js";
import { IngestionService } from "./rag/ingestion.service.js";
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
  llm: LlmService;
  embeddings: EmbeddingService;
  vectors: VectorStore;
  retrieval: RetrievalService;
  ingestion: IngestionService;
  tools: ToolRegistry;
  chatRepository: PrismaChatRepository;
  orchestrator: Orchestrator;
  auth: AuthService;
}

/** Infrastructure adapters that tests may replace. */
export interface ServiceOverrides {
  prisma?: PrismaClient;
  ollama?: OllamaClient;
  llm?: LlmService;
  embeddings?: EmbeddingService;
  vectors?: VectorStore;
}

/** Composition root: wires every service from configuration. */
export function createServices(config: AppConfig, log: Logger, overrides: ServiceOverrides = {}): Services {
  const prisma = overrides.prisma ?? createPrisma(config.databaseUrl);
  const ollama =
    overrides.ollama ?? new OllamaClient({ host: config.ollama.host, timeoutMs: config.ollama.llmTimeoutMs });
  const embeddingClient = new OllamaClient({ host: config.ollama.host, timeoutMs: config.ollama.embeddingTimeoutMs });

  const llm =
    overrides.llm ??
    new OllamaLlmService(ollama, {
      model: config.ollama.chatModel,
      think: config.ollama.think,
      numCtx: config.ollama.numCtx,
      temperature: config.ollama.temperature,
    });
  const embeddings =
    overrides.embeddings ??
    new OllamaEmbeddingService(embeddingClient, {
      model: config.ollama.embeddingModel,
      dimensions: config.ollama.embeddingDimensions,
    });
  const vectors =
    overrides.vectors ??
    new QdrantVectorStore({
      url: config.qdrant.url,
      apiKey: config.qdrant.apiKey,
      collection: config.qdrant.collection,
      dimensions: config.ollama.embeddingDimensions,
    });

  const retrieval = new RetrievalService(embeddings, vectors, {
    limit: config.rag.retrievalLimit,
    scoreThreshold: config.rag.scoreThreshold,
  });
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
  );
  const tools = createToolRegistry({
    prisma,
    retrieval,
    timeoutMs: config.orchestrator.toolTimeoutMs,
    onUnexpectedError: (tool, err) => log.error({ tool, err }, "tool failed unexpectedly"),
  });
  const chatRepository = new PrismaChatRepository(prisma);
  const orchestrator = new Orchestrator(llm, tools, chatRepository, config.orchestrator, log);
  const auth = new AuthService(prisma, config.auth.allowRegistration);

  return { config, prisma, ollama, llm, embeddings, vectors, retrieval, ingestion, tools, chatRepository, orchestrator, auth };
}
