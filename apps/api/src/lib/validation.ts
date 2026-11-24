import { z } from "zod";
import { badRequest } from "./errors.js";

/** Validates untrusted input, turning Zod issues into a 400 response. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw badRequest(
      "Validation failed",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}

export const UuidParam = z.object({ id: z.uuid() });
