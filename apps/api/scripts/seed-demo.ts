/**
 * Seeds a demo organisation for trying document-level access control:
 *
 *   npm run seed:demo -w @localmind/api
 *
 * Needs PostgreSQL, Qdrant and Ollama (or `npm run mock:ollama`) running.
 * Idempotent: re-running updates roles/clearances and skips existing files.
 *
 *   Account (password: demo-password)   Role   Clearance      Groups
 *   ceo@demo.local                      ADMIN  Restricted     Executives
 *   cfo@demo.local                      USER   Restricted     Executives
 *   hr@demo.local                       USER   Confidential   HR
 *   engineer@demo.local                 USER   Confidential   Engineering
 *   intern@demo.local                   USER   Internal       Engineering
 *
 *   Document                      Shared with         Classification
 *   employee-handbook.md          Organization        Internal
 *   product-faq.txt               Organization        Public
 *   security-policy.md            Organization        Internal
 *   executive-compensation.md     HR + Executives     Confidential
 *   board-strategy.md             Organization        Restricted
 *   engineering-roadmap.md        Engineering         Internal
 *   hr-onboarding-checklist.md    HR                  Internal
 *
 * Re-running also clears individual grants and access requests on these
 * documents, so the demo (and the E2E suite) start from a known state.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Classification, DocumentVisibility } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { hashPassword } from "../src/modules/auth/password.js";

const PASSWORD = "demo-password";
const GROUPS = ["Executives", "HR", "Engineering"] as const;
type GroupName = (typeof GROUPS)[number];

const PEOPLE: { email: string; role: "USER" | "ADMIN"; clearance: Classification; groups: GroupName[] }[] = [
  { email: "ceo@demo.local", role: "ADMIN", clearance: "RESTRICTED", groups: ["Executives"] },
  { email: "cfo@demo.local", role: "USER", clearance: "RESTRICTED", groups: ["Executives"] },
  { email: "hr@demo.local", role: "USER", clearance: "CONFIDENTIAL", groups: ["HR"] },
  { email: "engineer@demo.local", role: "USER", clearance: "CONFIDENTIAL", groups: ["Engineering"] },
  { email: "intern@demo.local", role: "USER", clearance: "INTERNAL", groups: ["Engineering"] },
];

const root = resolve(import.meta.dirname, "../eval");
const DOCS: { file: string; owner: string; visibility: DocumentVisibility; classification: Classification; groups?: GroupName[] }[] = [
  { file: "documents/employee-handbook.md", owner: "hr@demo.local", visibility: "ORGANIZATION", classification: "INTERNAL" },
  { file: "documents/product-faq.txt", owner: "ceo@demo.local", visibility: "ORGANIZATION", classification: "PUBLIC" },
  { file: "documents/security-policy.md", owner: "engineer@demo.local", visibility: "ORGANIZATION", classification: "INTERNAL" },
  { file: "demo-org/executive-compensation.md", owner: "hr@demo.local", visibility: "GROUPS", classification: "CONFIDENTIAL", groups: ["HR", "Executives"] },
  { file: "demo-org/board-strategy.md", owner: "ceo@demo.local", visibility: "ORGANIZATION", classification: "RESTRICTED" },
  { file: "demo-org/engineering-roadmap.md", owner: "engineer@demo.local", visibility: "GROUPS", classification: "INTERNAL", groups: ["Engineering"] },
  { file: "demo-org/hr-onboarding-checklist.md", owner: "hr@demo.local", visibility: "GROUPS", classification: "INTERNAL", groups: ["HR"] },
];

async function main() {
  const app = await buildApp({ ...loadConfig(), logLevel: "warn" });
  const { prisma, ingestion, vectors } = app.services;
  await vectors.ensureCollection();

  const groupIds = {} as Record<GroupName, string>;
  for (const name of GROUPS) {
    const g = await prisma.group.upsert({ where: { name }, update: {}, create: { name } });
    groupIds[name] = g.id;
  }

  const passwordHash = await hashPassword(PASSWORD);
  const userIds: Record<string, string> = {};
  for (const p of PEOPLE) {
    const u = await prisma.user.upsert({
      where: { email: p.email },
      update: { role: p.role, clearance: p.clearance },
      create: { email: p.email, passwordHash, role: p.role, clearance: p.clearance },
    });
    userIds[p.email] = u.id;
    await prisma.groupMembership.deleteMany({ where: { userId: u.id } });
    await prisma.groupMembership.createMany({ data: p.groups.map((g) => ({ userId: u.id, groupId: groupIds[g] })) });
  }

  for (const d of DOCS) {
    const filename = d.file.split("/").pop()!;
    const bytes = await readFile(join(root, d.file));
    try {
      await ingestion.upload(userIds[d.owner]!, filename, bytes, {
        visibility: d.visibility,
        classification: d.classification,
        groupIds: (d.groups ?? []).map((g) => groupIds[g]),
      });
      console.log(`  + ${filename}`);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 409) console.log(`  = ${filename} (already uploaded)`);
      else throw err;
    }
  }
  await ingestion.onIdle();

  // Reset demo grants/requests so every run starts the same way.
  const demoDocs = await prisma.document.findMany({ where: { userId: { in: Object.values(userIds) } }, select: { id: true } });
  const ids = demoDocs.map((d) => d.id);
  await prisma.accessRequest.deleteMany({ where: { documentId: { in: ids } } });
  const { count } = await prisma.documentUserAccess.deleteMany({ where: { documentId: { in: ids } } });
  if (count) for (const id of ids) await app.services.access.syncVectorAccess(id);
  await app.close();

  console.log(`\nDemo organisation ready. Sign in with any of these (password "${PASSWORD}"):`);
  console.table(PEOPLE.map((p) => ({ email: p.email, role: p.role, clearance: p.clearance, groups: p.groups.join(", ") })));
  console.log('Try: "What is the CEO salary?" as intern@demo.local, then as hr@demo.local.');
  console.log('Then: "What do new hires get on day one?" as engineer@demo.local → Ask for access → approve as hr@demo.local.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
