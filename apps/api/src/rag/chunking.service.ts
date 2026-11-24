/**
 * Splits extracted document text into overlapping chunks for embedding.
 *
 * Strategy: text is cut into sentence/paragraph "segments", which are packed
 * greedily into chunks of at most `chunkSizeTokens`. Consecutive chunks share
 * roughly `overlapTokens` of trailing segments (at least one sentence) so that facts spanning a chunk
 * boundary remain retrievable. Segments longer than a whole chunk are split
 * at word boundaries. Page boundaries are tracked so every chunk can be cited
 * with the page range it came from.
 */

export interface PageText {
  /** 1-based page number, or null for formats without pages (TXT, DOCX). */
  pageNumber: number | null;
  text: string;
}

export interface Chunk {
  index: number;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  tokenCount: number;
}

export interface ChunkingOptions {
  chunkSizeTokens: number;
  overlapTokens: number;
}

/**
 * Cheap token estimate (~4 characters per token for English with BPE
 * tokenizers). Good enough for sizing chunks; we never need exact counts.
 */
export const CHARS_PER_TOKEN = 4;
export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

export function normalizeText(raw: string): string {
  return (
    raw
      .replace(/\r\n?/g, "\n")
      // Strip control characters except tab and newline.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      // Re-join words hyphenated across line breaks (common in PDFs).
      .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2")
      .replace(/[ \t ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

interface Span {
  start: number;
  end: number;
}

/** Sentence / line boundaries as [start, end) spans covering the whole text. */
function segment(text: string, maxChars: number): Span[] {
  const spans: Span[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    const isSentenceEnd = (ch === "." || ch === "!" || ch === "?") && (next === undefined || next === " " || next === "\n");
    const isLineEnd = ch === "\n";
    if (isSentenceEnd || isLineEnd) {
      let end = i + 1;
      while (end < text.length && (text[end] === " " || text[end] === "\n")) end++;
      spans.push({ start, end });
      start = end;
      i = end - 1;
    }
  }
  if (start < text.length) spans.push({ start, end: text.length });

  // Break up segments that are too long to fit in a single chunk.
  const out: Span[] = [];
  for (const span of spans) {
    let s = span.start;
    while (span.end - s > maxChars) {
      let cut = text.lastIndexOf(" ", s + maxChars);
      if (cut <= s) cut = s + maxChars; // no whitespace: hard cut
      else cut += 1;
      out.push({ start: s, end: cut });
      s = cut;
    }
    if (span.end > s) out.push({ start: s, end: span.end });
  }
  return out;
}

export function chunkDocument(pages: PageText[], opts: ChunkingOptions): Chunk[] {
  if (opts.overlapTokens >= opts.chunkSizeTokens) {
    throw new Error("overlapTokens must be smaller than chunkSizeTokens");
  }
  const maxChars = opts.chunkSizeTokens * CHARS_PER_TOKEN;
  const overlapChars = opts.overlapTokens * CHARS_PER_TOKEN;

  // Concatenate pages, remembering where each one starts.
  const pageStarts: { offset: number; pageNumber: number | null }[] = [];
  let text = "";
  for (const page of pages) {
    const normalized = normalizeText(page.text);
    if (!normalized) continue;
    if (text) text += "\n\n";
    pageStarts.push({ offset: text.length, pageNumber: page.pageNumber });
    text += normalized;
  }
  if (!text) return [];

  const pageAt = (offset: number): number | null => {
    let lo = 0;
    let hi = pageStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((pageStarts[mid] as { offset: number }).offset <= offset) lo = mid;
      else hi = mid - 1;
    }
    return pageStarts[lo]?.pageNumber ?? null;
  };

  const spans = segment(text, maxChars);
  const chunks: Chunk[] = [];
  let i = 0;
  while (i < spans.length) {
    const first = spans[i] as Span;
    let j = i;
    while (j + 1 < spans.length && (spans[j + 1] as Span).end - first.start <= maxChars) j++;

    const raw = text.slice(first.start, (spans[j] as Span).end);
    const content = raw.trim();
    if (content) {
      const leading = raw.length - raw.trimStart().length;
      const startOffset = first.start + leading;
      const endOffset = startOffset + content.length - 1;
      chunks.push({
        index: chunks.length,
        content,
        pageStart: pageAt(startOffset),
        pageEnd: pageAt(endOffset),
        tokenCount: estimateTokens(content),
      });
    }
    if (j === spans.length - 1) break;

    // Step back over trailing segments that fit inside the overlap window,
    // always making forward progress.
    const chunkEnd = (spans[j] as Span).end;
    let nextStart = j + 1;
    while (nextStart - 1 > i && chunkEnd - (spans[nextStart - 1] as Span).start <= overlapChars) nextStart--;
    // If even the last sentence is longer than the overlap window, still carry
    // it over (when it is small relative to the chunk) so boundaries never lose context.
    const last = spans[j] as Span;
    if (overlapChars > 0 && nextStart === j + 1 && j > i && last.end - last.start <= maxChars / 2) nextStart = j;
    i = nextStart;
  }
  return chunks;
}
