/**
 * Brute-force in-memory VectorStore (cosine similarity). Used by the RAG
 * evaluation script and unit tests; not meant for production data volumes.
 */
import { canRead, type AccessPayload } from "../modules/access/access.policy.js";
import type { VectorPoint, VectorSearchHit, VectorSearchParams, VectorStore } from "./vector.service.js";

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

export class InMemoryVectorStore implements VectorStore {
  readonly points = new Map<string, VectorPoint>();
  async ensureCollection() {}
  async health() {}
  async upsert(points: VectorPoint[]) {
    for (const p of points) this.points.set(p.id, p);
  }
  async search(params: VectorSearchParams): Promise<VectorSearchHit[]> {
    return [...this.points.values()]
      .filter((p) => canRead(params.principal, p.payload))
      .filter((p) => !params.documentIds?.length || params.documentIds.includes(p.payload.documentId))
      .map((p) => ({ id: p.id, score: cosine(p.vector, params.vector), payload: p.payload }))
      .filter((h) => params.scoreThreshold === undefined || h.score >= params.scoreThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, params.limit);
  }
  async deleteByDocument(documentId: string) {
    for (const [id, p] of this.points) {
      if (p.payload.documentId === documentId) this.points.delete(id);
    }
  }
  async setAccess(documentId: string, access: AccessPayload) {
    for (const p of this.points.values()) {
      if (p.payload.documentId === documentId) Object.assign(p.payload, access);
    }
  }
}
