import type { Classification, DocumentVisibility, Prisma, PrismaClient } from "@prisma/client";
import { badRequest, conflict, errorMessage, forbidden, notFound } from "../../lib/errors.js";
import type { VectorStore } from "../../rag/vector.service.js";
import type { WithheldMatch } from "../../rag/retrieval.service.js";
import { accessibleDocumentsWhere, canRead, classificationLevel, toAccessPayload, type AccessPrincipal } from "./access.policy.js";

/** At most this many "that's confidential" notices per search. */
const MAX_NOTICES = 2;

export interface SharingInput {
  visibility?: DocumentVisibility;
  classification?: Classification;
  groupIds?: string[];
}

export interface SharingSettings {
  visibility: DocumentVisibility;
  classification: Classification;
  groupIds: string[];
}

export interface AccessLogger {
  warn(obj: object, msg?: string): void;
}

/** Relations needed to render a document and its access settings. */
export const DOCUMENT_INCLUDE = {
  user: { select: { email: true } },
  groupAccess: { include: { group: { select: { id: true, name: true } } } },
  userAccess: { include: { user: { select: { id: true, email: true } } } },
} satisfies Prisma.DocumentInclude;

export type DocumentWithAccess = Prisma.DocumentGetPayload<{ include: typeof DOCUMENT_INCLUDE }>;

export interface UserProfile {
  id: string;
  email: string;
  role: "USER" | "ADMIN";
  clearance: Classification;
  createdAt: Date;
  groups: { id: string; name: string }[];
}

export const toPrincipal = (u: UserProfile): AccessPrincipal => ({
  userId: u.id,
  role: u.role,
  clearance: u.clearance,
  groupIds: u.groups.map((g) => g.id),
});

export class AccessService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly vectors: VectorStore,
    private readonly log: AccessLogger,
  ) {}

  // ---------- identity ----------

  /** Loaded on every request, so clearance and membership changes apply immediately. */
  async loadProfile(userId: string): Promise<UserProfile | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        clearance: true,
        createdAt: true,
        memberships: { select: { group: { select: { id: true, name: true } } }, orderBy: { group: { name: "asc" } } },
      },
    });
    if (!u) return null;
    const { memberships, ...rest } = u;
    return { ...rest, groups: memberships.map((m) => m.group) };
  }

  // ---------- documents ----------

  /**
   * Validates sharing settings. Non-admins may only share with groups they
   * belong to — otherwise anyone could push content (including prompt
   * injections) into other teams' knowledge bases.
   */
  async validateSharing(actor: AccessPrincipal, input: SharingInput, current?: SharingSettings): Promise<SharingSettings> {
    const visibility = input.visibility ?? current?.visibility ?? "PRIVATE";
    const classification = input.classification ?? current?.classification ?? "INTERNAL";
    let groupIds = visibility === "GROUPS" ? [...new Set(input.groupIds ?? current?.groupIds ?? [])] : [];

    if (visibility === "GROUPS") {
      if (groupIds.length === 0) throw badRequest("Choose at least one group to share with");
      const found = await this.prisma.group.findMany({ where: { id: { in: groupIds } }, select: { id: true } });
      if (found.length !== groupIds.length) throw badRequest("One or more groups do not exist");
      if (actor.role !== "ADMIN") {
        const notMember = groupIds.filter((g) => !actor.groupIds.includes(g));
        if (notMember.length) throw forbidden("You can only share documents with groups you belong to");
      }
      groupIds = found.map((g) => g.id);
    }
    return { visibility, classification, groupIds };
  }

  /** 404 when the principal can't read the document (doesn't reveal that it exists). */
  async requireReadable(p: AccessPrincipal, documentId: string): Promise<DocumentWithAccess> {
    const doc = await this.prisma.document.findFirst({
      where: { AND: [{ id: documentId }, accessibleDocumentsWhere(p)] },
      include: DOCUMENT_INCLUDE,
    });
    if (!doc) throw notFound("Document not found");
    return doc;
  }

  /** Owner or admin may delete, re-index or change access. Readers get 403. */
  async requireManageable(p: AccessPrincipal, documentId: string): Promise<DocumentWithAccess> {
    if (p.role === "ADMIN") {
      const doc = await this.prisma.document.findUnique({ where: { id: documentId }, include: DOCUMENT_INCLUDE });
      if (!doc) throw notFound("Document not found");
      return doc;
    }
    const doc = await this.requireReadable(p, documentId);
    if (doc.userId !== p.userId) throw forbidden("Only the document's owner or an administrator can change it");
    return doc;
  }

  listReadable(p: AccessPrincipal): Promise<DocumentWithAccess[]> {
    return this.prisma.document.findMany({
      where: accessibleDocumentsWhere(p),
      orderBy: { uploadedAt: "desc" },
      include: DOCUMENT_INCLUDE,
    });
  }

  /** Ids (from `documentIds`) the principal may read right now and that are searchable. */
  async readableIds(p: AccessPrincipal, documentIds: string[]): Promise<Set<string>> {
    if (documentIds.length === 0) return new Set();
    const rows = await this.prisma.document.findMany({
      where: { AND: [{ id: { in: documentIds } }, { status: { not: "FAILED" } }, accessibleDocumentsWhere(p)] },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Changes who can read a document. PostgreSQL is updated first: retrieval
   * re-checks every hit against it, so a restriction takes effect immediately
   * even before (or if) the Qdrant payload update completes.
   */
  async updateDocumentAccess(actor: AccessPrincipal, documentId: string, input: SharingInput): Promise<DocumentWithAccess> {
    const doc = await this.requireManageable(actor, documentId);
    const before: SharingSettings = {
      visibility: doc.visibility,
      classification: doc.classification,
      groupIds: doc.groupAccess.map((g) => g.groupId),
    };
    const next = await this.validateSharing(actor, input, before);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.documentGroupAccess.deleteMany({ where: { documentId } });
      if (next.groupIds.length) {
        await tx.documentGroupAccess.createMany({ data: next.groupIds.map((groupId) => ({ documentId, groupId })) });
      }
      const d = await tx.document.update({
        where: { id: documentId },
        data: { visibility: next.visibility, classification: next.classification },
        include: DOCUMENT_INCLUDE,
      });
      await tx.auditEvent.create({
        data: {
          actorId: actor.userId,
          action: "document.access.updated",
          targetType: "document",
          targetId: documentId,
          details: { filename: doc.filename, before, after: next } as unknown as Prisma.InputJsonValue,
        },
      });
      return d;
    });
    await this.syncVectorAccess(documentId);
    return updated;
  }

  /**
   * Classifies strong matches the principal can't read. Deliberately narrow:
   * only READY documents shared with a team or the organisation are ever
   * acknowledged — someone's PRIVATE files are never hinted at — and only
   * classification + audience are disclosed, never title or content.
   */
  async withheldMatches(p: AccessPrincipal, candidates: { documentId: string; score: number }[]): Promise<WithheldMatch[]> {
    const ids = [...new Set(candidates.map((c) => c.documentId))];
    const docs = await this.prisma.document.findMany({
      where: { id: { in: ids }, status: "READY", visibility: { in: ["ORGANIZATION", "GROUPS"] }, userId: { not: p.userId } },
      select: {
        id: true,
        userId: true,
        visibility: true,
        classification: true,
        groupAccess: { select: { groupId: true, group: { select: { name: true } } } },
        userAccess: { select: { userId: true } },
      },
    });
    const byId = new Map(docs.map((d) => [d.id, d]));
    const out: WithheldMatch[] = [];
    for (const id of ids) {
      const d = byId.get(id);
      if (!d || canRead(p, toAccessPayload(d))) continue;
      const aboveClearance = classificationLevel(d.classification) > classificationLevel(p.clearance);
      // One "above your clearance" notice says everything needed (there's nothing to request);
      // more would only disclose how many restricted documents match.
      if (aboveClearance && out.some((n) => n.reason === "above_clearance")) continue;
      out.push({
        documentId: d.id,
        reason: aboveClearance ? "above_clearance" : "not_shared",
        classification: d.classification,
        sharedWith: d.visibility === "ORGANIZATION" ? ["the whole organization"] : d.groupAccess.map((g) => g.group.name).sort(),
        canRequest: !aboveClearance,
      });
      if (out.length >= MAX_NOTICES) break;
    }
    return out;
  }

  /** Revokes an individual grant (owner or admin). */
  async revokeGrant(actor: AccessPrincipal, documentId: string, userId: string): Promise<void> {
    const doc = await this.requireManageable(actor, documentId);
    const { count } = await this.prisma.documentUserAccess.deleteMany({ where: { documentId, userId } });
    if (count === 0) throw notFound("Grant not found");
    await this.audit(actor.userId, "document.grant.revoked", "document", documentId, { filename: doc.filename, userId });
    await this.syncVectorAccess(documentId);
  }

  /** Copies the document's current access settings from PostgreSQL onto its vectors. */
  async syncVectorAccess(documentId: string): Promise<void> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { userId: true, visibility: true, classification: true, groupAccess: { select: { groupId: true } }, userAccess: { select: { userId: true } } },
    });
    if (!doc) return;
    try {
      await this.vectors.setAccess(documentId, toAccessPayload(doc));
    } catch (err) {
      // Safe to continue: retrieval re-checks PostgreSQL, so a stale payload can only
      // hide a document, never expose one. A re-index re-writes the payload.
      this.log.warn({ documentId, err: errorMessage(err) }, "failed to sync vector access payload");
    }
  }

  // ---------- administration ----------

  async listUsers() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        email: true,
        role: true,
        clearance: true,
        createdAt: true,
        memberships: { select: { group: { select: { id: true, name: true } } } },
      },
    });
    return users.map(({ memberships, ...u }) => ({ ...u, groups: memberships.map((m) => m.group) }));
  }

  async updateUser(
    actor: AccessPrincipal,
    userId: string,
    input: { role?: "USER" | "ADMIN"; clearance?: Classification; groupIds?: string[] },
  ) {
    const user = await this.loadProfile(userId);
    if (!user) throw notFound("User not found");
    if (input.role === "USER" && user.role === "ADMIN") {
      const admins = await this.prisma.user.count({ where: { role: "ADMIN" } });
      if (admins <= 1) throw conflict("Cannot demote the last administrator");
    }
    if (input.groupIds) {
      const found = await this.prisma.group.count({ where: { id: { in: input.groupIds } } });
      if (found !== new Set(input.groupIds).size) throw badRequest("One or more groups do not exist");
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { ...(input.role ? { role: input.role } : {}), ...(input.clearance ? { clearance: input.clearance } : {}) },
      });
      if (input.groupIds) {
        await tx.groupMembership.deleteMany({ where: { userId } });
        await tx.groupMembership.createMany({ data: [...new Set(input.groupIds)].map((groupId) => ({ userId, groupId })) });
      }
      await tx.auditEvent.create({
        data: {
          actorId: actor.userId,
          action: "user.access.updated",
          targetType: "user",
          targetId: userId,
          details: {
            email: user.email,
            before: { role: user.role, clearance: user.clearance, groupIds: user.groups.map((g) => g.id) },
            after: input,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    });
    return (await this.listUsers()).find((u) => u.id === userId)!;
  }

  async listGroups() {
    const groups = await this.prisma.group.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { members: true, documents: true } } },
    });
    return groups.map(({ _count, ...g }) => ({ ...g, memberCount: _count.members, documentCount: _count.documents }));
  }

  async createGroup(actor: AccessPrincipal, name: string, description?: string) {
    try {
      const group = await this.prisma.group.create({ data: { name: name.trim(), description } });
      await this.audit(actor.userId, "group.created", "group", group.id, { name: group.name });
      return { ...group, memberCount: 0, documentCount: 0 };
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw conflict(`A group named "${name}" already exists`);
      throw err;
    }
  }

  /** Deleting a group revokes the access it granted; affected vectors are re-synced. */
  async deleteGroup(actor: AccessPrincipal, groupId: string) {
    const group = await this.prisma.group.findUnique({ where: { id: groupId }, include: { documents: { select: { documentId: true } } } });
    if (!group) throw notFound("Group not found");
    await this.prisma.group.delete({ where: { id: groupId } });
    await this.audit(actor.userId, "group.deleted", "group", groupId, { name: group.name, documents: group.documents.length });
    for (const { documentId } of group.documents) await this.syncVectorAccess(documentId);
  }

  async listAudit(limit: number) {
    const rows = await this.prisma.auditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { actor: { select: { email: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      actorEmail: r.actor?.email ?? null,
      details: r.details,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async audit(actorId: string | null, action: string, targetType: string, targetId: string, details?: object) {
    await this.prisma.auditEvent.create({
      data: { actorId, action, targetType, targetId, details: details as Prisma.InputJsonValue },
    });
  }
}
