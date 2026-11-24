import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Document, PrismaClient } from "@prisma/client";
import type { EmbeddingService } from "../ai/types.js";
import { AppError, badRequest, conflict, errorMessage, notFound } from "../lib/errors.js";
import { JobQueue } from "../lib/job-queue.js";
import { chunkDocument, type ChunkingOptions } from "./chunking.service.js";
import { MIME_TYPES, detectKind, extractDocument } from "./extraction.service.js";
import type { VectorPoint, VectorStore } from "./vector.service.js";
import { toAccessPayload } from "../modules/access/access.policy.js";
import type { SharingSettings } from "../modules/access/access.service.js";

export interface IngestionOptions extends ChunkingOptions {
  uploadDir: string;
  maxUploadBytes: number;
  concurrency?: number;
}

export interface IngestionLogger {
  info(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const MAX_FILENAME = 200;
/** Upper bound on chunks per document (~3M characters at the default chunk size). */
export const MAX_CHUNKS_PER_DOCUMENT = 5000;

export function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "document";
  return cleaned.length > MAX_FILENAME ? cleaned.slice(cleaned.length - MAX_FILENAME) : cleaned;
}

/**
 * Document ingestion pipeline:
 *   upload → store original → extract text → chunk → embed → upsert to Qdrant
 *   → record chunk metadata in PostgreSQL.
 *
 * Uploads return immediately with status PENDING; the heavy work runs on a
 * background queue and the client polls the document status.
 */
export class IngestionService {
  private readonly queue: JobQueue;
  private readonly uploadDir: string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly embeddings: EmbeddingService,
    private readonly vectors: VectorStore,
    private readonly opts: IngestionOptions,
    private readonly log: IngestionLogger,
  ) {
    this.uploadDir = resolve(opts.uploadDir);
    this.queue = new JobQueue(opts.concurrency ?? 1, (key, err) =>
      this.log.error({ documentId: key, err: errorMessage(err) }, "ingestion job crashed"),
    );
  }

  /** `sharing` must already be validated (AccessService.validateSharing). */
  async upload(
    userId: string,
    rawFilename: string,
    bytes: Buffer,
    sharing: SharingSettings = { visibility: "PRIVATE", classification: "INTERNAL", groupIds: [] },
  ): Promise<Document> {
    if (bytes.length === 0) throw badRequest("File is empty");
    if (bytes.length > this.opts.maxUploadBytes) {
      throw new AppError(413, "PAYLOAD_TOO_LARGE", `File exceeds the ${this.opts.maxUploadBytes} byte limit`);
    }
    const filename = sanitizeFilename(rawFilename);
    const kind = detectKind(filename, bytes);
    const contentHash = createHash("sha256").update(bytes).digest("hex");

    const existing = await this.prisma.document.findUnique({ where: { userId_contentHash: { userId, contentHash } } });
    if (existing) {
      if (existing.status !== "FAILED") {
        throw conflict(`This file was already uploaded as "${existing.filename}"`, { documentId: existing.id });
      }
      // A previous attempt failed: replace it rather than blocking re-upload forever.
      await this.remove(existing.id);
    }

    const id = randomUUID();
    await mkdir(this.uploadDir, { recursive: true });
    await writeFile(this.filePath(id), bytes, { mode: 0o600 });
    try {
      const doc = await this.prisma.document.create({
        data: {
          id,
          userId,
          filename,
          mimeType: MIME_TYPES[kind],
          sizeBytes: bytes.length,
          contentHash,
          visibility: sharing.visibility,
          classification: sharing.classification,
          groupAccess: { create: sharing.groupIds.map((groupId) => ({ groupId })) },
        },
      });
      this.enqueue(doc.id);
      return doc;
    } catch (err) {
      await rm(this.filePath(id), { force: true });
      // Two concurrent uploads of the same file: the unique index wins.
      if ((err as { code?: string }).code === "P2002") throw conflict("This file was already uploaded");
      throw err;
    }
  }

  /** Deletes a document everywhere. Authorisation is the caller's job (AccessService.requireManageable). */
  async remove(documentId: string): Promise<void> {
    const doc = await this.prisma.document.findUnique({ where: { id: documentId }, select: { id: true } });
    if (!doc) throw notFound("Document not found");
    // Delete the row first: an indexing job that is still running checks for
    // the row inside its final transaction and cleans up its own vectors if it
    // is gone, so no ordering of the two operations can leave orphaned vectors.
    await this.prisma.document.deleteMany({ where: { id: documentId } });
    await this.vectors.deleteByDocument(documentId);
    await rm(this.filePath(documentId), { force: true });
  }

  /** Authorisation is the caller's job (AccessService.requireManageable). */
  async reindex(documentId: string): Promise<Document> {
    const doc = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!doc) throw notFound("Document not found");
    if (doc.status === "PENDING" || doc.status === "PROCESSING") throw conflict("Document is already being indexed");
    const updated = await this.prisma.document.update({
      where: { id: documentId },
      data: { status: "PENDING", error: null },
    });
    this.enqueue(documentId);
    return updated;
  }

  /**
   * After a restart: PENDING documents are re-queued. Documents that were
   * PROCESSING are marked FAILED instead of retried automatically — if that
   * document is what crashed the process, retrying it would crash-loop.
   */
  async recoverInterrupted(): Promise<number> {
    const interrupted = await this.prisma.document.findMany({ where: { status: "PROCESSING" }, select: { id: true, userId: true } });
    for (const d of interrupted) {
      await this.vectors.deleteByDocument(d.id).catch(() => {});
      await this.prisma.documentChunk.deleteMany({ where: { documentId: d.id } });
    }
    await this.prisma.document.updateMany({
      where: { id: { in: interrupted.map((d) => d.id) } },
      data: { status: "FAILED", chunkCount: 0, error: "Indexing was interrupted by a server restart. Use Re-index to try again." },
    });
    const docs = await this.prisma.document.findMany({
      where: { status: "PENDING" },
      select: { id: true },
      orderBy: { uploadedAt: "asc" },
    });
    docs.forEach((d) => this.enqueue(d.id));
    return docs.length;
  }

  /** Resolves when the background queue is empty (used by tests and shutdown). */
  onIdle(): Promise<void> {
    return this.queue.onIdle();
  }

  private enqueue(documentId: string): void {
    this.queue.push(documentId, () => this.process(documentId));
  }

  private filePath(documentId: string): string {
    return join(this.uploadDir, documentId);
  }

  /** Runs the full pipeline for one document. Never throws; failures are recorded on the document. */
  async process(documentId: string): Promise<void> {
    const doc = await this.prisma.document.findUnique({ where: { id: documentId }, include: { groupAccess: { select: { groupId: true } }, userAccess: { select: { userId: true } } } });
    if (!doc) return;
    const access = toAccessPayload(doc);
    const started = Date.now();
    const claimed = await this.prisma.document.updateMany({ where: { id: documentId }, data: { status: "PROCESSING", error: null } });
    if (claimed.count === 0) return; // deleted in the meantime

    try {
      const bytes = await readFile(this.filePath(documentId)).catch(() => {
        throw badRequest("Original file is missing; please upload it again");
      });
      const extracted = await extractDocument(doc.filename, bytes);
      const chunks = chunkDocument(extracted.pages, this.opts);
      if (chunks.length === 0) throw badRequest("Document contains no indexable text");
      if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
        throw badRequest(`Document is too large to index (${chunks.length} chunks; the limit is ${MAX_CHUNKS_PER_DOCUMENT})`);
      }

      const vectors = await this.embeddings.embedDocuments(chunks.map((c) => c.content));
      const points: VectorPoint[] = chunks.map((chunk, i) => ({
        id: randomUUID(),
        vector: vectors[i] as number[],
        payload: {
          ...access,
          documentId: doc.id,
          fileName: doc.filename,
          chunkIndex: chunk.index,
          content: chunk.content,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
        },
      }));

      // Re-indexing: drop the previous generation of vectors first.
      await this.vectors.deleteByDocument(doc.id);
      await this.vectors.upsert(points);

      const committed = await this.prisma.$transaction(async (tx) => {
        const still = await tx.document.findUnique({ where: { id: documentId }, select: { id: true } });
        if (!still) return false; // deleted while we were working
        await tx.documentChunk.deleteMany({ where: { documentId } });
        await tx.documentChunk.createMany({
          data: chunks.map((c, i) => ({
            documentId,
            chunkIndex: c.index,
            vectorId: (points[i] as VectorPoint).id,
            pageStart: c.pageStart,
            pageEnd: c.pageEnd,
            tokenCount: c.tokenCount,
          })),
        });
        await tx.document.update({
          where: { id: documentId },
          data: {
            status: "READY",
            chunkCount: chunks.length,
            pageCount: extracted.pageCount,
            embeddingModel: this.embeddings.model,
            indexedAt: new Date(),
          },
        });
        return true;
      });
      if (!committed) {
        await this.vectors.deleteByDocument(doc.id);
        return;
      }
      // Sharing may have changed while we were embedding: re-sync the payload if so.
      const now = await this.prisma.document.findUnique({ where: { id: documentId }, include: { groupAccess: { select: { groupId: true } }, userAccess: { select: { userId: true } } } });
      if (now && JSON.stringify(toAccessPayload(now)) !== JSON.stringify(access)) {
        await this.vectors.setAccess(documentId, toAccessPayload(now));
      }
      this.log.info({ documentId, chunks: chunks.length, ms: Date.now() - started }, "document indexed");
    } catch (err) {
      const message = err instanceof AppError ? err.message : `Indexing failed: ${errorMessage(err)}`;
      this.log.error({ documentId, err: errorMessage(err) }, "document ingestion failed");
      await this.vectors.deleteByDocument(doc.id).catch(() => {});
      await this.prisma.documentChunk.deleteMany({ where: { documentId } }).catch(() => {});
      await this.prisma.document
        .update({ where: { id: documentId }, data: { status: "FAILED", error: message.slice(0, 500), chunkCount: 0 } })
        .catch(() => {});
    }
  }
}
