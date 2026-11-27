/**
 * API contract shared by `@clbuddy/api` and `@clbuddy/web`.
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
  /** HR team members and admins can manage everyone's leave records. */
  canManageLeave: boolean;
  createdAt: string;
}

export type LeaveType = "ANNUAL" | "SICK" | "PARENTAL" | "UNPAID" | "OTHER";

export interface LeaveBalance {
  year: number;
  leaveType: LeaveType;
  entitled: number;
  carriedOver: number;
  carryOverExpiresOn: string | null;
  carryOverForfeited: number;
  carryOverToUseBeforeExpiry: number;
  adjustments: number;
  total: number;
  taken: number;
  booked: number;
  remaining: number;
  /** Requested, awaiting approval (not deducted yet). */
  pending: number;
  /** remaining − pending: what a new request can use. */
  available: number;
}

export type LeaveEntryStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

export interface LeaveEntryDto {
  id: string;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  days: number;
  status: LeaveEntryStatus;
  note: string | null;
  source?: "MANUAL" | "IMPORT" | "REQUEST";
  decisionNote?: string | null;
  decidedAt?: string | null;
  createdAt?: string;
}

/** A leave request as HR sees it in the approvals inbox. */
export interface LeaveRequestDto extends LeaveEntryDto {
  requesterEmail: string;
  decidedByEmail: string | null;
  /** Requester's balance for that type if this request were approved. */
  availableIfApproved: number | null;
}

/**
 * Something the assistant prepared for the user to confirm with a click —
 * the model can propose, only the user can submit.
 */
export interface ChatActionDto {
  id: string;
  kind: "leave_request";
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  workingDays: number;
  availableAfter: number | null;
  warnings: string[];
  note: string | null;
  /** Set once the user submitted it. */
  request: { id: string; status: LeaveEntryStatus; decisionNote: string | null } | null;
}

export interface LeaveBalanceDto {
  year: number;
  asOf: string;
  /** False until HR has set up an allowance for this person and year. */
  configured: boolean;
  balances: LeaveBalance[];
  upcoming: LeaveEntryDto[];
  taken: LeaveEntryDto[];
  /** The user's own requests this year (pending first, then recent decisions). */
  requests: LeaveEntryDto[];
}

export interface LeavePlanDto {
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  workingDays: number;
  workingDates: string[];
  holidaysInRange: { date: string; name: string }[];
  configured: boolean;
  remainingBefore: number | null;
  remainingAfter: number | null;
  /** Available (remaining − pending) before/after: what requests are checked against. */
  availableBefore: number | null;
  availableAfter: number | null;
  warnings: string[];
  /** False when the dates can't be requested as they are (overdraw, clash, no working days, past). */
  requestable: boolean;
}

export interface LeavePersonSummaryDto {
  userId: string;
  email: string;
  annual: LeaveBalance | null;
  allowances: { leaveType: LeaveType; entitledDays: number; carriedOverDays: number; carryOverExpiresOn: string | null; adjustmentDays: number }[];
  entries: LeaveEntryDto[];
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
  /** Why this passage looks like a prompt-injection attempt (empty when it doesn't). */
  injectionFlags: string[];
  /** A short excerpt of the chunk for display. */
  excerpt: string;
}

/**
 * "That's confidential": a strong match in a document the user can't read.
 * Carries no title, content or score — only why and who it's shared with.
 */
export interface RestrictedNoticeDto {
  id: string;
  reason: "above_clearance" | "not_shared";
  classification: Classification;
  sharedWith: string[];
  /** True when an access request could be approved (clearance is sufficient). */
  canRequest: boolean;
  /** Status of the user's request raised from this notice, if any. */
  requestStatus: AccessRequestStatus | null;
}

export type AccessRequestStatus = "PENDING" | "APPROVED" | "DENIED";

export interface AccessRequestDto {
  id: string;
  status: AccessRequestStatus;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
  classification: Classification;
  sharedWith: string[];
  /** Hidden from the requester until approved. */
  documentId: string | null;
  filename: string | null;
  requesterEmail: string;
  decidedByEmail: string | null;
  /** The chat message + notice the request was raised from. */
  messageId: string | null;
  noticeId: string | null;
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

export type ModerationCategory = "sexual" | "hate" | "profanity" | "harassment" | "self_harm" | "harmful";

/** Shown with an answer when the content guardrails stepped in (a reminder, or why a message wasn't sent). */
export interface ModerationNoticeDto {
  action: "warn" | "block";
  category: ModerationCategory;
  message: string;
}

export interface ChatResponse {
  conversationId: string;
  messageId: string;
  answer: string;
  sources: Source[];
  restricted: RestrictedNoticeDto[];
  actions: ChatActionDto[];
  toolExecutions: ToolExecutionSummary[];
  moderation: ModerationNoticeDto | null;
}

export interface MessageDto {
  id: string;
  role: MessageRole;
  content: string;
  sources: Source[];
  restricted: RestrictedNoticeDto[];
  actions: ChatActionDto[];
  toolExecutions: ToolExecutionSummary[];
  moderation: ModerationNoticeDto | null;
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
  /** People granted access individually (visible to the owner and admins). */
  grants: { id: string; email: string }[];
  /** "This looks Confidential" — shown to the owner/admins when higher than the current label. */
  suggestion: { classification: Classification; reasons: string[] } | null;
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
