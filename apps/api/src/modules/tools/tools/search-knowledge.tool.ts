import { z } from "zod";
import type { RetrievalService } from "../../../rag/retrieval.service.js";
import { defineTool } from "../tool.types.js";

export const searchKnowledgeTool = (retrieval: RetrievalService, maxLimit = 10) =>
  defineTool({
    name: "search_knowledge",
    description:
      "Semantic search over the documents the user has uploaded (PDF, DOCX, TXT). Returns the most relevant " +
      "passages with source references (S1, S2, …) to cite. Use it whenever the question could be answered by the " +
      "user's documents. Rephrase the question as a concise search query.",
    schema: z.object({
      query: z.string().trim().min(1).max(500).describe("What to search for"),
      limit: z.number().int().min(1).max(maxLimit).optional().describe("Maximum passages to return (default 5)"),
    }),
    async execute({ query, limit }, ctx) {
      // Ownership comes from the trusted context; the model cannot choose whose documents to search.
      const chunks = await retrieval.retrieve(ctx.userId, query, { limit, signal: ctx.signal });
      if (chunks.length === 0) {
        return { results: [], note: "No relevant passages found in the user's documents." };
      }
      const refs = ctx.addSources(chunks);
      return {
        results: chunks.map((c, i) => ({
          ref: refs[i],
          fileName: c.fileName,
          pages: c.pageStart === null ? null : c.pageStart === c.pageEnd ? `${c.pageStart}` : `${c.pageStart}-${c.pageEnd}`,
          score: Number(c.score.toFixed(3)),
          content: c.content,
        })),
      };
    },
  });
