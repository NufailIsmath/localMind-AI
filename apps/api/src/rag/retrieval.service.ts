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

/** Semantic search over a single user's indexed chunks. */
export class RetrievalService {
  constructor(
    private readonly embeddings: EmbeddingService,
    private readonly vectors: VectorStore,
    private readonly defaults: { limit: number; scoreThreshold: number },
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
    return hits.map((h) => ({
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
