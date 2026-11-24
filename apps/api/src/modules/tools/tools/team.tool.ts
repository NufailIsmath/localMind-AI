import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { defineTool } from "../tool.types.js";

const MAX_CONTACTS = 6;
const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).map((w) => w.replace(/s$/, "")));

/**
 * Company directory lookup: which team handles a topic, and who to contact.
 * Read-only; data comes from admin-managed groups (name, description =
 * responsibilities, members). Lets the buddy route people ("payroll → HR,
 * hr@company") without ever inventing contacts.
 */
export const findTeamTool = (prisma: PrismaClient) =>
  defineTool({
    name: "find_team",
    description:
      "Find which team handles a topic (e.g. 'payroll', 'laptop', 'expenses', 'security incident') and who to contact " +
      "there. Returns teams with their responsibilities and member email addresses. Call with no query to list all teams.",
    schema: z.object({
      query: z.string().trim().max(100).optional().describe("Topic or team name, e.g. 'leave request' or 'IT'"),
    }),
    async execute({ query }) {
      const groups = await prisma.group.findMany({
        orderBy: { name: "asc" },
        select: {
          name: true,
          description: true,
          members: { select: { user: { select: { email: true } } }, orderBy: { createdAt: "asc" }, take: MAX_CONTACTS },
        },
      });
      const toTeam = (g: (typeof groups)[number]) => ({
        team: g.name,
        handles: g.description ?? null,
        contacts: g.members.map((m) => m.user.email),
      });
      if (!query) return { teams: groups.map(toTeam) };

      const q = words(query);
      const scored = groups
        .map((g) => {
          const name = words(g.name);
          const desc = words(g.description ?? "");
          const score = [...q].reduce((acc, w) => acc + (name.has(w) ? 3 : 0) + (desc.has(w) ? 1 : 0), 0);
          return { g, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      if (scored.length === 0) {
        return { teams: [], note: "No team matched. Here are all teams so you can pick the closest one.", allTeams: groups.map(toTeam) };
      }
      return { teams: scored.slice(0, 3).map((x) => toTeam(x.g)) };
    },
  });
