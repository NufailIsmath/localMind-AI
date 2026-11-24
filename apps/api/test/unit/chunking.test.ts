import { describe, expect, it } from "vitest";
import { CHARS_PER_TOKEN, chunkDocument, estimateTokens, normalizeText } from "../../src/rag/chunking.service.js";

const sentence = (i: number) => `Sentence number ${i} talks about topic ${i} in some detail.`;
const paragraph = (from: number, n: number) => Array.from({ length: n }, (_, i) => sentence(from + i)).join(" ");

describe("normalizeText", () => {
  it("normalises whitespace, newlines and control characters", () => {
    expect(normalizeText("a\r\nb\t\t c\u0000d\n\n\n\ne  ")).toBe("a\nb cd\n\ne");
  });
  it("rejoins words hyphenated across a line break", () => {
    expect(normalizeText("employ-\nees are entitled")).toBe("employees are entitled");
  });
  it("keeps hyphens between capitalised words", () => {
    expect(normalizeText("Jean-\nPaul")).toBe("Jean-\nPaul");
  });
});

describe("chunkDocument", () => {
  const opts = { chunkSizeTokens: 50, overlapTokens: 10 };
  const maxChars = opts.chunkSizeTokens * CHARS_PER_TOKEN;

  it("returns nothing for empty input", () => {
    expect(chunkDocument([{ pageNumber: 1, text: "   \n " }], opts)).toEqual([]);
  });

  it("keeps short documents in a single chunk", () => {
    const chunks = chunkDocument([{ pageNumber: null, text: "Hello world. This is short." }], opts);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 0, content: "Hello world. This is short.", pageStart: null, pageEnd: null });
  });

  it("never exceeds the chunk size and covers every sentence", () => {
    const text = paragraph(0, 60);
    const chunks = chunkDocument([{ pageNumber: null, text }], opts);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(maxChars);
    for (let i = 0; i < 60; i++) {
      expect(chunks.some((c) => c.content.includes(sentence(i)))).toBe(true);
    }
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("overlaps consecutive chunks", () => {
    const chunks = chunkDocument([{ pageNumber: null, text: paragraph(0, 40) }], opts);
    for (let i = 1; i < chunks.length; i++) {
      const prevSentences = chunks[i - 1]!.content.split(/(?<=\.) /);
      const lastOfPrev = prevSentences[prevSentences.length - 1]!;
      expect(chunks[i]!.content.startsWith(lastOfPrev)).toBe(true);
    }
  });

  it("produces no overlap when overlap is zero", () => {
    const chunks = chunkDocument([{ pageNumber: null, text: paragraph(0, 30) }], { chunkSizeTokens: 50, overlapTokens: 0 });
    const joined = chunks.map((c) => c.content).join(" ");
    expect(joined).toBe(paragraph(0, 30));
  });

  it("splits a single huge 'sentence' at word boundaries and hard-cuts unbroken text", () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const wordChunks = chunkDocument([{ pageNumber: null, text: words }], opts);
    for (const c of wordChunks) {
      expect(c.content.length).toBeLessThanOrEqual(maxChars);
      expect(c.content).toMatch(/^word\d+/);
    }
    const blob = "x".repeat(maxChars * 3 + 7);
    const blobChunks = chunkDocument([{ pageNumber: null, text: blob }], { chunkSizeTokens: 50, overlapTokens: 0 });
    expect(blobChunks.map((c) => c.content).join("")).toBe(blob);
  });

  it("tracks the page range of each chunk", () => {
    const pages = [1, 2, 3].map((p) => ({ pageNumber: p, text: paragraph(p * 100, 6) }));
    const chunks = chunkDocument(pages, { chunkSizeTokens: 120, overlapTokens: 0 });
    expect(chunks[0]!.pageStart).toBe(1);
    expect(chunks[chunks.length - 1]!.pageEnd).toBe(3);
    for (const c of chunks) {
      // A chunk mentioning sentence 2xx must include page 2 in its range.
      if (c.content.includes("number 2")) {
        expect(c.pageStart! <= 2 && c.pageEnd! >= 2).toBe(true);
      }
      expect(c.pageStart!).toBeLessThanOrEqual(c.pageEnd!);
    }
    expect(chunks.some((c) => c.pageStart !== c.pageEnd)).toBe(true);
  });

  it("skips empty pages when attributing page numbers", () => {
    const chunks = chunkDocument(
      [
        { pageNumber: 1, text: "" },
        { pageNumber: 2, text: "Only page two has text." },
      ],
      opts,
    );
    expect(chunks).toEqual([expect.objectContaining({ pageStart: 2, pageEnd: 2 })]);
  });

  it("chunks large text without spaces in linear time (CJK, base64)", () => {
    const cjk = "這是一個沒有空格的很長的句子".repeat(150_000); // ~2M chars, no whitespace
    const t0 = performance.now();
    const chunks = chunkDocument([{ pageNumber: null, text: cjk }], { chunkSizeTokens: 600, overlapTokens: 0 });
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(chunks.map((c) => c.content).join("")).toBe(cjk);
  });

  it("rejects overlap >= chunk size", () => {
    expect(() => chunkDocument([{ pageNumber: null, text: "x" }], { chunkSizeTokens: 10, overlapTokens: 10 })).toThrow();
  });

  it("estimates tokens at ~4 chars per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});
