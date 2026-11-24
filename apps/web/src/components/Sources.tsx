"use client";

import type { Source } from "@localmind/shared";
import { formatPages } from "@/lib/format";
import { ClassificationBadge } from "./AccessBadges";

export function Sources({ sources, highlighted, idPrefix }: { sources: Source[]; highlighted?: string | null; idPrefix: string }) {
  if (sources.length === 0) return null;
  return (
    <details className="sources" open>
      <summary>
        {sources.length} source{sources.length > 1 ? "s" : ""}
      </summary>
      <ol>
        {sources.map((s) => (
          <li key={s.ref} id={`${idPrefix}-${s.ref}`} className={highlighted === s.ref ? "highlight" : ""}>
            <div className="source-head">
              <span className="source-ref">{s.ref}</span>
              <span className="source-file">{s.fileName}</span>
              {s.classification && s.classification !== "INTERNAL" && <ClassificationBadge value={s.classification} />}
              {s.shared && <span className="muted small">shared</span>}
              {formatPages(s.pageStart, s.pageEnd) && <span className="muted">{formatPages(s.pageStart, s.pageEnd)}</span>}
              <span className="source-score" title="Cosine similarity">
                {(s.score * 100).toFixed(0)}%
              </span>
            </div>
            <p className="source-excerpt">{s.excerpt}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}
