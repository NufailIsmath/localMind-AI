import type { FastifyPluginAsync } from "fastify";
import type { HealthDto } from "@clbuddy/shared";
import { errorMessage } from "../../lib/errors.js";

class MissingModelsError extends Error {}

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (_req, reply) => {
    const { prisma, vectors, ollama, config } = app.services;
    // This endpoint is unauthenticated: return short, safe reasons and log the
    // full error (which can contain hostnames and connection strings) server-side.
    const check = async (name: string, fn: () => Promise<string | void>, safe?: (err: unknown) => string | undefined) => {
      try {
        const detail = await fn();
        return { ok: true, ...(detail ? { detail } : {}) };
      } catch (err) {
        _req.log.warn({ check: name, err: errorMessage(err) }, "health check failed");
        return { ok: false, detail: safe?.(err) ?? "unavailable" };
      }
    };

    const { ai } = config;
    const guard = app.services.moderation.guardModel;
    // Which models each backend must have, depending on where chat, embeddings and the guard run.
    const want = (provider: "ollama" | "openai") => [
      ...(ai.provider === provider ? [config.ollama.chatModel] : []),
      ...(ai.embeddingProvider === provider ? [config.ollama.embeddingModel] : []),
      ...(guard && ai.guardProvider === provider ? [guard] : []),
    ];
    const missingCheck = (models: string[], wanted: string[], hint: string) => {
      const has = (m: string) => models.some((name) => name === m || name === `${m}:latest`);
      const missing = wanted.filter((m) => !has(m));
      if (missing.length) throw new MissingModelsError(`missing models: ${missing.join(", ")} (${hint})`);
      return wanted.join(", ");
    };

    const checks: Record<string, Promise<{ ok: boolean; detail?: string }>> = {
      database: check("database", async () => {
        await prisma.$queryRaw`SELECT 1`;
      }),
      qdrant: check("qdrant", () => vectors.health()),
    };
    if (want("ollama").length) {
      checks.ollama = check(
        "ollama",
        async () => missingCheck(await ollama.listModels({ timeoutMs: 3000 }), want("ollama"), "run `ollama pull <model>`"),
        (err) => (err instanceof MissingModelsError ? err.message : "cannot reach Ollama"),
      );
    }
    if (want("openai").length && app.services.aiClient) {
      const client = app.services.aiClient;
      checks.ai = check(
        "ai",
        async () => {
          let models: string[];
          try {
            models = await client.listModels({ timeoutMs: 5000 });
          } catch (err) {
            // Some gateways don't offer a model list; reaching them with a valid key is enough.
            if ((err as { status?: number }).status === 404) return `${want("openai").join(", ")} via ${ai.label}`;
            throw err;
          }
          return `${missingCheck(models, want("openai"), `check the model names against ${ai.label}'s model list`)} via ${ai.label}`;
        },
        (err) => {
          if (err instanceof MissingModelsError) return err.message;
          const status = (err as { status?: number }).status;
          return status === 401 || status === 403 ? `${ai.label} rejected the API key` : status === 402 ? `${ai.label}: out of credit` : `cannot reach ${ai.label}`;
        },
      );
    }
    const all = Object.fromEntries(await Promise.all(Object.entries(checks).map(async ([k, p]) => [k, await p] as const)));

    // Anonymous callers (monitoring) get up/down only; details (model names, reasons) need a valid token.
    const authenticated = await _req.jwtVerify().then(() => true, () => false);
    const checksOut = authenticated
      ? all
      : Object.fromEntries(Object.entries(all).map(([k, c]) => [k, { ok: c.ok }]));
    const body: HealthDto = {
      status: Object.values(all).every((c) => c.ok) ? "ok" : "degraded",
      checks: checksOut,
      // Whether conversations leave the company's machines; the UI says so.
      ai: { mode: ai.provider === "openai" ? "hosted" : "local", ...(authenticated && ai.provider === "openai" ? { label: ai.label } : {}) },
    };
    return reply.code(body.status === "ok" ? 200 : 503).send(body);
  });
};
