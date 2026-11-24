import type { PrismaClient } from "@prisma/client";
import type { RetrievalService } from "../../rag/retrieval.service.js";
import { ToolRegistry } from "./tool.registry.js";
import { calculatorTool } from "./tools/calculator.tool.js";
import { listDocumentsTool, systemStatsTool, usageStatsTool } from "./tools/database.tools.js";
import { searchKnowledgeTool } from "./tools/search-knowledge.tool.js";
import { getCurrentTimeTool } from "./tools/time.tool.js";

export function createToolRegistry(deps: {
  prisma: PrismaClient;
  retrieval: RetrievalService;
  timeoutMs: number;
  acknowledgeRestricted?: boolean;
  onUnexpectedError?: (tool: string, err: unknown) => void;
}): ToolRegistry {
  return new ToolRegistry(deps.timeoutMs, deps.onUnexpectedError)
    .register(searchKnowledgeTool(deps.retrieval, 10, deps.acknowledgeRestricted ?? true))
    .register(getCurrentTimeTool())
    .register(calculatorTool)
    .register(listDocumentsTool(deps.prisma))
    .register(usageStatsTool(deps.prisma))
    .register(systemStatsTool(deps.prisma));
}

export { ToolRegistry } from "./tool.registry.js";
export * from "./tool.types.js";
