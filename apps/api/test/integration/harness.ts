import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AuthResponse, DocumentDto } from "@localmind/shared";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";
import { startFakeOllama, type FakeOllama } from "../helpers/fake-ollama-server.js";
import { TEST_DATABASE_URL, TEST_QDRANT_URL } from "./global-setup.js";

export const infraReady = process.env.LOCALMIND_INTEGRATION_READY === "1";

export interface Harness {
  app: FastifyInstance;
  fake: FakeOllama;
  collection: string;
  register(email?: string, password?: string): Promise<AuthResponse>;
  upload(token: string, filename: string, content: Buffer | string, fields?: Record<string, string>): Promise<{ status: number; body: any }>;
  waitForIndexing(): Promise<void>;
  close(): Promise<void>;
}

export async function createHarness(env: Record<string, string> = {}, { reset = true } = {}): Promise<Harness> {
  const fake = await startFakeOllama();
  const uploadDir = await mkdtemp(join(tmpdir(), "localmind-test-"));
  const collection = `test_${randomUUID().replace(/-/g, "")}`;
  const config = loadConfig({
    NODE_ENV: "test",
    JWT_SECRET: "integration-test-secret-integration-test-secret",
    DATABASE_URL: TEST_DATABASE_URL,
    QDRANT_URL: TEST_QDRANT_URL,
    QDRANT_COLLECTION: collection,
    OLLAMA_HOST: fake.url,
    UPLOAD_DIR: uploadDir,
    CHUNK_SIZE_TOKENS: "60",
    CHUNK_OVERLAP_TOKENS: "10",
    RETRIEVAL_SCORE_THRESHOLD: "0.15",
    RATE_LIMIT_ENABLED: "false",
    LOG_LEVEL: "silent",
    ...env,
  });
  const app = await buildApp(config, { logger: false });
  await app.services.vectors.ensureCollection();
  if (reset) await app.services.prisma.$executeRawUnsafe(
    'TRUNCATE "AuditEvent", "DocumentGroupAccess", "GroupMembership", "Group", "ToolExecution", "Message", "Conversation", "DocumentChunk", "Document", "User" CASCADE',
  );

  let n = 0;
  const harness: Harness = {
    app,
    fake,
    collection,
    async register(email = `user${++n}-${randomUUID().slice(0, 6)}@example.com`, password = "password123") {
      const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email, password } });
      if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
      return res.json<AuthResponse>();
    },
    async upload(token, filename, content, fields = {}) {
      const boundary = `----localmind${randomUUID()}`;
      const bytes = typeof content === "string" ? Buffer.from(content) : content;
      const fieldParts = Object.entries(fields).map(([k, v]) =>
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
      );
      const payload = Buffer.concat([
        ...fieldParts,
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const res = await app.inject({
        method: "POST",
        url: "/api/documents/upload",
        headers: { authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      return { status: res.statusCode, body: res.json() as DocumentDto | any };
    },
    waitForIndexing: () => app.services.ingestion.onIdle(),
    async close() {
      await app.services.ingestion.onIdle();
      await fetch(`${TEST_QDRANT_URL}/collections/${collection}`, { method: "DELETE" }).catch(() => {});
      await app.close();
      await fake.close();
      await rm(uploadDir, { recursive: true, force: true });
    },
  };
  return harness;
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });
