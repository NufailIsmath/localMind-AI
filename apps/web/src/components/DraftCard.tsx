"use client";

import { useState } from "react";

export interface EmailDraft {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}

const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/;
const addresses = (v: string) => v.split(/[,;]/).map((s) => s.trim()).filter((s) => EMAIL.test(s));

/** Parses the ```email block format the assistant is prompted to use. */
export function parseEmailDraft(text: string): EmailDraft {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const head: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const m = lines[i]!.match(/^(To|Cc|Bcc|Subject)\s*:\s*(.*)$/i);
    if (!m) break;
    head[m[1]!.toLowerCase()] = m[2]!.trim();
  }
  while (i < lines.length && !lines[i]!.trim()) i++;
  return { to: addresses(head.to ?? ""), cc: addresses(head.cc ?? ""), subject: head.subject ?? "", body: lines.slice(i).join("\n").trim() };
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable (insecure context) */
        }
      }}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

export { CopyButton };

/**
 * An email/message draft with one-click copy and "open in email app".
 * The mailto: link only opens the user's own mail client with the draft
 * pre-filled; nothing is sent until they review it and press Send. Recipients
 * are shown in full so an injected address can't hide.
 */
export function DraftCard({ kind, text }: { kind: "email" | "message"; text: string }) {
  if (kind === "message") {
    return (
      <div className="draft" data-testid="message-draft">
        <div className="draft-head">💬 Message draft</div>
        <div className="draft-body">{text.trim()}</div>
        <div className="draft-actions">
          <CopyButton text={text.trim()} />
        </div>
      </div>
    );
  }
  const d = parseEmailDraft(text);
  const full = `${d.subject ? `Subject: ${d.subject}\n\n` : ""}${d.body}`;
  const params = [
    d.cc.length ? `cc=${encodeURIComponent(d.cc.join(","))}` : "",
    d.subject ? `subject=${encodeURIComponent(d.subject)}` : "",
    `body=${encodeURIComponent(d.body)}`,
  ].filter(Boolean);
  // Addresses are validated plain emails, so they can go in unencoded (some mail apps reject %40).
  const mailto = `mailto:${d.to.join(",")}?${params.join("&")}`;
  return (
    <div className="draft" data-testid="email-draft">
      <div className="draft-head">✉️ Email draft</div>
      <dl className="draft-fields">
        <dt>To</dt>
        <dd>{d.to.length ? d.to.join(", ") : <span className="muted">add a recipient</span>}</dd>
        {d.cc.length > 0 && (
          <>
            <dt>Cc</dt>
            <dd>{d.cc.join(", ")}</dd>
          </>
        )}
        <dt>Subject</dt>
        <dd>{d.subject || <span className="muted">no subject</span>}</dd>
      </dl>
      <div className="draft-body">{d.body}</div>
      <div className="draft-actions">
        <CopyButton text={full} />
        <a className="btn-primary btn-sm" href={mailto.length < 1900 ? mailto : `mailto:${d.to.join(",")}`} title="Opens your email app with this draft — nothing is sent until you press Send there">
          Open in email app
        </a>
      </div>
    </div>
  );
}
