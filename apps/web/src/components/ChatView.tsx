"use client";

import type { ChatStreamEvent, MessageDto, Source, ToolExecutionSummary } from "@localmind/shared";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, ApiError, streamChat } from "@/lib/api";
import { Markdown } from "./Markdown";
import { Sources } from "./Sources";
import { ToolActivity, type PendingTool } from "./ToolActivity";

const EXAMPLES = [
  "What does my handbook say about annual leave?",
  "What is 1,250 multiplied by 12?",
  "Which documents have I uploaded?",
  "What's the date today?",
];

interface Draft {
  content: string;
  executions: ToolExecutionSummary[];
  pending: PendingTool[];
}

function AssistantMessage({ message }: { message: Pick<MessageDto, "id" | "content" | "sources" | "toolExecutions"> }) {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const cite = (ref: string) => {
    setHighlighted(ref);
    document.getElementById(`${message.id}-${ref}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  return (
    <article className="msg msg-assistant">
      <ToolActivity executions={message.toolExecutions} />
      <Markdown text={message.content} onCite={cite} />
      <Sources sources={message.sources} highlighted={highlighted} idPrefix={message.id} />
    </article>
  );
}

export function ChatView({
  token,
  conversationId,
  onConversationStarted,
  onTurnFinished,
  onUnauthorized,
}: {
  token: string;
  conversationId: string | null;
  onConversationStarted: (id: string) => void;
  onTurnFinished: () => void;
  onUnauthorized: () => void;
}) {
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const userStopped = useRef(false);
  const streamingConversation = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const busy = draft !== null;

  // Load history when switching conversations (but not for the one we're streaming into).
  useEffect(() => {
    // Navigating away mid-stream: stop it, otherwise its answer would land in this view.
    if (abortRef.current && conversationId !== streamingConversation.current) abortRef.current.abort();
    setError(null);
    if (!conversationId) {
      setMessages([]);
      return;
    }
    if (conversationId === streamingConversation.current) return;
    let cancelled = false;
    setLoading(true);
    api
      .conversation(token, conversationId)
      .then((c) => !cancelled && setMessages(c.messages))
      .catch((e: ApiError) => {
        if (e.status === 401) onUnauthorized();
        else if (!cancelled) setError(e.message);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [conversationId, token, onUnauthorized]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, draft]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || busy) return;
      setError(null);
      setInput("");
      const userMsg: MessageDto = {
        id: `local-${Date.now()}`,
        role: "USER",
        content: message,
        sources: [],
        toolExecutions: [],
        createdAt: new Date().toISOString(),
      };
      setMessages((m) => [...m, userMsg]);
      setDraft({ content: "", executions: [], pending: [] });

      const controller = new AbortController();
      abortRef.current = controller;
      userStopped.current = false;
      let finished = false;

      const onEvent = (e: ChatStreamEvent) => {
        switch (e.type) {
          case "conversation":
            streamingConversation.current = e.conversationId;
            if (e.conversationId !== conversationId) onConversationStarted(e.conversationId);
            break;
          case "token":
            setDraft((d) => d && { ...d, content: d.content + e.content });
            break;
          case "reset":
            setDraft((d) => d && { ...d, content: "" });
            break;
          case "tool_start":
            setDraft((d) => d && { ...d, pending: [...d.pending, { id: e.id, tool: e.tool, arguments: e.arguments }] });
            break;
          case "tool_end":
            setDraft(
              (d) =>
                d && {
                  ...d,
                  pending: d.pending.filter((p) => p.id !== e.execution.id),
                  executions: [...d.executions, e.execution],
                },
            );
            break;
          case "done": {
            finished = true;
            const r = e.response;
            setMessages((m) => [
              ...m,
              {
                id: r.messageId,
                role: "ASSISTANT",
                content: r.answer,
                sources: r.sources as Source[],
                toolExecutions: r.toolExecutions,
                createdAt: new Date().toISOString(),
              },
            ]);
            setDraft(null);
            break;
          }
          case "error":
            finished = true;
            setError(e.message);
            setDraft(null);
            break;
        }
      };

      try {
        await streamChat(token, { message, conversationId: conversationId ?? undefined }, onEvent, controller.signal);
        if (!finished && userStopped.current) setError("Generation stopped.");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return onUnauthorized();
        setError(err instanceof Error ? err.message : "Request failed");
      } finally {
        setDraft(null);
        abortRef.current = null;
        streamingConversation.current = null;
        onTurnFinished();
      }
    },
    [busy, conversationId, onConversationStarted, onTurnFinished, onUnauthorized, token],
  );

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  }

  return (
    <section className="chat">
      <div className="messages" aria-live="polite">
        {loading && <p className="muted center">Loading conversation…</p>}
        {!loading && messages.length === 0 && !draft && (
          <div className="empty">
            <h2>How can I help?</h2>
            <p className="muted">Ask about your uploaded documents, or try one of these:</p>
            <div className="examples">
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" onClick={() => void send(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.role === "USER" ? (
            <article key={m.id} className="msg msg-user">
              <p>{m.content}</p>
            </article>
          ) : (
            <AssistantMessage key={m.id} message={m} />
          ),
        )}
        {draft && (
          <article className="msg msg-assistant msg-draft">
            <ToolActivity executions={draft.executions} pending={draft.pending} />
            {draft.content ? (
              <Markdown text={draft.content} />
            ) : (
              draft.pending.length === 0 && (
                <p className="typing" aria-label="Thinking">
                  <span />
                  <span />
                  <span />
                </p>
              )
            )}
          </article>
        )}
        {error && (
          <p className="error banner" role="alert">
            {error}
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <textarea
          aria-label="Message"
          placeholder="Ask LocalMind…  (Enter to send, Shift+Enter for a new line)"
          value={input}
          rows={1}
          maxLength={8000}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {busy ? (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              userStopped.current = true;
              abortRef.current?.abort();
            }}
          >
            Stop
          </button>
        ) : (
          <button type="submit" className="btn-primary" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
    </section>
  );
}
