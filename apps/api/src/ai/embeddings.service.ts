import { UpstreamError } from "../lib/errors.js";
import type { OllamaClient } from "./ollama.client.js";
import type { EmbeddingService } from "./types.js";

export interface OllamaEmbeddingOptions {
  model: string;
  dimensions: number;
  batchSize?: number;
}

/**
 * nomic-embed-text was trained with task prefixes; using them measurably
 * improves retrieval. Other models get the raw text.
 */
export function taskPrefixes(model: string): { document: string; query: string } {
  if (/nomic-embed/i.test(model)) return { document: "search_document: ", query: "search_query: " };
  return { document: "", query: "" };
}

export class OllamaEmbeddingService implements EmbeddingService {
  readonly model: string;
  readonly dimensions: number;
  private readonly batchSize: number;
  private readonly prefixes: { document: string; query: string };

  constructor(
    private readonly client: OllamaClient,
    opts: OllamaEmbeddingOptions,
  ) {
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    this.batchSize = opts.batchSize ?? 16;
    this.prefixes = taskPrefixes(opts.model);
  }

  async embedDocuments(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize).map((t) => this.prefixes.document + t);
      out.push(...this.check(await this.client.embed(this.model, batch, { signal })));
    }
    return out;
  }

  async embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
    const [vector] = this.check(await this.client.embed(this.model, [this.prefixes.query + text], { signal }));
    return vector as number[];
  }

  private check(vectors: number[][]): number[][] {
    for (const v of vectors) {
      if (v.length !== this.dimensions) {
        throw new UpstreamError(
          "ollama",
          `embedding model "${this.model}" returned ${v.length} dimensions but EMBEDDING_DIMENSIONS is ${this.dimensions}. ` +
            "Update the config and re-index your documents.",
        );
      }
    }
    return vectors;
  }
}
