import type { z } from "zod";
import type { RetrievedChunk } from "../../rag/retrieval.service.js";

export type Role = "USER" | "ADMIN";

/**
 * Trusted execution context supplied by the server — never by the model.
 * Tools must take identity (userId, role) from here, not from their arguments.
 */
export interface ToolContext {
  userId: string;
  userRole: Role;
  conversationId: string;
  signal: AbortSignal;
  /** Registers retrieved chunks as citable sources; returns their refs (S1, S2…). */
  addSources(chunks: RetrievedChunk[], query?: string): string[];
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** Minimum role allowed to see and run this tool (default USER). */
  requiredRole?: Role;
  /** Overrides the global tool timeout. */
  timeoutMs?: number;
  execute(args: z.infer<S>, ctx: ToolContext): Promise<unknown>;
}

/** Identity helper that preserves the schema → args type inference. */
export function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}

export type ToolResult =
  | { status: "SUCCESS"; output: unknown; durationMs: number }
  | { status: "ERROR" | "DENIED"; error: string; durationMs: number };

/** An error whose message is safe to show to the model and the user. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}
