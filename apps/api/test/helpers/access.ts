import type { AccessPayload, AccessPrincipal } from "../../src/modules/access/access.policy.js";

export const principal = (userId: string, over: Partial<AccessPrincipal> = {}): AccessPrincipal => ({
  userId,
  role: "USER",
  clearance: "INTERNAL",
  groupIds: [],
  ...over,
});

/** Access fields for a document only its owner can read. */
export const privateAccess = (userId: string): AccessPayload => ({
  userId,
  visibility: "PRIVATE",
  classification: "INTERNAL",
  classificationLevel: 1,
  groupIds: [],
  userIds: [],
});
