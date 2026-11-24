import { z } from "zod";
import { ToolError, defineTool } from "../tool.types.js";

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const getCurrentTimeTool = (now: () => Date = () => new Date()) =>
  defineTool({
    name: "get_current_time",
    description:
      "Get the current date and time. Optionally pass an IANA time zone such as 'Europe/London'; defaults to the server time zone.",
    schema: z.object({
      timezone: z.string().max(64).optional().describe("IANA time zone name, e.g. 'Asia/Colombo'"),
    }),
    async execute({ timezone }) {
      const date = now();
      const timeZone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!isValidTimeZone(timeZone)) throw new ToolError(`Unknown time zone "${timezone}"`);
      return {
        iso: date.toISOString(),
        timeZone,
        local: new Intl.DateTimeFormat("en-GB", {
          timeZone,
          dateStyle: "full",
          timeStyle: "long",
        }).format(date),
      };
    },
  });
