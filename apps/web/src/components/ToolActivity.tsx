"use client";

import type { ToolExecutionSummary } from "@clbuddy/shared";
import { TOOL_LABELS } from "@/lib/format";

export interface PendingTool {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
}

function describeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  if (typeof args.query === "string") return `“${args.query}”`;
  if ("a" in args && "b" in args && "operation" in args) return `${args.a} ${args.operation} ${args.b}`;
  return entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
}

export function ToolActivity({ executions, pending = [] }: { executions: ToolExecutionSummary[]; pending?: PendingTool[] }) {
  if (executions.length === 0 && pending.length === 0) return null;
  return (
    <ul className="tools" aria-label="Tool activity">
      {executions.map((t) => (
        <li key={t.id} className={`tool tool-${t.status.toLowerCase()}`} title={t.error ?? JSON.stringify(t.arguments)}>
          <span className="tool-icon" aria-hidden>
            {t.status === "SUCCESS" ? "✓" : t.status === "DENIED" ? "⊘" : "!"}
          </span>
          <span className="tool-name">{TOOL_LABELS[t.tool] ?? t.tool}</span>
          <span className="tool-args">{describeArgs(t.arguments)}</span>
          {t.error && <span className="tool-error">{t.error}</span>}
          <span className="tool-time">{t.durationMs} ms</span>
        </li>
      ))}
      {pending.map((t) => (
        <li key={t.id} className="tool tool-running">
          <span className="spinner" aria-hidden />
          <span className="tool-name">{TOOL_LABELS[t.tool] ?? t.tool}</span>
          <span className="tool-args">{describeArgs(t.arguments)}</span>
        </li>
      ))}
    </ul>
  );
}
