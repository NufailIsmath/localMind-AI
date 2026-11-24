import type { EmbeddingService } from "../ai/types.js";
import type { AccessPrincipal } from "../modules/access/access.policy.js";
import type { Classification } from "@prisma/client";
import type { VectorStore } from "./vector.service.js";

export interface RetrievedChunk {
  id: string;
  documentId: string;
  fileName: string;
  chunkIndex: number;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  classification: Classification;
  /** True when the chunk belongs to a document someone else shared with the user. */
  shared: boolean;
  score: number;
}

export interface RetrieveOptions {
  limit?: number;
  scoreThreshold?: number;
  documentIds?: string[];
  signal?: AbortSignal;
}

/** Returns the subset of document ids the principal may read *right now*, per PostgreSQL. */
export type LiveDocumentFilter = (principal: AccessPrincipal, documentIds: string[]) => Promise<Set<string>>;

/**
 * Semantic search over the chunks a principal may read. Access is enforced
 * twice: by a Qdrant payload filter inside the search, then re-checked against
 * PostgreSQL (the source of truth), so a stale vector payload — mid-way
 * through a sharing change, or after a failed Qdrant update — can never widen access.
 */
export class RetrievalService {
  constructor(
    private readonly embeddings: EmbeddingService,
    private readonly vectors: VectorStore,
    private readonly defaults: { limit: number; scoreThreshold: number },
    /** Authoritative re-check; also drops vectors orphaned by a failed delete. */
    private readonly liveFilter?: LiveDocumentFilter,
  ) {}

  async retrieve(principal: AccessPrincipal, query: string, opts: RetrieveOptions = {}): Promise<RetrievedChunk[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const vector = await this.embeddings.embedQuery(trimmed, opts.signal);
    const hits = await this.vectors.search({
      vector,
      principal,
      limit: opts.limit ?? this.defaults.limit,
      scoreThreshold: opts.scoreThreshold ?? this.defaults.scoreThreshold,
      documentIds: opts.documentIds,
    });
    const live = this.liveFilter ? await this.liveFilter(principal, [...new Set(hits.map((h) => h.payload.documentId))]) : undefined;
    return hits.filter((h) => !live || live.has(h.payload.documentId)).map((h) => ({
      id: h.id,
      documentId: h.payload.documentId,
      fileName: h.payload.fileName,
      chunkIndex: h.payload.chunkIndex,
      content: h.payload.content,
      pageStart: h.payload.pageStart ?? null,
      pageEnd: h.payload.pageEnd ?? null,
      classification: h.payload.classification ?? "INTERNAL",
      shared: h.payload.userId !== principal.userId,
      score: h.score,
    }));
  }
}
