"use client";

import type { DocumentDto } from "@localmind/shared";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { formatBytes, relativeTime } from "@/lib/format";

const ACCEPT = ".pdf,.docx,.txt,.md";

export function DocumentsPanel({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [docs, setDocs] = useState<DocumentDto[]>([]);
  const [uploading, setUploading] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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

  // Poll while anything is still being indexed.
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
        const doc = await api.upload(token, file);
        setDocs((d) => [doc, ...d.filter((x) => x.id !== doc.id)]);
      } catch (err) {
        handle(err instanceof ApiError ? new Error(`${file.name}: ${err.message}`) : err);
      } finally {
        setUploading((u) => u.filter((n) => n !== file.name));
      }
    }
  }

  async function remove(doc: DocumentDto) {
    if (!confirm(`Delete “${doc.filename}” and its search index?`)) return;
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

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
  }

  return (
    <aside className="documents" aria-label="Documents">
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
        {docs.map((d) => (
          <li key={d.id} className="doc">
            <div className="doc-main">
              <span className="doc-name" title={d.filename}>
                {d.filename}
              </span>
              <span className={`badge badge-${d.status.toLowerCase()}`}>{d.status.toLowerCase()}</span>
            </div>
            <div className="doc-meta muted">
              {formatBytes(d.sizeBytes)}
              {d.pageCount ? ` · ${d.pageCount} pages` : ""}
              {d.status === "READY" ? ` · ${d.chunkCount} chunk${d.chunkCount === 1 ? "" : "s"}` : ""} · {relativeTime(d.uploadedAt)}
            </div>
            {d.error && <div className="doc-error">{d.error}</div>}
            <div className="doc-actions">
              {(d.status === "READY" || d.status === "FAILED") && (
                <button type="button" className="link" onClick={() => void reindex(d)}>
                  Re-index
                </button>
              )}
              <button type="button" className="link danger" onClick={() => void remove(d)}>
                Delete
              </button>
            </div>
          </li>
        ))}
        {docs.length === 0 && uploading.length === 0 && <li className="muted small">No documents yet.</li>}
      </ul>
    </aside>
  );
}
