import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { defineTool } from "../tool.types.js";

/**
 * Read-only PostgreSQL tools. The model chooses *which* predefined query to run
 * and supplies validated parameters; it never writes SQL, and every query is
 * scoped to the authenticated user from the trusted context.
 */
export const listDocumentsTool = (prisma: PrismaClient) =>
  defineTool({
    name: "list_documents",
    description:
      "List the documents the user has uploaded, with their indexing status, page and chunk counts and upload dates.",
    schema: z.object({
      status: z.enum(["PENDING", "PROCESSING", "READY", "FAILED"]).optional().describe("Only return documents in this status"),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum number of documents (default 20)"),
    }),
    async execute({ status, limit }, ctx) {
      const docs = await prisma.document.findMany({
        where: { userId: ctx.userId, ...(status ? { status } : {}) },
        orderBy: { uploadedAt: "desc" },
        take: limit ?? 20,
        select: { filename: true, status: true, pageCount: true, chunkCount: true, sizeBytes: true, uploadedAt: true },
      });
      return {
        count: docs.length,
        documents: docs.map((d) => ({ ...d, uploadedAt: d.uploadedAt.toISOString() })),
      };
    },
  });

export const usageStatsTool = (prisma: PrismaClient) =>
  defineTool({
    name: "get_usage_stats",
    description:
      "Get statistics about the user's LocalMind account: number of documents, indexed chunks, conversations, " +
      "messages and the most used tools.",
    schema: z.object({}),
    async execute(_args, ctx) {
      const userId = ctx.userId;
      const [documents, chunks, conversations, messages, tools] = await Promise.all([
        prisma.document.count({ where: { userId } }),
        prisma.document.aggregate({ where: { userId }, _sum: { chunkCount: true } }),
        prisma.conversation.count({ where: { userId } }),
        prisma.message.count({ where: { conversation: { userId } } }),
        prisma.toolExecution.groupBy({
          by: ["toolName"],
          where: { conversation: { userId } },
          _count: { _all: true },
          orderBy: { _count: { toolName: "desc" } },
          take: 5,
        }),
      ]);
      return {
        documents,
        indexedChunks: chunks._sum.chunkCount ?? 0,
        conversations,
        messages,
        topTools: tools.map((t) => ({ tool: t.toolName, executions: t._count._all })),
      };
    },
  });

/** Admin-only: demonstrates role-based tool permissions. */
export const systemStatsTool = (prisma: PrismaClient) =>
  defineTool({
    name: "get_system_stats",
    description: "Administrator only. Get instance-wide totals: users, documents by status and tool execution outcomes.",
    requiredRole: "ADMIN",
    schema: z.object({}),
    async execute() {
      const [users, byStatus, toolOutcomes] = await Promise.all([
        prisma.user.count(),
        prisma.document.groupBy({ by: ["status"], _count: { _all: true } }),
        prisma.toolExecution.groupBy({ by: ["status"], _count: { _all: true } }),
      ]);
      return {
        users,
        documentsByStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
        toolExecutionsByStatus: Object.fromEntries(toolOutcomes.map((s) => [s.status, s._count._all])),
      };
    },
  });
