import type {
  LeaveEntryDto,
  LeaveRequestDto,
  LeaveBalanceDto,
  LeavePersonSummaryDto,
  LeaveType,
  AccessRequestDto,
  ApiErrorBody,
  AuditEventDto,
  DocumentAccessRequest,
  GroupDto,
  UpdateUserAccessRequest,
  AuthResponse,
  ChatRequest,
  ChatStreamEvent,
  ConversationDto,
  ConversationSummaryDto,
  DocumentDto,
  HealthDto,
  ToolInfoDto,
  UserDto,
} from "@clbuddy/shared";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const TOKEN_KEY = "clbuddy.token";

export const tokenStore = {
  get(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string | null) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable (private mode) — session only */
    }
  },
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export type AdminUserDto = Omit<UserDto, "canManageLeave">;

async function request<T>(path: string, init: { method?: string; token?: string | null; json?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
    });
  } catch {
    throw new ApiError(0, "NETWORK", `Cannot reach the CL Buddy API at ${API_URL}. Is it running?`);
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as T & Partial<ApiErrorBody>;
  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? "ERROR", body.message ?? `Request failed (${res.status})`, body.details);
  }
  return body;
}

export const api = {
  register: (email: string, password: string) => request<AuthResponse>("/api/auth/register", { method: "POST", json: { email, password } }),
  login: (email: string, password: string) => request<AuthResponse>("/api/auth/login", { method: "POST", json: { email, password } }),
  me: (token: string) => request<UserDto>("/api/auth/me", { token }),
  health: (token?: string | null) => request<HealthDto>("/api/health", { token }).catch((e: ApiError) => {
    // 503 still carries a useful body; surface network errors as degraded.
    if (e.status === 0) return { status: "degraded", checks: { api: { ok: false, detail: e.message } } } satisfies HealthDto;
    throw e;
  }),
  conversations: (token: string) => request<ConversationSummaryDto[]>("/api/chat", { token }),
  conversation: (token: string, id: string) => request<ConversationDto>(`/api/chat/${id}`, { token }),
  deleteConversation: (token: string, id: string) => request<void>(`/api/chat/${id}`, { method: "DELETE", token }),
  documents: (token: string) => request<DocumentDto[]>("/api/documents", { token }),
  upload: (token: string, file: File, sharing: DocumentAccessRequest = {}) => {
    const form = new FormData();
    if (sharing.visibility) form.append("visibility", sharing.visibility);
    if (sharing.classification) form.append("classification", sharing.classification);
    for (const g of sharing.groupIds ?? []) form.append("groupIds", g);
    form.append("file", file);
    return request<DocumentDto>("/api/documents/upload", { method: "POST", token, form });
  },
  deleteDocument: (token: string, id: string) => request<void>(`/api/documents/${id}`, { method: "DELETE", token }),
  reindexDocument: (token: string, id: string) => request<DocumentDto>(`/api/documents/${id}/reindex`, { method: "POST", token }),
  updateDocumentAccess: (token: string, id: string, body: DocumentAccessRequest) =>
    request<DocumentDto>(`/api/documents/${id}/access`, { method: "PATCH", token, json: body }),
  dismissSuggestion: (token: string, id: string) =>
    request<DocumentDto>(`/api/documents/${id}/suggestion/dismiss`, { method: "POST", token }),
  revokeGrant: (token: string, documentId: string, userId: string) =>
    request<void>(`/api/documents/${documentId}/grants/${userId}`, { method: "DELETE", token }),
  accessRequests: {
    create: (token: string, messageId: string, noticeId: string, note?: string) =>
      request<AccessRequestDto>("/api/access-requests", { method: "POST", token, json: { messageId, noticeId, ...(note ? { note } : {}) } }),
    list: (token: string) => request<{ incoming: AccessRequestDto[]; outgoing: AccessRequestDto[] }>("/api/access-requests", { token }),
    decide: (token: string, id: string, approve: boolean) =>
      request<AccessRequestDto>(`/api/access-requests/${id}/${approve ? "approve" : "deny"}`, { method: "POST", token }),
  },
  leave: {
    me: (token: string, year?: number) => request<LeaveBalanceDto>(`/api/leave/me${year ? `?year=${year}` : ""}`, { token }),
    people: (token: string, year: number) => request<LeavePersonSummaryDto[]>(`/api/leave/manage/people?year=${year}`, { token }),
    setAllowance: (
      token: string,
      body: { userId: string; year: number; leaveType: LeaveType; entitledDays: number; carriedOverDays?: number; carryOverExpiresOn?: string | null; adjustmentDays?: number },
    ) => request<void>("/api/leave/manage/allowances", { method: "PUT", token, json: body }),
    addEntry: (token: string, body: { userId: string; leaveType: LeaveType; startDate: string; endDate: string; days?: number; note?: string }) =>
      request<unknown>("/api/leave/manage/entries", { method: "POST", token, json: body }),
    cancelEntry: (token: string, id: string) => request<void>(`/api/leave/manage/entries/${id}`, { method: "DELETE", token }),
    submitFromCard: (token: string, messageId: string, actionId: string) =>
      request<LeaveEntryDto>("/api/leave/requests", { method: "POST", token, json: { messageId, actionId } }),
    cancelMine: (token: string, id: string) => request<LeaveEntryDto>(`/api/leave/requests/${id}/cancel`, { method: "POST", token }),
    requests: (token: string, status: "PENDING" | "DECIDED" = "PENDING") =>
      request<LeaveRequestDto[]>(`/api/leave/manage/requests?status=${status}`, { token }),
    decide: (token: string, id: string, approve: boolean, note?: string) =>
      request<LeaveEntryDto>(`/api/leave/manage/requests/${id}/${approve ? "approve" : "reject"}`, { method: "POST", token, json: note ? { note } : {} }),
    holidays: (token: string, year: number) => request<{ date: string; name: string }[]>(`/api/leave/holidays?year=${year}`, { token }),
    addHoliday: (token: string, date: string, name: string) => request<void>("/api/leave/manage/holidays", { method: "POST", token, json: { date, name } }),
    removeHoliday: (token: string, date: string) => request<void>(`/api/leave/manage/holidays/${date}`, { method: "DELETE", token }),
    importCsv: (token: string, kind: "allowances" | "entries", csv: string) =>
      request<{ imported: number }>("/api/leave/manage/import", { method: "POST", token, json: { kind, csv } }),
  },
  admin: {
    users: (token: string) => request<AdminUserDto[]>("/api/admin/users", { token }),
    createUser: (token: string, body: { email: string; password: string; clearance?: string; groupIds?: string[] }) =>
      request<AdminUserDto>("/api/admin/users", { method: "POST", token, json: body }),
    updateUser: (token: string, id: string, body: UpdateUserAccessRequest) =>
      request<AdminUserDto>(`/api/admin/users/${id}`, { method: "PATCH", token, json: body }),
    groups: (token: string) => request<GroupDto[]>("/api/admin/groups", { token }),
    createGroup: (token: string, name: string, description?: string) =>
      request<GroupDto>("/api/admin/groups", { method: "POST", token, json: { name, description } }),
    updateGroup: (token: string, id: string, description: string | null) =>
      request<GroupDto>(`/api/admin/groups/${id}`, { method: "PATCH", token, json: { description } }),
    deleteGroup: (token: string, id: string) => request<void>(`/api/admin/groups/${id}`, { method: "DELETE", token }),
    hrSync: (token: string) =>
      request<{
        enabled: boolean;
        baseUrl: string;
        counts: Partial<Record<"PENDING" | "SENT" | "FAILED", number>>;
        lastSentAt: string | null;
        failures: { id: string; eventType: string; attempts: number; lastError: string | null; createdAt: string; employeeEmail: string | null }[];
      }>("/api/admin/integrations/hr", { token }),
    hrSyncNow: (token: string) => request<{ delivered: number }>("/api/admin/integrations/hr/sync", { method: "POST", token }),
    hrRetry: (token: string, id: string) => request<void>(`/api/admin/integrations/hr/events/${id}/retry`, { method: "POST", token }),
    audit: (token: string) => request<AuditEventDto[]>("/api/admin/audit?limit=100", { token }),
  },
  tools: (token: string) => request<ToolInfoDto[]>("/api/tools", { token }),
};

/**
 * POSTs a chat message and parses the Server-Sent Events response.
 * (EventSource can't send a body or Authorization header, so we read the stream manually.)
 */
export async function streamChat(
  token: string,
  body: ChatRequest,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/chat/stream`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return;
    throw new ApiError(0, "NETWORK", `Cannot reach the CL Buddy API at ${API_URL}.`);
  }
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as Partial<ApiErrorBody>;
    throw new ApiError(res.status, err.error ?? "ERROR", err.message ?? `Request failed (${res.status})`, err.details);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      // Normalise CRLF framing on the whole buffer so a "\r\n" split across chunks is handled.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue; // comments / heartbeats
        const event = JSON.parse(data) as ChatStreamEvent;
        if (event.type === "done" || event.type === "error") terminal = true;
        onEvent(event);
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (signal?.aborted) return;
    throw err instanceof SyntaxError ? new ApiError(0, "STREAM", "Received a malformed response from the API.") : err;
  }
  // The connection closed without a final event (server restarted, proxy cut the stream…).
  if (!terminal && !signal?.aborted) {
    throw new ApiError(0, "STREAM", "The connection to the API was interrupted before the answer finished.");
  }
}
