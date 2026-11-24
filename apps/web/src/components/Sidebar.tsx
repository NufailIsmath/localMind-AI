"use client";

import type { ConversationSummaryDto, UserDto } from "@localmind/shared";
import { relativeTime } from "@/lib/format";

export function Sidebar({
  user,
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onLogout,
}: {
  user: UserDto;
  conversations: ConversationSummaryDto[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onLogout: () => void;
}) {
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
      <div className="account">
        <div className="small">
          <div className="ellipsis" title={user.email}>
            {user.email}
          </div>
          <div className="muted">{user.role === "ADMIN" ? "Administrator" : "Member"}</div>
        </div>
        <button type="button" className="link" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </nav>
  );
}
