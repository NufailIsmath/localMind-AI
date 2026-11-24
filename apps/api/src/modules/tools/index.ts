import type { PrismaClient } from "@prisma/client";
import type { RetrievalService } from "../../rag/retrieval.service.js";
import { ToolRegistry } from "./tool.registry.js";
import { calculatorTool } from "./tools/calculator.tool.js";
import { listDocumentsTool, systemStatsTool, usageStatsTool } from "./tools/database.tools.js";
import { searchKnowledgeTool } from "./tools/search-knowledge.tool.js";
import { getCurrentTimeTool } from "./tools/time.tool.js";
import { findTeamTool } from "./tools/team.tool.js";
import { checkLeaveDatesTool, myLeaveBalanceTool } from "./tools/leave.tools.js";
import type { LeaveService } from "../leave/leave.service.js";

export function createToolRegistry(deps: {
  prisma: PrismaClient;
  retrieval: RetrievalService;
  timeoutMs: number;
  leave?: LeaveService;
  acknowledgeRestricted?: boolean;
  onUnexpectedError?: (tool: string, err: unknown) => void;
}): ToolRegistry {
  const registry = new ToolRegistry(deps.timeoutMs, deps.onUnexpectedError)
    .register(searchKnowledgeTool(deps.retrieval, 10, deps.acknowledgeRestricted ?? true))
    .register(findTeamTool(deps.prisma))
    .register(getCurrentTimeTool())
    .register(calculatorTool)
    .register(listDocumentsTool(deps.prisma))
    .register(usageStatsTool(deps.prisma))
    .register(systemStatsTool(deps.prisma));
  if (deps.leave) registry.register(myLeaveBalanceTool(deps.leave)).register(checkLeaveDatesTool(deps.leave));
  return registry;
}

export { ToolRegistry } from "./tool.registry.js";
export * from "./tool.types.js";
