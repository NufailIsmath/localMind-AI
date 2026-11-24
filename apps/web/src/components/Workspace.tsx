"use client";

import type { AuthResponse, ConversationSummaryDto, UserDto } from "@localmind/shared";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, tokenStore } from "@/lib/api";
import { AuthForm } from "./AuthForm";
import { ChatView } from "./ChatView";
import { DocumentsPanel } from "./DocumentsPanel";
import { HealthBadge } from "./HealthBadge";
import { Sidebar } from "./Sidebar";

type Panel = "chat" | "conversations" | "documents";

export function Workspace() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<UserDto | null>(null);
  const [ready, setReady] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummaryDto[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("chat");

  const logout = useCallback(() => {
    tokenStore.set(null);
    setToken(null);
    setUser(null);
    setConversations([]);
    setActiveId(null);
  }, []);

  // Restore the session.
  useEffect(() => {
    const saved = tokenStore.get();
    if (!saved) return setReady(true);
    api
      .me(saved)
      .then((u) => {
        setToken(saved);
        setUser(u);
      })
      .catch((e: ApiError) => {
        if (e.status === 401) tokenStore.set(null);
      })
      .finally(() => setReady(true));
  }, []);

  const refreshConversations = useCallback(() => {
    if (!token) return;
    api
      .conversations(token)
      .then(setConversations)
      .catch((e: ApiError) => e.status === 401 && logout());
  }, [token, logout]);

  useEffect(refreshConversations, [refreshConversations]);

  function onAuthenticated(auth: AuthResponse) {
    tokenStore.set(auth.token);
    setToken(auth.token);
    setUser(auth.user);
  }

  async function deleteConversation(id: string) {
    if (!token) return;
    try {
      await api.deleteConversation(token, id);
      if (id === activeId) setActiveId(null);
      refreshConversations();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) logout();
    }
  }

  if (!ready) return <div className="splash">LocalMind</div>;
  if (!token || !user) return <AuthForm onAuthenticated={onAuthenticated} />;

  return (
    <div className="app" data-panel={panel}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ◆
          </span>
          LocalMind
        </div>
        <HealthBadge />
        <nav className="mobile-tabs" aria-label="Panels">
          {(["conversations", "chat", "documents"] as const).map((p) => (
            <button key={p} type="button" className={panel === p ? "active" : ""} onClick={() => setPanel(p)}>
              {p === "conversations" ? "Chats" : p === "chat" ? "Chat" : "Docs"}
            </button>
          ))}
        </nav>
      </header>
      <Sidebar
        user={user}
        conversations={conversations}
        activeId={activeId}
        onSelect={(id) => {
          setActiveId(id);
          setPanel("chat");
        }}
        onNew={() => {
          setActiveId(null);
          setPanel("chat");
        }}
        onDelete={(id) => void deleteConversation(id)}
        onLogout={logout}
      />
      <ChatView
        token={token}
        conversationId={activeId}
        onConversationStarted={setActiveId}
        onTurnFinished={refreshConversations}
        onUnauthorized={logout}
      />
      <DocumentsPanel token={token} onUnauthorized={logout} />
    </div>
  );
}
