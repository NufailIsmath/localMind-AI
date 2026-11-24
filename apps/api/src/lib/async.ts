export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Races a promise against a timer. The underlying work is not cancelled, so
 * pass an AbortSignal into the work itself when it supports one.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  /** Return false to stop retrying (e.g. for 4xx errors). */
  shouldRetry?: (err: unknown) => boolean;
  signal?: AbortSignal;
}

/** Retries with exponential backoff and jitter. */
export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 250;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const canRetry = attempt < opts.retries && !opts.signal?.aborted && (opts.shouldRetry?.(err) ?? true);
      if (!canRetry) throw err;
      const delay = base * 2 ** attempt * (0.5 + Math.random() / 2);
      await sleep(delay);
    }
  }
}

/** Runs async work over items with bounded concurrency, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}
