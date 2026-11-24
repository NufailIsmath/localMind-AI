/**
 * Client for the company's external HR leave system.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ PROVISIONAL CONTRACT. The real API is still being built by the HR        │
 * │ system's vendor. When its spec arrives, adapt ONLY this file: the event  │
 * │ outbox, retries, ordering and the rest of CL Buddy stay the same.        │
 * │ Full description: docs/hr-integration.md                                 │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 *   leave.request_submitted  → POST {base}/leave-requests                  → { id }
 *   leave.request_withdrawn  → POST {base}/leave-requests/{id}/withdraw
 *   leave.request_approved   → POST {base}/leave-requests/{id}/decision    { decision: "approved", … }
 *   leave.request_rejected   → POST {base}/leave-requests/{id}/decision    { decision: "rejected", … }
 *   leave.cancelled          → POST {base}/leave-requests/{id}/cancel
 *   leave.recorded           → POST {base}/leave-records                   → { id }   (entered by HR in CL Buddy)
 *
 * Every call: `Authorization: Bearer <HR_API_TOKEN>`, `Idempotency-Key: <event id>`
 * (safe to retry), `Content-Type: application/json`.
 */

export type HrEventType =
  | "leave.request_submitted"
  | "leave.request_withdrawn"
  | "leave.request_approved"
  | "leave.request_rejected"
  | "leave.cancelled"
  | "leave.recorded";

/** Snapshot of the leave at the time of the change (stored in the outbox). */
export interface HrLeavePayload {
  clbuddyLeaveId: string;
  employeeEmail: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  days: number;
  note: string | null;
  decisionNote?: string | null;
  decidedByEmail?: string | null;
  occurredAt: string;
}

export interface HrEvent {
  id: string;
  type: HrEventType;
  payload: HrLeavePayload;
  /** The HR system's id for this leave, once known. */
  externalId: string | null;
}

export class HrSyncError extends Error {
  constructor(
    message: string,
    /** Network errors, timeouts, 408/429/5xx are retried; other 4xx are not. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "HrSyncError";
  }
}

export interface HrLeaveClient {
  send(event: HrEvent): Promise<{ externalId?: string }>;
}

const CREATES: HrEventType[] = ["leave.request_submitted", "leave.recorded"];
export const needsExternalId = (t: HrEventType) => !CREATES.includes(t);

export class HttpHrLeaveClient implements HrLeaveClient {
  private readonly base: string;

  constructor(private readonly opts: { baseUrl: string; token?: string; timeoutMs: number; fetchImpl?: typeof fetch }) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
  }

  async send(event: HrEvent): Promise<{ externalId?: string }> {
    const p = event.payload;
    const leave = {
      clbuddy_leave_id: p.clbuddyLeaveId,
      employee_email: p.employeeEmail,
      leave_type: p.leaveType.toLowerCase(),
      start_date: p.startDate,
      end_date: p.endDate,
      days: p.days,
      note: p.note,
    };
    const ext = event.externalId ? encodeURIComponent(event.externalId) : null;
    if (needsExternalId(event.type) && !ext) throw new HrSyncError("No HR-system id for this leave yet", true);

    let path: string;
    let body: Record<string, unknown>;
    switch (event.type) {
      case "leave.request_submitted":
        [path, body] = ["/leave-requests", { ...leave, status: "pending", submitted_at: p.occurredAt }];
        break;
      case "leave.recorded":
        [path, body] = ["/leave-records", { ...leave, status: "approved", recorded_at: p.occurredAt }];
        break;
      case "leave.request_withdrawn":
        [path, body] = [`/leave-requests/${ext}/withdraw`, { withdrawn_at: p.occurredAt }];
        break;
      case "leave.request_approved":
      case "leave.request_rejected":
        [path, body] = [
          `/leave-requests/${ext}/decision`,
          {
            decision: event.type === "leave.request_approved" ? "approved" : "rejected",
            note: p.decisionNote ?? null,
            decided_by: p.decidedByEmail ?? null,
            decided_at: p.occurredAt,
          },
        ];
        break;
      case "leave.cancelled":
        [path, body] = [`/leave-requests/${ext}/cancel`, { cancelled_at: p.occurredAt }];
        break;
    }

    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(`${this.base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": event.id,
          ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      const timedOut = (err as Error).name === "TimeoutError";
      throw new HrSyncError(timedOut ? `HR system timed out after ${this.opts.timeoutMs}ms` : `Can't reach the HR system (${(err as Error).message})`, true);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      throw new HrSyncError(`HR system answered ${res.status} for ${event.type}${text ? `: ${text}` : ""}`, retryable);
    }
    const json = (await res.json().catch(() => ({}))) as { id?: unknown };
    return typeof json.id === "string" || typeof json.id === "number" ? { externalId: String(json.id) } : {};
  }
}
