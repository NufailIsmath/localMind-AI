/**
 * Tiny in-process job queue with bounded concurrency. Ingestion is CPU/GPU
 * bound on the Ollama side, so running a couple of documents at a time keeps
 * the chat model responsive. Swap for BullMQ/pg-boss if you need durability
 * across processes; documents left PENDING/PROCESSING are re-queued at startup.
 */
export class JobQueue {
  private readonly pending: { key: string; run: () => Promise<void> }[] = [];
  private readonly active = new Set<string>();
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly onError: (key: string, err: unknown) => void = () => {},
  ) {}

  /**
   * Enqueue a job. A key that is already *queued* is ignored; a key that is
   * currently *running* is queued again and starts once the running job ends
   * (so a re-index requested mid-run is never dropped).
   */
  push(key: string, run: () => Promise<void>): boolean {
    if (this.pending.some((j) => j.key === key)) return false;
    this.pending.push({ key, run });
    this.drain();
    return true;
  }

  get size(): number {
    return this.pending.length + this.active.size;
  }

  /** Resolves once every queued job has finished. */
  onIdle(): Promise<void> {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private drain(): void {
    while (this.active.size < this.concurrency) {
      const idx = this.pending.findIndex((j) => !this.active.has(j.key));
      if (idx < 0) break;
      const [job] = this.pending.splice(idx, 1) as [{ key: string; run: () => Promise<void> }];
      this.active.add(job.key);
      void job
        .run()
        .catch((err) => this.onError(job.key, err))
        .finally(() => {
          this.active.delete(job.key);
          this.drain();
          if (this.size === 0) {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            waiters.forEach((w) => w());
          }
        });
    }
  }
}
