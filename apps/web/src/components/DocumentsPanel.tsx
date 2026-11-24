"use client";

import type { DocumentAccessRequest, DocumentDto, GroupRefDto, UserDto } from "@localmind/shared";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { CLASSIFICATION_LABELS, formatBytes, relativeTime } from "@/lib/format";
import { ClassificationBadge, VisibilityLabel } from "./AccessBadges";
import { AccessRequestsInbox } from "./AccessRequestsInbox";
import { SharingFields } from "./SharingFields";

const ACCEPT = ".pdf,.docx,.txt,.md";
const DEFAULT_SHARING: Required<DocumentAccessRequest> = { visibility: "PRIVATE", classification: "INTERNAL", groupIds: [] };

function AccessEditor({
  doc,
  groups,
  onSave,
  onCancel,
  onRevoke,
}: {
  doc: DocumentDto;
  groups: GroupRefDto[];
  onSave: (v: Required<DocumentAccessRequest>) => Promise<void>;
  onCancel: () => void;
  onRevoke: (userId: string) => Promise<void>;
}) {
  const [value, setValue] = useState<Required<DocumentAccessRequest>>({
    visibility: doc.visibility,
    classification: doc.classification,
    groupIds: doc.groups.map((g) => g.id),
  });
  const [busy, setBusy] = useState(false);
  // Keep groups the document is already shared with selectable even if the editor isn't a member.
  const options = [...groups, ...doc.groups.filter((g) => !groups.some((x) => x.id === g.id))];
  return (
    <div className="access-editor">
      <SharingFields value={value} onChange={setValue} groups={options} />
      {doc.grants.length > 0 && (
        <div className="grants">
          <div className="small muted">Also shared with (approved requests):</div>
          <ul>
            {doc.grants.map((g) => (
              <li key={g.id} className="small">
                {g.email}{" "}
                <button type="button" className="link danger" onClick={() => void onRevoke(g.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="doc-actions">
        <button
          type="button"
          className="btn-primary btn-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onSave(value).finally(() => setBusy(false));
          }}
        >
          Save access
        </button>
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function DocumentsPanel({ token, user, onUnauthorized }: { token: string; user: UserDto; onUnauthorized: () => void }) {
  const [docs, setDocs] = useState<DocumentDto[]>([]);
  const [uploading, setUploading] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sharing, setSharing] = useState(DEFAULT_SHARING);
  const [showSharing, setShowSharing] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [shareableGroups, setShareableGroups] = useState<GroupRefDto[]>(user.groups);
  const inputRef = useRef<HTMLInputElement>(null);
  const isAdmin = user.role === "ADMIN";

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onUnauthorized();
      else setError(err instanceof Error ? err.message : "Request failed");
    },
    [onUnauthorized],
  );

  const refresh = useCallback(() => api.documents(token).then(setDocs).catch(handle), [token, handle]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Members share with their own groups; admins can share with any group.
  useEffect(() => {
    if (!isAdmin) return setShareableGroups(user.groups);
    api.admin.groups(token).then((g) => setShareableGroups(g.map(({ id, name }) => ({ id, name })))).catch(() => {});
  }, [isAdmin, token, user.groups]);

  const indexing = docs.some((d) => d.status === "PENDING" || d.status === "PROCESSING");
  useEffect(() => {
    if (!indexing) return;
    const t = setInterval(() => void refresh(), 1500);
    return () => clearInterval(t);
  }, [indexing, refresh]);

  async function upload(files: FileList | File[]) {
    setError(null);
    for (const file of Array.from(files)) {
      setUploading((u) => [...u, file.name]);
      try {
        const doc = await api.upload(token, file, sharing);
        setDocs((d) => [doc, ...d.filter((x) => x.id !== doc.id)]);
      } catch (err) {
        handle(err instanceof ApiError ? new Error(`${file.name}: ${err.message}`) : err);
      } finally {
        setUploading((u) => u.filter((n) => n !== file.name));
      }
    }
  }

  async function remove(doc: DocumentDto) {
    if (!confirm(`Delete “${doc.filename}” and its search index${doc.owned ? "" : ` (owned by ${doc.ownerEmail})`}?`)) return;
    try {
      await api.deleteDocument(token, doc.id);
      setDocs((d) => d.filter((x) => x.id !== doc.id));
    } catch (err) {
      handle(err);
    }
  }

  async function reindex(doc: DocumentDto) {
    try {
      const updated = await api.reindexDocument(token, doc.id);
      setDocs((d) => d.map((x) => (x.id === doc.id ? updated : x)));
    } catch (err) {
      handle(err);
    }
  }

  async function saveAccess(doc: DocumentDto, value: Required<DocumentAccessRequest>) {
    try {
      setError(null);
      const updated = await api.updateDocumentAccess(token, doc.id, value);
      setDocs((d) => d.map((x) => (x.id === doc.id ? updated : x)));
      setEditing(null);
    } catch (err) {
      handle(err);
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
  }

  return (
    <aside className="documents" aria-label="Documents">
      <AccessRequestsInbox token={token} onDecided={() => void refresh()} />
      <h2>Knowledge base</h2>
      <div
        className={`dropzone ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
      >
        <strong>Drop files or click to upload</strong>
        <span className="muted">PDF, DOCX, TXT, Markdown</span>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          data-testid="file-input"
          onChange={(e) => {
            if (e.target.files) void upload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      <button type="button" className="link sharing-toggle" onClick={() => setShowSharing((s) => !s)} aria-expanded={showSharing}>
        Upload as: <VisibilityLabel visibility={sharing.visibility} groups={shareableGroups.filter((g) => sharing.groupIds.includes(g.id))} /> ·{" "}
        <ClassificationBadge value={sharing.classification} /> {showSharing ? "▴" : "▾"}
      </button>
      {showSharing && <SharingFields value={sharing} onChange={setSharing} groups={shareableGroups} />}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="doc-list">
        {uploading.map((name) => (
          <li key={`up-${name}`} className="doc">
            <div className="doc-main">
              <span className="doc-name">{name}</span>
              <span className="badge badge-processing">uploading</span>
            </div>
          </li>
        ))}
        {docs.map((d) => {
          const canManage = d.owned || isAdmin;
          return (
            <li key={d.id} className="doc" data-testid={`doc-${d.filename}`}>
              <div className="doc-main">
                <span className="doc-name" title={d.filename}>
                  {d.filename}
                </span>
                <span className={`badge badge-${d.status.toLowerCase()}`}>{d.status.toLowerCase()}</span>
              </div>
              <div className="doc-access">
                <ClassificationBadge value={d.classification} />
                <VisibilityLabel visibility={d.visibility} groups={d.groups} />
                {!d.owned && <span className="muted">from {d.ownerEmail}</span>}
              </div>
              <div className="doc-meta muted">
                {formatBytes(d.sizeBytes)}
                {d.pageCount ? ` · ${d.pageCount} pages` : ""}
                {d.status === "READY" ? ` · ${d.chunkCount} chunk${d.chunkCount === 1 ? "" : "s"}` : ""} · {relativeTime(d.uploadedAt)}
              </div>
              {d.error && <div className="doc-error">{d.error}</div>}
              {d.suggestion && (
                <div className="suggestion" role="status" data-testid="classification-suggestion">
                  <div>
                    💡 This looks <strong>{CLASSIFICATION_LABELS[d.suggestion.classification]}</strong>
                    {d.suggestion.reasons.length > 0 && <span>: {d.suggestion.reasons.join("; ").toLowerCase()}</span>}
                  </div>
                  <div className="doc-actions">
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      onClick={() => void saveAccess(d, { visibility: d.visibility, classification: d.suggestion!.classification, groupIds: d.groups.map((g) => g.id) })}
                    >
                      Mark {CLASSIFICATION_LABELS[d.suggestion.classification]}
                    </button>
                    <button
                      type="button"
                      className="link"
                      onClick={async () => {
                        try {
                          const updated = await api.dismissSuggestion(token, d.id);
                          setDocs((all) => all.map((x) => (x.id === d.id ? updated : x)));
                        } catch (err) {
                          handle(err);
                        }
                      }}
                    >
                      Keep {CLASSIFICATION_LABELS[d.classification]}
                    </button>
                  </div>
                </div>
              )}
              {editing === d.id ? (
                <AccessEditor
                  doc={d}
                  groups={shareableGroups}
                  onSave={(v) => saveAccess(d, v)}
                  onCancel={() => setEditing(null)}
                  onRevoke={async (userId) => {
                    try {
                      await api.revokeGrant(token, d.id, userId);
                      setDocs((all) => all.map((x) => (x.id === d.id ? { ...x, grants: x.grants.filter((g) => g.id !== userId) } : x)));
                    } catch (err) {
                      handle(err);
                    }
                  }}
                />
              ) : (
                canManage && (
                  <div className="doc-actions">
                    <button type="button" className="link" onClick={() => setEditing(d.id)}>
                      Access
                    </button>
                    {(d.status === "READY" || d.status === "FAILED") && (
                      <button type="button" className="link" onClick={() => void reindex(d)}>
                        Re-index
                      </button>
                    )}
                    <button type="button" className="link danger" onClick={() => void remove(d)}>
                      Delete
                    </button>
                  </div>
                )
              )}
            </li>
          );
        })}
        {docs.length === 0 && uploading.length === 0 && <li className="muted small">No documents yet.</li>}
      </ul>
    </aside>
  );
}
