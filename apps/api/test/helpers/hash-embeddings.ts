import type { EmbeddingService } from "../../src/ai/types.js";

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from has have how i in is it of on or our that the this to was what when where which who why will with you your my me".split(" "),
);

/** Crude stemmer so "employees"/"employee" and "days"/"day" share a bucket. */
function stem(word: string): string {
  return word.replace(/(ies|es|s|ing|ed)$/, "");
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic bag-of-words embedding: hashes word stems into a fixed number
 * of buckets and L2-normalises. Texts sharing vocabulary get high cosine
 * similarity, which is enough to test retrieval logic end-to-end without a
 * neural embedding model.
 */
export function hashEmbed(text: string, dimensions = 768): number[] {
  const v = new Array<number>(dimensions).fill(0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    const s = stem(w);
    if (s.length < 2) continue;
    v[fnv1a(s) % dimensions]! += 1;
  }
  const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  return v.map((x) => x / norm);
}

export class HashEmbeddingService implements EmbeddingService {
  readonly model = "hash-embed";
  calls = 0;
  constructor(readonly dimensions = 768) {}
  async embedDocuments(texts: string[]) {
    this.calls++;
    return texts.map((t) => hashEmbed(t, this.dimensions));
  }
  async embedQuery(text: string) {
    this.calls++;
    return hashEmbed(text, this.dimensions);
  }
}
