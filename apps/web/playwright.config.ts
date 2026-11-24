import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive the real UI against the real API, PostgreSQL and
 * Qdrant. For a deterministic model they expect the mock Ollama server:
 *
 *   npm run infra:up && npm run db:deploy
 *   npm run mock:ollama        # terminal 1
 *   RETRIEVAL_SCORE_THRESHOLD=0.05 npm run dev:api   # terminal 2 (the mock's toy
 *                              # embeddings score lower than a real model)
 *   npm run seed:demo          # demo organisation for access.spec.ts
 *   npm run build -w @localmind/web && npm run start -w @localmind/web   # terminal 3
 *   npm run e2e -w @localmind/web
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "off",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1400, height: 900 } }, testIgnore: /mobile\.spec\.ts/ },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" }, testMatch: /mobile\.spec\.ts/ },
  ],
});
