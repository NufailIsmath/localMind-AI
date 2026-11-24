/** An error that is safe to show to API clients. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, "BAD_REQUEST", message, details);
export const unauthorized = (message = "Authentication required") =>
  new AppError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "Forbidden") => new AppError(403, "FORBIDDEN", message);
export const notFound = (message = "Not found") => new AppError(404, "NOT_FOUND", message);
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, "CONFLICT", message, details);

/** Raised when an upstream dependency (Ollama, Qdrant) fails. */
export class UpstreamError extends Error {
  timedOut = false;

  constructor(
    readonly service: string,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(`${service}: ${message}`, options);
    this.name = "UpstreamError";
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
