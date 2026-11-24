import { z } from "zod";
import type { ToolSpec } from "../../ai/types.js";
import { TimeoutError, withTimeout } from "../../lib/async.js";
import { AppError, UpstreamError, errorMessage } from "../../lib/errors.js";
import { ToolError, type Role, type ToolContext, type ToolDefinition, type ToolResult } from "./tool.types.js";

const ROLE_RANK: Record<Role, number> = { USER: 0, ADMIN: 1 };

const canUse = (tool: ToolDefinition, role: Role) => ROLE_RANK[role] >= ROLE_RANK[tool.requiredRole ?? "USER"];

/** Converts a Zod schema into the JSON-schema "parameters" object the model sees. */
export function toParametersSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  delete json.$schema;
  if (json.type === "object") {
    json.properties ??= {};
    json.required ??= [];
  }
  return json;
}

/**
 * The tool registry is the security boundary between the model and the
 * application:
 *  - the model can only request tools that are registered here;
 *  - tools are filtered by the caller's role before being advertised, and the
 *    role is re-checked at execution time;
 *  - arguments are validated with Zod before any code runs;
 *  - each execution has a timeout, and errors are returned as data so the
 *    model can recover instead of crashing the request.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(
    private readonly defaultTimeoutMs: number,
    private readonly onUnexpectedError: (tool: string, err: unknown) => void = () => {},
  ) {}

  register(tool: ToolDefinition): this {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) throw new Error(`Invalid tool name "${tool.name}"`);
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
    this.tools.set(tool.name, tool);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Tools visible to a role. */
  list(role: Role = "ADMIN"): ToolDefinition[] {
    return [...this.tools.values()].filter((t) => canUse(t, role));
  }

  specs(role: Role): ToolSpec[] {
    return this.list(role).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toParametersSchema(t.schema),
    }));
  }

  async execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);

    const tool = this.tools.get(name);
    if (!tool) {
      return { status: "ERROR", error: `Unknown tool "${name}". Available tools: ${this.list(ctx.userRole).map((t) => t.name).join(", ")}`, durationMs: elapsed() };
    }
    if (!canUse(tool, ctx.userRole)) {
      return { status: "DENIED", error: `You are not allowed to use the "${name}" tool`, durationMs: elapsed() };
    }

    const parsed = tool.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return { status: "ERROR", error: `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`, durationMs: elapsed() };
    }

    const timeoutMs = tool.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const signal = AbortSignal.any([ctx.signal, controller.signal]);
    try {
      const output = await withTimeout(tool.execute(parsed.data, { ...ctx, signal }), timeoutMs, `Tool ${name}`);
      return { status: "SUCCESS", output: output ?? null, durationMs: elapsed() };
    } catch (err) {
      if (ctx.signal.aborted) throw err; // the whole request was cancelled
      if (err instanceof TimeoutError) controller.abort(err);
      const safe = err instanceof ToolError || err instanceof AppError || err instanceof TimeoutError || err instanceof UpstreamError;
      if (!safe) this.onUnexpectedError(name, err);
      // Internal errors (e.g. database exceptions) are not echoed to the model.
      const error = safe ? errorMessage(err) : `The ${name} tool failed due to an internal error`;
      return { status: "ERROR", error, durationMs: elapsed() };
    }
  }
}
