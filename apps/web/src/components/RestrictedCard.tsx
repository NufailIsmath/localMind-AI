"use client";

import type { RestrictedNoticeDto } from "@localmind/shared";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { CLASSIFICATION_LABELS } from "@/lib/format";

const SUGGESTIONS = ["What can you help me with?", "Which documents can I see?"];

/**
 * Shown under an answer when relevant information exists in a document the
 * user can't read. Interactive: request access (with an optional note), see
 * the request's status, ask again once approved, or pick a follow-up.
 */
export function RestrictedCard({
  notice,
  messageId,
  token,
  question,
  onSend,
  onStatusChange,
}: {
  notice: RestrictedNoticeDto;
  messageId: string;
  token: string;
  question?: string;
  onSend: (text: string) => void;
  onStatusChange: (status: RestrictedNoticeDto["requestStatus"]) => void;
}) {
  const [composing, setComposing] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audience = notice.sharedWith.join(" & ");

  const statusChanged = useRef(onStatusChange);
  statusChanged.current = onStatusChange;

  // While a request is pending, check back now and then so approval shows up live.
  useEffect(() => {
    if (notice.requestStatus !== "PENDING") return;
    const timer = setInterval(async () => {
      try {
        const { outgoing } = await api.accessRequests.list(token);
        const mine = outgoing.find((r) => r.messageId === messageId && r.noticeId === notice.id);
        if (mine && mine.status !== "PENDING") statusChanged.current(mine.status);
      } catch {
        /* try again next tick */
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [notice.requestStatus, notice.id, messageId, token]);
  const above = notice.reason === "above_clearance";

  async function request() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.accessRequests.create(token, messageId, notice.id, note.trim() || undefined);
      onStatusChange(r.status);
      setComposing(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't send the request");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`restricted ${above ? "restricted-above" : ""}`} role="note" aria-label="Confidential information">
      <div className="restricted-head">
        <span className="restricted-icon" aria-hidden>
          {above ? "🤫" : "🔒"}
        </span>
        <div>
          <strong>
            {CLASSIFICATION_LABELS[notice.classification]} · {above ? "above your clearance" : `only shared with ${audience}`}
          </strong>
          <div className="muted small">
            {above
              ? `It's shared with ${audience}. Clearance can only be changed by an administrator.`
              : "Its owner can give you access."}
          </div>
        </div>
      </div>

      {!above && notice.requestStatus === null && !composing && (
        <div className="restricted-actions">
          <button type="button" className="btn-primary btn-sm" onClick={() => setComposing(true)}>
            Ask for access
          </button>
        </div>
      )}
      {composing && (
        <div className="restricted-compose">
          <textarea
            aria-label="Why do you need access? (optional)"
            placeholder="Why do you need it? (optional, helps the owner decide)"
            maxLength={500}
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="restricted-actions">
            <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void request()}>
              {busy ? "Sending…" : "Send request"}
            </button>
            <button type="button" className="link" onClick={() => setComposing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {notice.requestStatus === "PENDING" && <p className="restricted-status pending">⏳ Request sent. The owner will review it.</p>}
      {notice.requestStatus === "DENIED" && <p className="restricted-status denied">The owner declined this request.</p>}
      {notice.requestStatus === "APPROVED" && (
        <div className="restricted-actions">
          <span className="restricted-status approved">✓ Access granted!</span>
          {question && (
            <button type="button" className="btn-primary btn-sm" onClick={() => onSend(question)}>
              Ask again
            </button>
          )}
        </div>
      )}
      {(above || notice.requestStatus === "DENIED") && (
        <div className="quick-replies" aria-label="Suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => onSend(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
