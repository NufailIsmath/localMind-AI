"use client";

import type { Classification, DocumentVisibility, GroupRefDto } from "@clbuddy/shared";
import { CLASSIFICATION_LABELS } from "@/lib/format";

export function ClassificationBadge({ value }: { value: Classification }) {
  return <span className={`badge cls cls-${value.toLowerCase()}`}>{CLASSIFICATION_LABELS[value]}</span>;
}

export function VisibilityLabel({ visibility, groups }: { visibility: DocumentVisibility; groups: GroupRefDto[] }) {
  const text =
    visibility === "PRIVATE" ? "Private" : visibility === "ORGANIZATION" ? "Organization" : groups.map((g) => g.name).join(", ");
  return (
    <span className="vis" title="Who this document is shared with">
      {visibility === "PRIVATE" ? "🔒" : "👥"} {text}
    </span>
  );
}
