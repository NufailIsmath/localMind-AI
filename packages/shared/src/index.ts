/**
 * API contract shared by `@localmind/api` and `@localmind/web`.
 * Keep this file free of runtime dependencies.
 */

export type DocumentStatus = "PENDING" | "PROCESSING" | "READY" | "FAILED";
export type MessageRole = "USER" | "ASSISTANT";
export type ToolExecutionStatus = "SUCCESS" | "ERROR" | "DENIED";
/** Ordered from least to most sensitive. */
export type Classification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";
export type DocumentVisibility = "PRIVATE" | "ORGANIZATION" | "GROUPS";
export const CLASSIFICATIONS: readonly Classification[] = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"];

export interface GroupRefDto {
  id: string;
  name: string;
}

export interface UserDto {
  id: string;
  email: string;
  role: "USER" | "ADMIN";
  /** Highest classification this user may read when a document is shared with them. */
  clearance: Classification;
  groups: GroupRefDto[];
  createdAt: string;
}

export interface GroupDto extends GroupRefDto {
  description: string | null;
  memberCount: number;
  documentCount: number;
  createdAt: string;
}

export interface UpdateUserAccessRequest {
  role?: "USER" | "ADMIN";
  clearance?: Classification;
  groupIds?: string[];
}

export interface DocumentAccessRequest {
  visibility?: DocumentVisibility;
  classification?: Classification;
  groupIds?: string[];
}

export interface AuditEventDto {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  actorEmail: string | null;
  details: unknown;
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
  classification: Classification;
  /** True when the passage comes from a document another user shared. */
  shared: boolean;
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
  visibility: DocumentVisibility;
  classification: Classification;
  groups: GroupRefDto[];
  /** Whether the current user uploaded it (and can manage it). */
  owned: boolean;
  ownerEmail: string;
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
