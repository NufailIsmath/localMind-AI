import type { EmbeddingService } from "../ai/types.js";
import type { VectorStore } from "./vector.service.js";

export interface RetrievedChunk {
  id: string;
  documentId: string;
  fileName: string;
  chunkIndex: number;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  score: number;
}

export interface RetrieveOptions {
  limit?: number;
  scoreThreshold?: number;
  documentIds?: string[];
  signal?: AbortSignal;
}

/** Returns the subset of document ids that are currently searchable for the user. */
export type LiveDocumentFilter = (userId: string, documentIds: string[]) => Promise<Set<string>>;

/** Semantic search over a single user's indexed chunks. */
export class RetrievalService {
  constructor(
    private readonly embeddings: EmbeddingService,
    private readonly vectors: VectorStore,
    private readonly defaults: { limit: number; scoreThreshold: number },
    /**
     * Defence in depth: drops hits whose document no longer exists in
     * PostgreSQL (e.g. vectors orphaned by a failed Qdrant delete).
     */
    private readonly liveFilter?: LiveDocumentFilter,
  ) {}

  async retrieve(userId: string, query: string, opts: RetrieveOptions = {}): Promise<RetrievedChunk[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const vector = await this.embeddings.embedQuery(trimmed, opts.signal);
    const hits = await this.vectors.search({
      vector,
      userId,
      limit: opts.limit ?? this.defaults.limit,
      scoreThreshold: opts.scoreThreshold ?? this.defaults.scoreThreshold,
      documentIds: opts.documentIds,
    });
    const live = this.liveFilter ? await this.liveFilter(userId, [...new Set(hits.map((h) => h.payload.documentId))]) : undefined;
    return hits.filter((h) => !live || live.has(h.payload.documentId)).map((h) => ({
      id: h.id,
      documentId: h.payload.documentId,
      fileName: h.payload.fileName,
      chunkIndex: h.payload.chunkIndex,
      content: h.payload.content,
      pageStart: h.payload.pageStart ?? null,
      pageEnd: h.payload.pageEnd ?? null,
      score: h.score,
    }));
  }
}
