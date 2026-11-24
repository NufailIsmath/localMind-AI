import { QdrantClient } from "@qdrant/js-client-rest";
import { UpstreamError, errorMessage } from "../lib/errors.js";

/** Payload stored with every chunk vector. */
export interface ChunkPayload {
  /** Owner of the document. Every search MUST filter on this. */
  userId: string;
  documentId: string;
  fileName: string;
  chunkIndex: number;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
}

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: ChunkPayload;
}

export interface VectorSearchParams {
  vector: number[];
  /** Mandatory: retrieval is always scoped to a single user. */
  userId: string;
  limit: number;
  scoreThreshold?: number;
  documentIds?: string[];
}

export interface VectorSearchHit {
  id: string;
  score: number;
  payload: ChunkPayload;
}

export interface VectorStore {
  ensureCollection(): Promise<void>;
  upsert(points: VectorPoint[]): Promise<void>;
  search(params: VectorSearchParams): Promise<VectorSearchHit[]>;
  deleteByDocument(userId: string, documentId: string): Promise<void>;
  health(): Promise<void>;
}

export interface QdrantVectorStoreOptions {
  url: string;
  apiKey?: string;
  collection: string;
  dimensions: number;
  upsertBatchSize?: number;
}

export class QdrantVectorStore implements VectorStore {
  private readonly client: QdrantClient;
  private readonly collection: string;

  constructor(private readonly opts: QdrantVectorStoreOptions) {
    this.client = new QdrantClient({ url: opts.url, apiKey: opts.apiKey, checkCompatibility: false });
    this.collection = opts.collection;
  }

  /**
   * Creates the collection (cosine distance) and keyword payload indexes used
   * for ownership/document filters. Fails loudly if an existing collection was
   * built for a different embedding dimension.
   */
  async ensureCollection(): Promise<void> {
    await this.call("ensureCollection", async () => {
      const { exists } = await this.client.collectionExists(this.collection);
      if (!exists) {
        await this.client.createCollection(this.collection, {
          vectors: { size: this.opts.dimensions, distance: "Cosine" },
        });
      } else {
        const info = await this.client.getCollection(this.collection);
        const vectors = info.config.params.vectors as { size?: number } | undefined;
        if (vectors?.size !== undefined && vectors.size !== this.opts.dimensions) {
          throw new UpstreamError(
            "qdrant",
            `collection "${this.collection}" stores ${vectors.size}-dimensional vectors but EMBEDDING_DIMENSIONS is ` +
              `${this.opts.dimensions}. Use a new QDRANT_COLLECTION or re-index after changing embedding models.`,
          );
        }
      }
      for (const field of ["userId", "documentId"]) {
        await this.client.createPayloadIndex(this.collection, { field_name: field, field_schema: "keyword", wait: true });
      }
    });
  }

  async upsert(points: VectorPoint[]): Promise<void> {
    const size = this.opts.upsertBatchSize ?? 64;
    for (let i = 0; i < points.length; i += size) {
      const batch = points.slice(i, i + size);
      await this.call("upsert", () =>
        this.client.upsert(this.collection, {
          wait: true,
          points: batch.map((p) => ({ id: p.id, vector: p.vector, payload: { ...p.payload } })),
        }),
      );
    }
  }

  async search(params: VectorSearchParams): Promise<VectorSearchHit[]> {
    if (!params.userId) throw new Error("search requires a userId");
    const must: Record<string, unknown>[] = [{ key: "userId", match: { value: params.userId } }];
    if (params.documentIds?.length) must.push({ key: "documentId", match: { any: params.documentIds } });

    const res = await this.call("search", () =>
      this.client.query(this.collection, {
        query: params.vector,
        filter: { must },
        limit: params.limit,
        with_payload: true,
        ...(params.scoreThreshold !== undefined ? { score_threshold: params.scoreThreshold } : {}),
      }),
    );
    return res.points.map((p) => ({
      id: String(p.id),
      score: p.score,
      payload: p.payload as unknown as ChunkPayload,
    }));
  }

  async deleteByDocument(userId: string, documentId: string): Promise<void> {
    await this.call("delete", () =>
      this.client.delete(this.collection, {
        wait: true,
        filter: {
          must: [
            { key: "userId", match: { value: userId } },
            { key: "documentId", match: { value: documentId } },
          ],
        },
      }),
    );
  }

  async health(): Promise<void> {
    await this.call("health", () => this.client.collectionExists(this.collection));
  }

  private async call<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      const status = (err as { status?: number }).status;
      const data = (err as { data?: { status?: { error?: string } } }).data;
      const detail = data?.status?.error ?? errorMessage(err);
      throw new UpstreamError("qdrant", `${op} failed: ${detail}`, status, { cause: err });
    }
  }
}
