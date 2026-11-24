/**
 * API contract shared by `@localmind/api` and `@localmind/web`.
 * Keep this file free of runtime dependencies.
 */

export type DocumentStatus = "PENDING" | "PROCESSING" | "READY" | "FAILED";
export type MessageRole = "USER" | "ASSISTANT";
export type ToolExecutionStatus = "SUCCESS" | "ERROR" | "DENIED";

export interface UserDto {
  id: string;
  email: string;
  role: "USER" | "ADMIN";
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  user: UserDto;
}

/** A document passage the assistant was given while answering. */
export interface Source {
  /** Short label (S1, S2, …) the model uses for inline citations. */
  ref: string;
  documentId: string;
  fileName: string;
  chunkIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  score: number;
  /** A short excerpt of the chunk for display. */
  excerpt: string;
}

export interface ToolExecutionSummary {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  status: ToolExecutionStatus;
  durationMs: number;
  error?: string;
}

export interface ChatRequest {
  conversationId?: string;
  message: string;
}

export interface ChatResponse {
  conversationId: string;
  messageId: string;
  answer: string;
  sources: Source[];
  toolExecutions: ToolExecutionSummary[];
}

export interface MessageDto {
  id: string;
  role: MessageRole;
  content: string;
  sources: Source[];
  toolExecutions: ToolExecutionSummary[];
  createdAt: string;
}

export interface ConversationSummaryDto {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDto extends ConversationSummaryDto {
  messages: MessageDto[];
}

export interface DocumentDto {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  error: string | null;
  pageCount: number | null;
  chunkCount: number;
  uploadedAt: string;
  indexedAt: string | null;
}

export interface ToolInfoDto {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  requiredRole: "USER" | "ADMIN";
}

export interface HealthDto {
  status: "ok" | "degraded";
  checks: Record<string, { ok: boolean; detail?: string }>;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

/** Events emitted by `POST /api/chat/stream` (Server-Sent Events). */
export type ChatStreamEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "token"; content: string }
  /** The text streamed so far was a preamble to a tool call; clear the draft. */
  | { type: "reset" }
  | { type: "tool_start"; id: string; tool: string; arguments: Record<string, unknown> }
  | { type: "tool_end"; execution: ToolExecutionSummary }
  | { type: "done"; response: ChatResponse }
  | { type: "error"; message: string };
