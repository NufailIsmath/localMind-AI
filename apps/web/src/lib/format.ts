export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatPages(start: number | null, end: number | null): string | null {
  if (start === null) return null;
  return start === end || end === null ? `p. ${start}` : `pp. ${start}–${end}`;
}

export function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export const TOOL_LABELS: Record<string, string> = {
  search_knowledge: "Searched documents",
  calculate: "Calculated",
  get_current_time: "Checked the time",
  list_documents: "Listed documents",
  get_usage_stats: "Read usage stats",
  get_system_stats: "Read system stats",
};
