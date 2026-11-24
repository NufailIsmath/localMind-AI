import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ToolExecutionSummary, ToolInfoDto } from "@localmind/shared";
import { parse } from "../../lib/validation.js";
import { toParametersSchema } from "./tool.registry.js";

export const toolRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req): Promise<ToolInfoDto[]> =>
    app.services.tools.list(req.currentUser.role).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toParametersSchema(t.schema),
      requiredRole: t.requiredRole ?? "USER",
    })),
  );

  /** Audit trail of the current user's tool executions. */
  app.get("/executions", async (req): Promise<(ToolExecutionSummary & { conversationId: string; createdAt: string })[]> => {
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const rows = await app.services.prisma.toolExecution.findMany({
      where: { conversation: { userId: req.currentUser.id } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversationId,
      tool: r.toolName,
      arguments: r.arguments as Record<string, unknown>,
      status: r.status,
      durationMs: r.durationMs,
      ...(r.error ? { error: r.error } : {}),
      createdAt: r.createdAt.toISOString(),
    }));
  });
};
