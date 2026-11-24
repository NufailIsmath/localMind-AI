import { QdrantClient } from "@qdrant/js-client-rest";
import { UpstreamError, errorMessage } from "../lib/errors.js";
import { qdrantAccessFilter, type AccessPayload, type AccessPrincipal } from "../modules/access/access.policy.js";

/**
 * Payload stored with every chunk vector. The access fields (owner,
 * visibility, classification, groups) are copied from PostgreSQL so Qdrant can
 * enforce the access policy inside the similarity search itself.
 */
export interface ChunkPayload extends AccessPayload {
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
  /** Mandatory: every search is filtered by what this principal may read. */
  principal: AccessPrincipal;
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
  /**
   * Access-UNFILTERED search returning only document ids and scores — never
   * content. Used solely to tell a user "a confidential document matched".
   */
  matchingDocuments(
    vector: number[],
    limit: number,
    scoreThreshold: number,
    scope: { excludeUserId: string },
  ): Promise<{ documentId: string; score: number }[]>;
  deleteByDocument(documentId: string): Promise<void>;
  /** Rewrites the access fields of every chunk of a document (after sharing changes). */
  setAccess(documentId: string, access: AccessPayload): Promise<void>;
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
      for (const field of ["userId", "documentId", "visibility", "groupIds", "userIds"]) {
        await this.client.createPayloadIndex(this.collection, { field_name: field, field_schema: "keyword", wait: true });
      }
      await this.client.createPayloadIndex(this.collection, { field_name: "classificationLevel", field_schema: "integer", wait: true });
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
    if (!params.principal?.userId) throw new Error("search requires an access principal");
    const must: Record<string, unknown>[] = [];
    if (params.documentIds?.length) must.push({ key: "documentId", match: { any: params.documentIds } });

    const res = await this.call("search", () =>
      this.client.query(this.collection, {
        query: params.vector,
        filter: { must, ...qdrantAccessFilter(params.principal) },
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

  async matchingDocuments(vector: number[], limit: number, scoreThreshold: number, scope: { excludeUserId: string }) {
    const res = await this.call("matchingDocuments", () =>
      this.client.query(this.collection, {
        query: vector,
        limit,
        score_threshold: scoreThreshold,
        // Only shared documents can ever be acknowledged, so only they may compete for
        // the candidate slots (otherwise many similar private files could crowd them out).
        filter: {
          must: [{ key: "visibility", match: { any: ["ORGANIZATION", "GROUPS"] } }],
          must_not: [{ key: "userId", match: { value: scope.excludeUserId } }],
        },
        with_payload: { include: ["documentId"] },
      }),
    );
    return res.points.map((p) => ({ documentId: String((p.payload as { documentId: string }).documentId), score: p.score }));
  }

  async deleteByDocument(documentId: string): Promise<void> {
    await this.call("delete", () =>
      this.client.delete(this.collection, {
        wait: true,
        filter: { must: [{ key: "documentId", match: { value: documentId } }] },
      }),
    );
  }

  async setAccess(documentId: string, access: AccessPayload): Promise<void> {
    await this.call("setAccess", () =>
      this.client.setPayload(this.collection, {
        wait: true,
        payload: { ...access },
        filter: { must: [{ key: "documentId", match: { value: documentId } }] },
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
