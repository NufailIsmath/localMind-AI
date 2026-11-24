import type { FastifyPluginAsync } from "fastify";
import type { HealthDto } from "@localmind/shared";
import { errorMessage } from "../../lib/errors.js";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (_req, reply) => {
    const { prisma, vectors, ollama, config } = app.services;
    const check = async (fn: () => Promise<string | void>) => {
      try {
        const detail = await fn();
        return { ok: true, ...(detail ? { detail } : {}) };
      } catch (err) {
        return { ok: false, detail: errorMessage(err) };
      }
    };

    const [database, qdrant, llm] = await Promise.all([
      check(async () => {
        await prisma.$queryRaw`SELECT 1`;
      }),
      check(() => vectors.health()),
      check(async () => {
        const models = await ollama.listModels({ timeoutMs: 3000 });
        const has = (m: string) => models.some((name) => name === m || name === `${m}:latest`);
        const missing = [config.ollama.chatModel, config.ollama.embeddingModel].filter((m) => !has(m));
        if (missing.length) throw new Error(`missing models: ${missing.join(", ")} (run \`ollama pull <model>\`)`);
        return `${config.ollama.chatModel}, ${config.ollama.embeddingModel}`;
      }),
    ]);

    const checks = { database, qdrant, ollama: llm };
    const body: HealthDto = { status: Object.values(checks).every((c) => c.ok) ? "ok" : "degraded", checks };
    return reply.code(body.status === "ok" ? 200 : 503).send(body);
  });
};
