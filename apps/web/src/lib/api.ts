import type {
  ApiErrorBody,
  AuthResponse,
  ChatRequest,
  ChatStreamEvent,
  ConversationDto,
  ConversationSummaryDto,
  DocumentDto,
  HealthDto,
  ToolInfoDto,
  UserDto,
} from "@localmind/shared";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const TOKEN_KEY = "localmind.token";

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
    throw new ApiError(0, "NETWORK", `Cannot reach the LocalMind API at ${API_URL}. Is it running?`);
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
  health: () => request<HealthDto>("/api/health").catch((e: ApiError) => {
    // 503 still carries a useful body; surface network errors as degraded.
    if (e.status === 0) return { status: "degraded", checks: { api: { ok: false, detail: e.message } } } satisfies HealthDto;
    throw e;
  }),
  conversations: (token: string) => request<ConversationSummaryDto[]>("/api/chat", { token }),
  conversation: (token: string, id: string) => request<ConversationDto>(`/api/chat/${id}`, { token }),
  deleteConversation: (token: string, id: string) => request<void>(`/api/chat/${id}`, { method: "DELETE", token }),
  documents: (token: string) => request<DocumentDto[]>("/api/documents", { token }),
  upload: (token: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<DocumentDto>("/api/documents/upload", { method: "POST", token, form });
  },
  deleteDocument: (token: string, id: string) => request<void>(`/api/documents/${id}`, { method: "DELETE", token }),
  reindexDocument: (token: string, id: string) => request<DocumentDto>(`/api/documents/${id}/reindex`, { method: "POST", token }),
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
    throw new ApiError(0, "NETWORK", `Cannot reach the LocalMind API at ${API_URL}.`);
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
