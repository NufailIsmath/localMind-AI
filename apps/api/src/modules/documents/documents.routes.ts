import type { FastifyPluginAsync } from "fastify";
import type { Document } from "@prisma/client";
import type { DocumentDto } from "@localmind/shared";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
import { UuidParam, parse } from "../../lib/validation.js";

export function toDocumentDto(d: Document): DocumentDto {
  return {
    id: d.id,
    filename: d.filename,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    status: d.status,
    error: d.error,
    pageCount: d.pageCount,
    chunkCount: d.chunkCount,
    uploadedAt: d.uploadedAt.toISOString(),
    indexedAt: d.indexedAt?.toISOString() ?? null,
  };
}

export const documentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  const { prisma, ingestion } = app.services;

  app.post("/upload", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!req.isMultipart()) throw badRequest("Expected multipart/form-data with a 'file' field");
    const file = await req.file();
    if (!file) throw badRequest("No file uploaded");
    if (file.fieldname !== "file") throw badRequest("The upload field must be named 'file'");
    let bytes: Buffer;
    try {
      bytes = await file.toBuffer();
    } catch (err) {
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
        throw new AppError(413, "PAYLOAD_TOO_LARGE", "File is too large");
      }
      throw err;
    }
    const doc = await ingestion.upload(req.currentUser.id, file.filename, bytes);
    return reply.code(202).send(toDocumentDto(doc));
  });

  app.get("/", async (req) => {
    const docs = await prisma.document.findMany({
      where: { userId: req.currentUser.id },
      orderBy: { uploadedAt: "desc" },
    });
    return docs.map(toDocumentDto);
  });

  app.get("/:id", async (req) => {
    const { id } = parse(UuidParam, req.params);
    const doc = await prisma.document.findFirst({ where: { id, userId: req.currentUser.id } });
    if (!doc) throw notFound("Document not found");
    return toDocumentDto(doc);
  });

  app.post("/:id/reindex", async (req, reply) => {
    const { id } = parse(UuidParam, req.params);
    const doc = await ingestion.reindex(req.currentUser.id, id);
    return reply.code(202).send(toDocumentDto(doc));
  });

  app.delete("/:id", async (req, reply) => {
    const { id } = parse(UuidParam, req.params);
    await ingestion.remove(req.currentUser.id, id);
    return reply.code(204).send();
  });
};
