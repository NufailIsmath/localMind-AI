"use client";

import type { ConversationSummaryDto, UserDto } from "@clbuddy/shared";
import { CLASSIFICATION_LABELS, relativeTime } from "@/lib/format";
import { MyLeave } from "./MyLeave";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export function Sidebar({
  user,
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onLogout,
  onOpenAdmin,
  onOpenLeave,
  token,
  onAsk,
}: {
  user: UserDto;
  conversations: ConversationSummaryDto[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onLogout: () => void;
  onOpenAdmin: () => void;
  onOpenLeave: () => void;
  token: string;
  onAsk: (q: string) => void;
}) {
  // HR: how many leave requests are waiting (refreshed every 30s).
  const [pendingLeave, setPendingLeave] = useState(0);
  useEffect(() => {
    if (!user.canManageLeave) return;
    const load = () => api.leave.requests(token, "PENDING").then((r) => setPendingLeave(r.length)).catch(() => {});
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [user.canManageLeave, token]);
  return (
    <nav className="sidebar" aria-label="Conversations">
      <button type="button" className="btn-primary new-chat" onClick={onNew}>
        + New chat
      </button>
      <ul className="conv-list">
        {conversations.map((c) => (
          <li key={c.id} className={c.id === activeId ? "active" : ""}>
            <button type="button" className="conv" onClick={() => onSelect(c.id)}>
              <span className="conv-title">{c.title}</span>
              <span className="muted small">{relativeTime(c.updatedAt)}</span>
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Delete conversation ${c.title}`}
              onClick={() => confirm("Delete this conversation?") && onDelete(c.id)}
            >
              ×
            </button>
          </li>
        ))}
        {conversations.length === 0 && <li className="muted small pad">No conversations yet.</li>}
      </ul>
      <MyLeave token={token} onAsk={onAsk} />
      <div className="account">
        <div className="small">
          <div className="ellipsis" title={user.email}>
            {user.email}
          </div>
          <div className="muted">
            {user.role === "ADMIN" ? "Administrator" : "Member"} · {CLASSIFICATION_LABELS[user.clearance]} clearance
          </div>
          {user.groups.length > 0 && <div className="muted ellipsis">{user.groups.map((g) => g.name).join(", ")}</div>}
        </div>
        <div className="account-actions">
          {user.canManageLeave && (
            <button type="button" className="link" onClick={onOpenLeave}>
              Manage leave{pendingLeave > 0 && <span className="count-badge" aria-label={`${pendingLeave} pending`}>{pendingLeave}</span>}
            </button>
          )}
          {user.role === "ADMIN" && (
            <button type="button" className="link" onClick={onOpenAdmin}>
              Organization
            </button>
          )}
          <button type="button" className="link" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </div>
    </nav>
  );
}
