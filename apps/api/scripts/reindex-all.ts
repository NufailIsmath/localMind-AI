/**
 * Re-embeds every document with the current embedding settings. Run it after
 * changing EMBEDDING_PROVIDER / EMBEDDING_MODEL (with a new QDRANT_COLLECTION):
 *
 *   npm run reindex:all
 *
 * Documents are re-read from the upload folder; nothing else changes (sharing,
 * classification and chat history stay as they are).
 */
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";

const config = loadConfig();
const app = await buildApp({ ...config, logLevel: "warn" });
const { prisma, ingestion, vectors } = app.services;
await vectors.ensureCollection();

const docs = await prisma.document.findMany({ where: { status: { notIn: ["PENDING", "PROCESSING"] } }, select: { id: true, filename: true } });
console.log(`Re-indexing ${docs.length} document(s) with ${config.ai.embeddingProvider === "openai" ? config.ai.label : "Ollama"} / ${config.ollama.embeddingModel} into "${config.qdrant.collection}"…`);
for (const d of docs) await ingestion.reindex(d.id);
await ingestion.onIdle();

const after = await prisma.document.groupBy({ by: ["status"], _count: { _all: true } });
console.log(after.map((s) => `${s.status}: ${s._count._all}`).join(", ") || "no documents");
const failed = await prisma.document.findMany({ where: { status: "FAILED" }, select: { filename: true, error: true } });
for (const f of failed) console.log(`  failed: ${f.filename}: ${f.error}`);
await app.close();
process.exit(failed.length ? 1 : 0);
