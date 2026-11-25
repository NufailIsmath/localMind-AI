import { existsSync } from "node:fs";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { retry } from "./lib/async.js";
import { errorMessage } from "./lib/errors.js";

async function main() {
  const config = loadConfig();
  const app = await buildApp(config);
  const { vectors, ingestion, ollama } = app.services;

  try {
    await retry(() => vectors.ensureCollection(), { retries: 5, baseDelayMs: 1000 });
  } catch (err) {
    app.log.fatal(`Cannot initialise Qdrant at ${config.qdrant.url}: ${errorMessage(err)}`);
    process.exit(1);
  }

  // Inside a container, "localhost" is the container itself — a classic misconfiguration.
  if (existsSync("/.dockerenv") && /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(config.ollama.host)) {
    app.log.warn(
      `OLLAMA_HOST is ${config.ollama.host}, but the API is running inside Docker, where localhost is this container. ` +
        "Use http://ollama:11434 (the compose service) or http://host.docker.internal:11434 (Ollama on your computer).",
    );
  }

  // Warn (don't fail) when Ollama is down: the API is still useful for browsing history.
  ollama
    .listModels({ timeoutMs: 3000 })
    .then((models) => {
      for (const m of [config.ollama.chatModel, config.ollama.embeddingModel]) {
        if (!models.some((n) => n === m || n === `${m}:latest`)) {
          app.log.warn(`Ollama model "${m}" is not installed. Run: ollama pull ${m}`);
        }
      }
    })
    .catch((err) => app.log.warn(`Ollama is not reachable at ${config.ollama.host}: ${errorMessage(err)}`));

  const recovered = await ingestion.recoverInterrupted();
  if (recovered) app.log.info(`Re-queued ${recovered} interrupted document(s) for indexing`);

  await app.listen({ host: config.host, port: config.port });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
