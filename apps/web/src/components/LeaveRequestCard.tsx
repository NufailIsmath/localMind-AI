"use client";

import type { ChatActionDto } from "@clbuddy/shared";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";

const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const label = (t: string) => t.charAt(0) + t.slice(1).toLowerCase();

/**
 * A leave request the assistant PREPARED. Nothing is submitted until the user
 * presses "Submit request" — the model has no tool that submits. After that
 * the card tracks the request live: pending → approved / rejected (with HR's note).
 */
export function LeaveRequestCard({
  action,
  messageId,
  token,
  onChange,
  onSend,
}: {
  action: ChatActionDto;
  messageId: string;
  token: string;
  onChange: (request: ChatActionDto["request"]) => void;
  onSend: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changedRef = useRef(onChange);
  changedRef.current = onChange;
  // Tell the rest of the page (e.g. the My leave card) that leave changed.
  const changed = { current: (r: ChatActionDto["request"]) => {
    changedRef.current(r);
    window.dispatchEvent(new Event("clbuddy:leave-changed"));
  } };
  const req = action.request;
  const year = Number(action.startDate.slice(0, 4));

  // Follow a pending request until HR decides.
  useEffect(() => {
    if (req?.status !== "PENDING") return;
    const timer = setInterval(async () => {
      try {
        const me = await api.leave.me(token, year);
        const now = me.requests.find((r) => r.id === req.id);
        if (now && now.status !== "PENDING") changed.current({ id: now.id, status: now.status, decisionNote: now.decisionNote ?? null });
      } catch {
        /* next tick */
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [req?.status, req?.id, token, year]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.leave.submitFromCard(token, messageId, action.id);
      changed.current({ id: r.id, status: r.status, decisionNote: r.decisionNote ?? null });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't submit the request");
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!req) return;
    setBusy(true);
    try {
      const r = await api.leave.cancelMine(token, req.id);
      changed.current({ id: r.id, status: r.status, decisionNote: r.decisionNote ?? null });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't withdraw");
    } finally {
      setBusy(false);
    }
  }

  const status = req?.status;
  return (
    <div className={`leave-card ${status ? `leave-card-${status.toLowerCase()}` : ""}`} data-testid="leave-request-card">
      <div className="draft-head">🌴 {label(action.leaveType)} leave request</div>
      <dl className="draft-fields">
        <dt>From</dt>
        <dd>{fmt(action.startDate)}</dd>
        <dt>To</dt>
        <dd>{fmt(action.endDate)}</dd>
        <dt>Working days</dt>
        <dd>{action.workingDays}</dd>
        {action.availableAfter !== null && (
          <>
            <dt>Left after</dt>
            <dd>{action.availableAfter} days</dd>
          </>
        )}
        {action.note && (
          <>
            <dt>Note</dt>
            <dd>{action.note}</dd>
          </>
        )}
      </dl>
      {action.warnings.length > 0 && <p className="leave-warn small pad-x">⚠️ {action.warnings.join(" ")}</p>}
      <div className="draft-actions">
        {!req && (
          <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void submit()}>
            {busy ? "Submitting…" : "Submit request"}
          </button>
        )}
        {status === "PENDING" && (
          <>
            <span className="status-chip pending">⏳ Waiting for HR approval</span>
            <button type="button" className="link" disabled={busy} onClick={() => void withdraw()}>
              Withdraw
            </button>
          </>
        )}
        {status === "APPROVED" && <span className="status-chip approved">✓ Approved{req?.decisionNote ? `: “${req.decisionNote}”` : ""}</span>}
        {status === "REJECTED" && (
          <>
            <span className="status-chip rejected">✕ Not approved{req?.decisionNote ? `: “${req.decisionNote}”` : ""}</span>
            <button type="button" className="link" onClick={() => onSend("My leave request was rejected. Can you help me pick other dates?")}>
              Pick other dates
            </button>
          </>
        )}
        {status === "CANCELLED" && <span className="status-chip">Withdrawn</span>}
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
