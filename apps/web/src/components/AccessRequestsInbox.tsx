"use client";

import type { AccessRequestDto } from "@localmind/shared";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { CLASSIFICATION_LABELS, relativeTime } from "@/lib/format";

/** Pending "can I see this?" requests for documents you own (admins: all). */
export function AccessRequestsInbox({ token, onDecided }: { token: string; onDecided: () => void }) {
  const [incoming, setIncoming] = useState<AccessRequestDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => api.accessRequests.list(token).then((r) => setIncoming(r.incoming)).catch(() => {}), [token]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function decide(r: AccessRequestDto, approve: boolean) {
    setBusy(r.id);
    setError(null);
    try {
      await api.accessRequests.decide(token, r.id, approve);
      setIncoming((all) => all.filter((x) => x.id !== r.id));
      onDecided();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  if (incoming.length === 0) return null;
  return (
    <section className="inbox" aria-label="Access requests">
      <h3>
        Access requests <span className="count">{incoming.length}</span>
      </h3>
      {error && <p className="error small">{error}</p>}
      <ul>
        {incoming.map((r) => (
          <li key={r.id} data-testid="access-request">
            <div className="small">
              <strong>{r.requesterEmail}</strong> wants to read <strong>{r.filename}</strong>
              <span className="muted"> · {CLASSIFICATION_LABELS[r.classification]} · {relativeTime(r.createdAt)}</span>
            </div>
            {r.note && <blockquote className="small">“{r.note}”</blockquote>}
            <div className="doc-actions">
              <button type="button" className="btn-primary btn-sm" disabled={busy === r.id} onClick={() => void decide(r, true)}>
                Approve
              </button>
              <button type="button" className="link danger" disabled={busy === r.id} onClick={() => void decide(r, false)}>
                Decline
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
