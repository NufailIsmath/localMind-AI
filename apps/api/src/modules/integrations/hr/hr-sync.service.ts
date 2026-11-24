import { Prisma, type PrismaClient } from "@prisma/client";
import { errorMessage } from "../../../lib/errors.js";
import { HrSyncError, needsExternalId, type HrEventType, type HrLeaveClient, type HrLeavePayload } from "./hr-client.js";

type Db = Prisma.TransactionClient | PrismaClient;

export interface HrSyncOptions {
  enabled: boolean;
  baseUrl: string;
  intervalMs: number;
  maxAttempts: number;
}

export interface HrSyncLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const BATCH = 20;
const LEASE_MS = 2 * 60_000;
const backoffMs = (attempt: number) => Math.min(30_000 * 2 ** (attempt - 1), 60 * 60_000); // 30s, 1m, 2m … max 1h

/**
 * Transactional outbox for the external HR leave system.
 *
 *  - enqueue() is called inside the same database transaction as the leave
 *    change, so a change is never lost or sent without being committed.
 *  - processDue() delivers due events in creation order *per leave entry*
 *    (a decision is never sent before the request it belongs to), retrying
 *    transient failures with exponential back-off. Events are claimed with
 *    FOR UPDATE SKIP LOCKED, so several API instances never send twice.
 *  - Each event's id is sent as the Idempotency-Key, so retries are safe.
 */
export class HrSyncService {
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly client: HrLeaveClient,
    private readonly opts: HrSyncOptions,
    private readonly log: HrSyncLogger,
  ) {}

  get enabled(): boolean {
    return this.opts.enabled;
  }

  /** Records a leave change for delivery. No-op while the integration is disabled. */
  async enqueue(db: Db, entryId: string, type: HrEventType, extra: { decisionNote?: string | null; decidedById?: string | null } = {}): Promise<void> {
    if (!this.opts.enabled) return;
    const e = await db.leaveEntry.findUnique({ where: { id: entryId }, include: { user: { select: { email: true } } } });
    if (!e) return;
    // Follow-up events only make sense for leave the HR system knows about
    // (e.g. leave recorded before the integration was switched on is skipped).
    if (needsExternalId(type) && !e.externalId) {
      const created = await db.hrSyncEvent.count({ where: { entryId, eventType: { in: ["leave.request_submitted", "leave.recorded"] } } });
      if (created === 0) {
        this.log.info({ entryId, type }, "HR sync: skipping event for leave that was never sent to the HR system");
        return;
      }
    }
    const decidedBy = extra.decidedById ? await db.user.findUnique({ where: { id: extra.decidedById }, select: { email: true } }) : null;
    const payload: HrLeavePayload = {
      clbuddyLeaveId: e.id,
      employeeEmail: e.user.email,
      leaveType: e.leaveType,
      startDate: e.startDate.toISOString().slice(0, 10),
      endDate: e.endDate.toISOString().slice(0, 10),
      days: e.halfDays / 2,
      note: e.note,
      ...(extra.decisionNote !== undefined ? { decisionNote: extra.decisionNote } : {}),
      ...(decidedBy ? { decidedByEmail: decidedBy.email } : {}),
      occurredAt: new Date().toISOString(),
    };
    await db.hrSyncEvent.create({ data: { entryId, eventType: type, payload: payload as unknown as Prisma.InputJsonValue } });
  }

  start(): void {
    if (!this.opts.enabled || this.opts.intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => void this.processDue().catch((err) => this.log.error({ err: errorMessage(err) }, "HR sync run failed")), this.opts.intervalMs);
    this.timer.unref();
    this.log.info({ baseUrl: this.opts.baseUrl }, "HR leave sync enabled");
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** Sends everything that's due. Returns how many events were delivered. */
  processDue(): Promise<number> {
    if (!this.opts.enabled) return Promise.resolve(0);
    // One run at a time per process (overlapping timer ticks just share it).
    this.running ??= this.run().finally(() => (this.running = undefined));
    return this.running;
  }

  private async run(): Promise<number> {
    let delivered = 0;
    for (;;) {
      // Claim a batch with a lease so other instances skip it.
      const claimed = await this.prisma.$queryRaw<{ id: string }[]>`
        UPDATE "HrSyncEvent" SET "nextAttemptAt" = now() + ${LEASE_MS} * interval '1 millisecond'
        WHERE id IN (
          SELECT id FROM "HrSyncEvent"
          WHERE status = 'PENDING' AND "nextAttemptAt" <= now()
          ORDER BY "createdAt" ASC
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id`;
      if (claimed.length === 0) return delivered;
      const events = await this.prisma.hrSyncEvent.findMany({ where: { id: { in: claimed.map((c) => c.id) } }, orderBy: { createdAt: "asc" } });
      let progressed = false;
      for (const ev of events) {
        // Keep per-leave order: wait while an earlier event for the same leave is unsent.
        const earlier = await this.prisma.hrSyncEvent.findFirst({
          where: { entryId: ev.entryId, createdAt: { lt: ev.createdAt }, status: { in: ["PENDING", "FAILED"] } },
          select: { id: true },
        });
        if (earlier) {
          await this.prisma.hrSyncEvent.update({ where: { id: ev.id }, data: { nextAttemptAt: new Date(Date.now() + 5_000) } });
          continue;
        }
        if (await this.deliver(ev)) {
          delivered++;
          progressed = true;
        }
      }
      if (!progressed) return delivered;
    }
  }

  private async deliver(ev: { id: string; entryId: string; eventType: string; payload: Prisma.JsonValue; attempts: number }): Promise<boolean> {
    const entry = await this.prisma.leaveEntry.findUnique({ where: { id: ev.entryId }, select: { externalId: true } });
    const type = ev.eventType as HrEventType;
    try {
      if (needsExternalId(type) && !entry?.externalId) throw new HrSyncError("The HR system hasn't returned an id for this leave yet", true);
      const res = await this.client.send({ id: ev.id, type, payload: ev.payload as unknown as HrLeavePayload, externalId: entry?.externalId ?? null });
      await this.prisma.$transaction([
        this.prisma.hrSyncEvent.update({ where: { id: ev.id }, data: { status: "SENT", sentAt: new Date(), attempts: ev.attempts + 1, lastError: null } }),
        ...(res.externalId && entry && !entry.externalId ? [this.prisma.leaveEntry.update({ where: { id: ev.entryId }, data: { externalId: res.externalId } })] : []),
      ]);
      return true;
    } catch (err) {
      const attempts = ev.attempts + 1;
      const retryable = err instanceof HrSyncError ? err.retryable : true;
      const failed = !retryable || attempts >= this.opts.maxAttempts;
      await this.prisma.hrSyncEvent.update({
        where: { id: ev.id },
        data: {
          attempts,
          lastError: errorMessage(err).slice(0, 500),
          status: failed ? "FAILED" : "PENDING",
          nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
        },
      });
      (failed ? this.log.error : this.log.warn).call(this.log, { eventId: ev.id, type, attempts, err: errorMessage(err) }, failed ? "HR sync event failed" : "HR sync will retry");
      return false;
    }
  }

  // ---------- admin ----------

  async status() {
    const counts = await this.prisma.hrSyncEvent.groupBy({ by: ["status"], _count: { _all: true } });
    const failures = await this.prisma.hrSyncEvent.findMany({ where: { status: "FAILED" }, orderBy: { createdAt: "desc" }, take: 20 });
    const lastSent = await this.prisma.hrSyncEvent.findFirst({ where: { status: "SENT" }, orderBy: { sentAt: "desc" }, select: { sentAt: true } });
    return {
      enabled: this.opts.enabled,
      baseUrl: this.opts.baseUrl,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Partial<Record<"PENDING" | "SENT" | "FAILED", number>>,
      lastSentAt: lastSent?.sentAt?.toISOString() ?? null,
      failures: failures.map((f) => ({
        id: f.id,
        eventType: f.eventType,
        attempts: f.attempts,
        lastError: f.lastError,
        createdAt: f.createdAt.toISOString(),
        employeeEmail: (f.payload as { employeeEmail?: string } | null)?.employeeEmail ?? null,
      })),
    };
  }

  /** Puts a failed event back in the queue (e.g. after the HR system was fixed). */
  async retry(eventId: string): Promise<boolean> {
    const { count } = await this.prisma.hrSyncEvent.updateMany({
      where: { id: eventId, status: "FAILED" },
      data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date(), lastError: null },
    });
    return count > 0;
  }
}
