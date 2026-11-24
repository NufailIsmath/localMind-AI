/**
 * Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). Returns
 * rows as objects keyed by the lower-cased header. Bounded: at most `maxRows`.
 */
export function parseCsv(text: string, maxRows = 5000): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      if (rows.length > maxRows + 1) throw new Error(`Too many rows (max ${maxRows})`);
    } else field += c;
  }
  if (quoted) throw new Error("Unterminated quoted field");
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}
