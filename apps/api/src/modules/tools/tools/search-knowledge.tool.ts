import { z } from "zod";
import type { RetrievalService } from "../../../rag/retrieval.service.js";
import { defineTool } from "../tool.types.js";

export const searchKnowledgeTool = (retrieval: RetrievalService, maxLimit = 10, acknowledgeRestricted = true) =>
  defineTool({
    name: "search_knowledge",
    description:
      "Semantic search over the documents the user can access (their uploads and documents shared with them). " +
      "Returns the most relevant passages with source references (S1, S2, …) to cite, and may report restricted " +
      "matches (R1, …) the user is not allowed to read. Use it whenever the question could be answered by documents. " +
      "Rephrase the question as a concise search query.",
    schema: z.object({
      query: z.string().trim().min(1).max(500).describe("What to search for"),
      limit: z.number().int().min(1).max(maxLimit).optional().describe("Maximum passages to return (default 5)"),
    }),
    async execute({ query, limit }, ctx) {
      // Access comes from the trusted context; the model cannot choose whose documents to search
      // or raise its own clearance. Documents the user may not read are never retrieved at all.
      const { chunks, withheld } = acknowledgeRestricted
        ? await retrieval.retrieveWithNotices(ctx.principal, query, { limit, signal: ctx.signal })
        : { chunks: await retrieval.retrieve(ctx.principal, query, { limit, signal: ctx.signal }), withheld: [] };

      const restricted = withheld.length
        ? ctx.addRestricted(withheld).map((ref, i) => ({
            ref,
            reason: withheld[i]!.reason,
            classification: withheld[i]!.classification,
            sharedWith: withheld[i]!.sharedWith,
            userCanRequestAccess: withheld[i]!.canRequest,
          }))
        : undefined;
      const restrictedGuidance = restricted
        ? "Some matching information is in documents this user is NOT allowed to read. You have NOT seen their contents and " +
          "must not guess them. Tell the user, warmly and with a light touch of humour, that it's confidential (e.g. 'Ah-ah, nice " +
          "try 🤫 — that one's confidential'), explain why in plain words (above their clearance, or only shared with the listed " +
          "teams), and if userCanRequestAccess is true, mention they can use the 'Ask for access' button below your reply."
        : undefined;

      if (chunks.length === 0) {
        return restricted
          ? { results: [], restricted, guidance: restrictedGuidance }
          : { results: [], note: "No relevant passages found in the documents available to this user." };
      }
      const refs = ctx.addSources(chunks, query);
      return {
        results: chunks.map((c, i) => ({
          ref: refs[i],
          fileName: c.fileName,
          pages: c.pageStart === null ? null : c.pageStart === c.pageEnd ? `${c.pageStart}` : `${c.pageStart}-${c.pageEnd}`,
          classification: c.classification,
          score: Number(c.score.toFixed(3)),
          content: c.content,
        })),
        ...(restricted ? { restricted, guidance: restrictedGuidance } : {}),
      };
    },
  });
