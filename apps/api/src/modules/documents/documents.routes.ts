import type { FastifyPluginAsync } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { z } from "zod";
import type { DocumentDto } from "@localmind/shared";
import { AppError, badRequest } from "../../lib/errors.js";
import { UuidParam, parse } from "../../lib/validation.js";
import { CLASSIFICATIONS, VISIBILITIES, classificationLevel, type AccessPrincipal } from "../access/access.policy.js";
import { DOCUMENT_INCLUDE, type DocumentWithAccess } from "../access/access.service.js";

const canManage = (d: DocumentWithAccess, viewer: AccessPrincipal) => d.userId === viewer.userId || viewer.role === "ADMIN";

export function toDocumentDto(d: DocumentWithAccess, viewer: AccessPrincipal): DocumentDto {
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
    visibility: d.visibility,
    classification: d.classification,
    groups: d.groupAccess.map((g) => g.group),
    owned: d.userId === viewer.userId,
    ownerEmail: d.user.email,
    grants: canManage(d, viewer) ? d.userAccess.map((u) => u.user) : [],
    // Only the people who can act on it see the suggestion, and only when it would raise the label.
    suggestion:
      canManage(d, viewer) && d.suggestedClassification && classificationLevel(d.suggestedClassification) > classificationLevel(d.classification)
        ? { classification: d.suggestedClassification, reasons: (d.suggestionReasons as string[] | null) ?? [] }
        : null,
  };
}

const SharingSchema = z.object({
  visibility: z.enum(VISIBILITIES).optional(),
  classification: z.enum(CLASSIFICATIONS).optional(),
  groupIds: z.array(z.uuid()).max(50).optional(),
});

/** Multipart text fields → sharing input (`groupIds` may be repeated or comma-separated). */
function sharingFromFields(fields: Record<string, string[]>) {
  const one = (k: string) => fields[k]?.[0]?.trim() || undefined;
  const groupIds = (fields.groupIds ?? []).flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);
  return parse(SharingSchema, {
    visibility: one("visibility"),
    classification: one("classification"),
    groupIds: groupIds.length ? groupIds : undefined,
  });
}

export const documentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  const { ingestion, access, prisma } = app.services;
  // Re-read after a change; callers have already authorised the request.
  const reload = (id: string) => prisma.document.findUniqueOrThrow({ where: { id }, include: DOCUMENT_INCLUDE });

  /**
   * multipart/form-data with a `file` part and optional `visibility`,
   * `classification` and `groupIds` fields (in any order).
   */
  app.post("/upload", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!req.isMultipart()) throw badRequest("Expected multipart/form-data with a 'file' field");
    const fields: Record<string, string[]> = {};
    let file: { filename: string; bytes: Buffer } | undefined;
    try {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          if (part.fieldname !== "file" || file) {
            await (part as MultipartFile).toBuffer(); // drain
            throw badRequest("Upload exactly one file in a field named 'file'");
          }
          file = { filename: part.filename, bytes: await part.toBuffer() };
        } else if (typeof part.value === "string") {
          (fields[part.fieldname] ??= []).push(part.value);
        }
      }
    } catch (err) {
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
        throw new AppError(413, "PAYLOAD_TOO_LARGE", "File is too large");
      }
      throw err;
    }
    if (!file) throw badRequest("No file uploaded");

    const sharing = await access.validateSharing(req.principal, sharingFromFields(fields));
    const doc = await ingestion.upload(req.principal.userId, file.filename, file.bytes, sharing);
    if (sharing.visibility !== "PRIVATE") {
      await access.audit(req.principal.userId, "document.shared", "document", doc.id, { filename: doc.filename, ...sharing });
    }
    return reply.code(202).send(toDocumentDto(await reload(doc.id), req.principal));
  });

  /** Your documents plus everything shared with you that your clearance allows. */
  app.get("/", async (req) => (await access.listReadable(req.principal)).map((d) => toDocumentDto(d, req.principal)));

  app.get("/:id", async (req) => {
    const { id } = parse(UuidParam, req.params);
    return toDocumentDto(await access.requireReadable(req.principal, id), req.principal);
  });

  /** Change visibility, classification or groups (owner or admin). */
  app.patch("/:id/access", async (req) => {
    const { id } = parse(UuidParam, req.params);
    const body = parse(SharingSchema, req.body ?? {});
    return toDocumentDto(await access.updateDocumentAccess(req.principal, id, body), req.principal);
  });

  /** "Keep my label" — dismiss the classification suggestion. (Applying it is a normal PATCH /access.) */
  app.post("/:id/suggestion/dismiss", async (req) => {
    const { id } = parse(UuidParam, req.params);
    return toDocumentDto(await access.dismissSuggestion(req.principal, id), req.principal);
  });

  /** Revoke an individual grant (e.g. from an approved access request). */
  app.delete("/:id/grants/:userId", async (req, reply) => {
    const { id, userId } = parse(z.object({ id: z.uuid(), userId: z.uuid() }), req.params);
    await access.revokeGrant(req.principal, id, userId);
    return reply.code(204).send();
  });

  app.post("/:id/reindex", async (req, reply) => {
    const { id } = parse(UuidParam, req.params);
    await access.requireManageable(req.principal, id);
    await ingestion.reindex(id);
    return reply.code(202).send(toDocumentDto(await reload(id), req.principal));
  });

  app.delete("/:id", async (req, reply) => {
    const { id } = parse(UuidParam, req.params);
    const doc = await access.requireManageable(req.principal, id);
    await ingestion.remove(id);
    if (doc.userId !== req.principal.userId) {
      await access.audit(req.principal.userId, "document.deleted_by_admin", "document", id, { filename: doc.filename, owner: doc.user.email });
    }
    return reply.code(204).send();
  });
};
