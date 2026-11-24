"use client";

import { CLASSIFICATIONS, type DocumentAccessRequest, type DocumentVisibility, type GroupRefDto } from "@localmind/shared";
import { CLASSIFICATION_LABELS, VISIBILITY_LABELS } from "@/lib/format";

/** Visibility / classification / groups controls, used for uploads and for editing access. */
export function SharingFields({
  value,
  onChange,
  groups,
}: {
  value: Required<DocumentAccessRequest>;
  onChange: (v: Required<DocumentAccessRequest>) => void;
  groups: GroupRefDto[];
}) {
  const toggleGroup = (id: string) =>
    onChange({ ...value, groupIds: value.groupIds.includes(id) ? value.groupIds.filter((g) => g !== id) : [...value.groupIds, id] });

  return (
    <div className="sharing">
      <label>
        Share with
        <select value={value.visibility} onChange={(e) => onChange({ ...value, visibility: e.target.value as DocumentVisibility })}>
          {(Object.keys(VISIBILITY_LABELS) as DocumentVisibility[]).map((v) => (
            <option key={v} value={v} disabled={v === "GROUPS" && groups.length === 0}>
              {VISIBILITY_LABELS[v]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Classification
        <select value={value.classification} onChange={(e) => onChange({ ...value, classification: e.target.value as typeof value.classification })}>
          {CLASSIFICATIONS.map((c) => (
            <option key={c} value={c}>
              {CLASSIFICATION_LABELS[c]}
            </option>
          ))}
        </select>
      </label>
      {value.visibility === "GROUPS" && (
        <fieldset className="group-picker">
          <legend>Groups</legend>
          {groups.map((g) => (
            <label key={g.id} className="check">
              <input type="checkbox" checked={value.groupIds.includes(g.id)} onChange={() => toggleGroup(g.id)} />
              {g.name}
            </label>
          ))}
        </fieldset>
      )}
      {value.visibility !== "PRIVATE" && (
        <p className="hint">Only people whose clearance is {CLASSIFICATION_LABELS[value.classification]} or higher will see it.</p>
      )}
    </div>
  );
}
