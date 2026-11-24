import type { Prisma, PrismaClient } from "@prisma/client";
import type { AccessRequestDto } from "@localmind/shared";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.js";
import { classificationLevel, type AccessPrincipal } from "./access.policy.js";
import type { AccessService } from "./access.service.js";

/** Stored on Message.restricted. `documentId` never leaves the server. */
export interface StoredNotice {
  id: string;
  documentId: string;
  reason: "above_clearance" | "not_shared";
  classification: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";
  sharedWith: string[];
  canRequest: boolean;
}

const INCLUDE = {
  document: { select: { id: true, filename: true, userId: true, classification: true, visibility: true, groupAccess: { select: { group: { select: { name: true } } } } } },
  requester: { select: { id: true, email: true, clearance: true } },
  decidedBy: { select: { email: true } },
} satisfies Prisma.AccessRequestInclude;
type Row = Prisma.AccessRequestGetPayload<{ include: typeof INCLUDE }>;

/**
 * "Request access" workflow. A request can only be raised from a notice the
 * assistant actually showed the user (message + notice id), so nobody can
 * fish for document ids. Owners (or admins) approve or deny; approval adds an
 * individual grant, still capped by the requester's clearance.
 */
export class AccessRequestService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: AccessService,
  ) {}

  async create(actor: AccessPrincipal, input: { messageId: string; noticeId: string; note?: string }): Promise<AccessRequestDto> {
    const message = await this.prisma.message.findFirst({
      where: { id: input.messageId, role: "ASSISTANT", conversation: { userId: actor.userId } },
      select: { id: true, restricted: true },
    });
    const notice = ((message?.restricted as unknown as StoredNotice[] | null) ?? []).find((n) => n.id === input.noticeId);
    if (!message || !notice) throw notFound("Notice not found");
    if (!notice.canRequest) {
      throw badRequest("This document is above your clearance level. Only an administrator can change clearance.");
    }
    const existing = await this.prisma.accessRequest.findFirst({
      where: { documentId: notice.documentId, requesterId: actor.userId, status: "PENDING" },
      include: INCLUDE,
    });
    if (existing) return this.toRequesterDto(existing);
    const doc = await this.prisma.document.findUnique({ where: { id: notice.documentId }, select: { id: true } });
    if (!doc) throw notFound("That document no longer exists");

    const row = await this.prisma.accessRequest.create({
      data: {
        documentId: notice.documentId,
        requesterId: actor.userId,
        messageId: message.id,
        noticeId: notice.id,
        note: input.note?.trim().slice(0, 500) || null,
      },
      include: INCLUDE,
    });
    await this.access.audit(actor.userId, "access_request.created", "document", notice.documentId, { requestId: row.id });
    return this.toRequesterDto(row);
  }

  /** Incoming = pending requests for documents I own (admins: all). Outgoing = my requests. */
  async list(actor: AccessPrincipal): Promise<{ incoming: AccessRequestDto[]; outgoing: AccessRequestDto[] }> {
    const [incoming, outgoing] = await Promise.all([
      this.prisma.accessRequest.findMany({
        where: { status: "PENDING", ...(actor.role === "ADMIN" ? {} : { document: { userId: actor.userId } }) },
        orderBy: { createdAt: "asc" },
        include: INCLUDE,
      }),
      this.prisma.accessRequest.findMany({
        where: { requesterId: actor.userId },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: INCLUDE,
      }),
    ]);
    return {
      incoming: incoming.filter((r) => r.requesterId !== actor.userId).map((r) => this.toOwnerDto(r)),
      outgoing: outgoing.map((r) => this.toRequesterDto(r)),
    };
  }

  async decide(actor: AccessPrincipal, requestId: string, approve: boolean): Promise<AccessRequestDto> {
    const req = await this.prisma.accessRequest.findUnique({ where: { id: requestId }, include: INCLUDE });
    if (!req) throw notFound("Request not found");
    if (req.document.userId !== actor.userId && actor.role !== "ADMIN") throw forbidden("Only the document's owner or an administrator can decide");
    if (req.status !== "PENDING") throw conflict(`This request was already ${req.status.toLowerCase()}`);
    if (approve && classificationLevel(req.requester.clearance) < classificationLevel(req.document.classification)) {
      throw conflict(
        `${req.requester.email} has ${req.requester.clearance.toLowerCase()} clearance, below this document's ` +
          `${req.document.classification.toLowerCase()} classification. An administrator must raise their clearance first.`,
      );
    }
    const row = await this.prisma.$transaction(async (tx) => {
      if (approve) {
        await tx.documentUserAccess.upsert({
          where: { documentId_userId: { documentId: req.documentId, userId: req.requesterId } },
          update: {},
          create: { documentId: req.documentId, userId: req.requesterId, grantedById: actor.userId },
        });
      }
      return tx.accessRequest.update({
        where: { id: requestId },
        data: { status: approve ? "APPROVED" : "DENIED", decidedById: actor.userId, decidedAt: new Date() },
        include: INCLUDE,
      });
    });
    await this.access.audit(actor.userId, approve ? "access_request.approved" : "access_request.denied", "document", req.documentId, {
      requestId,
      requester: req.requester.email,
      filename: req.document.filename,
    });
    if (approve) await this.access.syncVectorAccess(req.documentId);
    return this.toOwnerDto(row);
  }

  /** Request status per notice, for rendering chat history. */
  async statusesForMessages(requesterId: string, messageIds: string[]): Promise<Map<string, AccessRequestDto["status"]>> {
    if (messageIds.length === 0) return new Map();
    const rows = await this.prisma.accessRequest.findMany({
      where: { requesterId, messageId: { in: messageIds } },
      orderBy: { createdAt: "asc" },
      select: { messageId: true, noticeId: true, status: true },
    });
    return new Map(rows.map((r) => [`${r.messageId}:${r.noticeId}`, r.status]));
  }

  private audience(r: Row): string[] {
    return r.document.visibility === "ORGANIZATION" ? ["the whole organization"] : r.document.groupAccess.map((g) => g.group.name).sort();
  }

  /** The owner sees who wants which file. */
  private toOwnerDto(r: Row): AccessRequestDto {
    return {
      id: r.id,
      status: r.status,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      classification: r.document.classification,
      sharedWith: this.audience(r),
      documentId: r.document.id,
      filename: r.document.filename,
      requesterEmail: r.requester.email,
      decidedByEmail: r.decidedBy?.email ?? null,
      messageId: null,
      noticeId: null,
    };
  }

  /** The requester only learns the file name once approved. */
  private toRequesterDto(r: Row): AccessRequestDto {
    const approved = r.status === "APPROVED";
    return {
      id: r.id,
      status: r.status,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      classification: r.document.classification,
      sharedWith: this.audience(r),
      documentId: approved ? r.document.id : null,
      filename: approved ? r.document.filename : null,
      requesterEmail: r.requester.email,
      decidedByEmail: null,
      messageId: r.messageId,
      noticeId: r.noticeId,
    };
  }
}
