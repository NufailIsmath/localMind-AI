import { execSync } from "node:child_process";
import { resolve } from "node:path";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://localmind:localmind_dev@localhost:5432/localmind_test?schema=public";
export const TEST_QDRANT_URL = process.env.TEST_QDRANT_URL ?? "http://localhost:6333";

/** Applies migrations to the dedicated test database before the integration suite. */
export default async function setup() {
  try {
    const res = await fetch(`${TEST_QDRANT_URL}/collections`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(String(res.status));
    execSync("npx prisma migrate deploy", {
      cwd: resolve(import.meta.dirname, "../../../.."),
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdio: "pipe",
    });
    process.env.LOCALMIND_INTEGRATION_READY = "1";
  } catch (err) {
    console.warn(
      `\n⚠ Integration infrastructure unavailable (${(err as Error).message.split("\n")[0]}).\n` +
        "  Start it with `npm run infra:up` — integration tests will be skipped.\n",
    );
  }
}
