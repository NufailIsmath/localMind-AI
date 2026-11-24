import { describe, expect, it } from "vitest";
import { canRead, readableClassifications, toAccessPayload } from "../../src/modules/access/access.policy.js";
import { principal } from "../helpers/access.js";

const doc = (over: Partial<Parameters<typeof toAccessPayload>[0]> = {}) =>
  toAccessPayload({ userId: "owner", visibility: "PRIVATE", classification: "INTERNAL", groupAccess: [], ...over });

describe("access policy", () => {
  it("owners always read their own documents, whatever the classification", () => {
    expect(canRead(principal("owner", { clearance: "PUBLIC" }), doc({ classification: "RESTRICTED" }))).toBe(true);
  });

  it("private documents are invisible to everyone else, including admins", () => {
    expect(canRead(principal("x", { role: "ADMIN", clearance: "RESTRICTED" }), doc())).toBe(false);
  });

  it("organisation-wide documents require sufficient clearance", () => {
    const d = doc({ visibility: "ORGANIZATION", classification: "CONFIDENTIAL" });
    expect(canRead(principal("intern", { clearance: "INTERNAL" }), d)).toBe(false);
    expect(canRead(principal("hr", { clearance: "CONFIDENTIAL" }), d)).toBe(true);
  });

  it("group documents require membership AND clearance", () => {
    const d = doc({ visibility: "GROUPS", classification: "CONFIDENTIAL", groupAccess: [{ groupId: "hr" }] });
    expect(canRead(principal("a", { clearance: "RESTRICTED", groupIds: ["eng"] }), d)).toBe(false);
    expect(canRead(principal("b", { clearance: "INTERNAL", groupIds: ["hr"] }), d)).toBe(false);
    expect(canRead(principal("c", { clearance: "CONFIDENTIAL", groupIds: ["eng", "hr"] }), d)).toBe(true);
  });

  it("drops stale group ids when a document isn't group-shared, and treats legacy points as private", () => {
    expect(doc({ visibility: "ORGANIZATION", groupAccess: [{ groupId: "hr" }] }).groupIds).toEqual([]);
    expect(canRead(principal("x", { clearance: "RESTRICTED" }), { userId: "owner" })).toBe(false);
  });

  it("orders classifications", () => {
    expect(readableClassifications("CONFIDENTIAL")).toEqual(["PUBLIC", "INTERNAL", "CONFIDENTIAL"]);
    expect(readableClassifications("PUBLIC")).toEqual(["PUBLIC"]);
  });
});
