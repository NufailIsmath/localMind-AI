import type { Classification, DocumentVisibility, Prisma } from "@prisma/client";

/**
 * Document access policy — the single source of truth for "who may read what".
 *
 * A user may read a document when ANY of these holds:
 *   1. they own it;
 *   2. it is shared with the ORGANIZATION and its classification ≤ their clearance;
 *   3. it is shared with GROUPS they belong to and its classification ≤ their clearance;
 *   4. they were granted access individually (an approved access request) and its
 *      classification ≤ their clearance.
 *
 * Classification is checked *in addition to* group membership, so adding an
 * intern to the HR group by mistake still doesn't expose RESTRICTED files.
 *
 * The same rule is compiled three ways: a Qdrant filter (retrieval), a Prisma
 * `where` (listing and the post-retrieval re-check) and a plain predicate
 * (in-memory store, tests). Identity always comes from the authenticated
 * request — never from the model.
 */

export const CLASSIFICATIONS = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"] as const satisfies readonly Classification[];
export const VISIBILITIES = ["PRIVATE", "ORGANIZATION", "GROUPS"] as const satisfies readonly DocumentVisibility[];

export const classificationLevel = (c: Classification): number => CLASSIFICATIONS.indexOf(c);

/** Classifications readable with a given clearance. */
export const readableClassifications = (clearance: Classification): Classification[] =>
  CLASSIFICATIONS.slice(0, classificationLevel(clearance) + 1);

export interface AccessPrincipal {
  userId: string;
  role: "USER" | "ADMIN";
  clearance: Classification;
  groupIds: string[];
}

/** Access fields mirrored onto every chunk in the vector store. */
export interface AccessPayload {
  userId: string;
  visibility: DocumentVisibility;
  classification: Classification;
  classificationLevel: number;
  groupIds: string[];
  /** Users granted access individually. */
  userIds: string[];
}

export function canRead(p: AccessPrincipal, doc: Partial<AccessPayload> & { userId: string }): boolean {
  if (doc.userId === p.userId) return true;
  const level = doc.classificationLevel ?? (doc.classification ? classificationLevel(doc.classification) : Infinity);
  if (level > classificationLevel(p.clearance)) return false;
  if ((doc.userIds ?? []).includes(p.userId)) return true;
  if (doc.visibility === "ORGANIZATION") return true;
  if (doc.visibility === "GROUPS") return (doc.groupIds ?? []).some((g) => p.groupIds.includes(g));
  return false; // PRIVATE, or a legacy point without access fields
}

export function accessibleDocumentsWhere(p: AccessPrincipal): Prisma.DocumentWhereInput {
  const classification = { in: readableClassifications(p.clearance) };
  return {
    OR: [
      { userId: p.userId },
      { visibility: "ORGANIZATION", classification },
      { userAccess: { some: { userId: p.userId } }, classification },
      ...(p.groupIds.length
        ? [{ visibility: "GROUPS" as const, classification, groupAccess: { some: { groupId: { in: p.groupIds } } } }]
        : []),
    ],
  };
}

/** Qdrant filter clauses: a chunk matches if at least one `should` clause holds. */
export function qdrantAccessFilter(p: AccessPrincipal): { should: Record<string, unknown>[] } {
  const level = { key: "classificationLevel", range: { lte: classificationLevel(p.clearance) } };
  return {
    should: [
      { key: "userId", match: { value: p.userId } },
      { must: [{ key: "visibility", match: { value: "ORGANIZATION" } }, level] },
      { must: [{ key: "userIds", match: { any: [p.userId] } }, level] },
      ...(p.groupIds.length
        ? [{ must: [{ key: "visibility", match: { value: "GROUPS" } }, { key: "groupIds", match: { any: p.groupIds } }, level] }]
        : []),
    ],
  };
}

export function toAccessPayload(doc: {
  userId: string;
  visibility: DocumentVisibility;
  classification: Classification;
  groupAccess?: { groupId: string }[];
  userAccess?: { userId: string }[];
}): AccessPayload {
  return {
    userId: doc.userId,
    visibility: doc.visibility,
    classification: doc.classification,
    classificationLevel: classificationLevel(doc.classification),
    groupIds: doc.visibility === "GROUPS" ? (doc.groupAccess ?? []).map((g) => g.groupId) : [],
    userIds: (doc.userAccess ?? []).map((u) => u.userId),
  };
}
