import type { LeaveType, Prisma, PrismaClient } from "@prisma/client";
import type { LeaveBalanceDto, LeaveEntryDto, LeavePersonSummaryDto, LeavePlanDto, LeaveRequestDto } from "@clbuddy/shared";
import { AppError, badRequest, forbidden, notFound } from "../../lib/errors.js";
import type { AccessPrincipal } from "../access/access.policy.js";
import type { AccessService } from "../access/access.service.js";
import { parseCsv } from "./csv.js";
import type { HrSyncService } from "../integrations/hr/hr-sync.service.js";
import {
  computeBalance,
  days,
  halfDaysOf,
  overlapping,
  parseDate,
  toISODate,
  workingDays,
  type AllowanceInput,
  type EntryInput,
  type LeaveTypeName,
} from "./leave.calc.js";

export const LEAVE_TYPES = ["ANNUAL", "SICK", "PARENTAL", "UNPAID", "OTHER"] as const satisfies readonly LeaveType[];

/**
 * Where leave data comes from. Today: CL Buddy's own tables, maintained by HR.
 * Later this can be swapped for an HR-system connector (BambooHR, HiBob…)
 * without touching the tools, balance maths or UI.
 */
export interface EntryRecord extends EntryInput {
  id: string;
  source: "MANUAL" | "IMPORT" | "REQUEST";
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface LeaveDataSource {
  allowances(userId: string, year: number): Promise<AllowanceInput[]>;
  entries(userId: string, year: number): Promise<EntryRecord[]>;
  holidays(from: string, to: string): Promise<{ date: string; name: string }[]>;
}

export class PrismaLeaveDataSource implements LeaveDataSource {
  constructor(private readonly prisma: PrismaClient) {}

  async allowances(userId: string, year: number): Promise<AllowanceInput[]> {
    const rows = await this.prisma.leaveAllowance.findMany({ where: { userId, year } });
    return rows.map((a) => ({
      leaveType: a.leaveType,
      entitledHalfDays: a.entitledHalfDays,
      carriedHalfDays: a.carriedHalfDays,
      carryOverExpiresOn: a.carryOverExpiresOn ? toISODate(a.carryOverExpiresOn) : null,
      adjustmentHalfDays: a.adjustmentHalfDays,
    }));
  }

  async entries(userId: string, year: number): Promise<EntryRecord[]> {
    const rows = await this.prisma.leaveEntry.findMany({
      where: { userId, startDate: { gte: parseDate(`${year}-01-01`), lte: parseDate(`${year}-12-31`) } },
      orderBy: { startDate: "asc" },
    });
    return rows.map((e) => ({
      id: e.id,
      leaveType: e.leaveType,
      startDate: toISODate(e.startDate),
      endDate: toISODate(e.endDate),
      halfDays: e.halfDays,
      status: e.status,
      note: e.note,
      source: e.source,
      decisionNote: e.decisionNote,
      decidedAt: e.decidedAt?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  async holidays(from: string, to: string) {
    const rows = await this.prisma.companyHoliday.findMany({
      where: { date: { gte: parseDate(from), lte: parseDate(to) } },
      orderBy: { date: "asc" },
    });
    return rows.map((h) => ({ date: toISODate(h.date), name: h.name }));
  }
}

const toEntryDto = (e: EntryInput & Partial<EntryRecord>): LeaveEntryDto => ({
  id: e.id ?? "",
  leaveType: e.leaveType,
  startDate: e.startDate,
  endDate: e.endDate,
  days: days(e.halfDays),
  status: e.status,
  note: e.note ?? null,
  ...(e.source ? { source: e.source } : {}),
  ...(e.decisionNote !== undefined ? { decisionNote: e.decisionNote } : {}),
  ...(e.decidedAt !== undefined ? { decidedAt: e.decidedAt } : {}),
  ...(e.createdAt ? { createdAt: e.createdAt } : {}),
});

export interface LeaveOptions {
  /** Members of this group (plus admins) manage everyone's leave records. */
  managerGroup: string;
  today?: () => string;
}

export class LeaveService {
  private readonly today: () => string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly source: LeaveDataSource,
    private readonly access: AccessService,
    private readonly opts: LeaveOptions,
    /** Pushes changes to the external HR leave system (no-op when disabled). */
    private readonly hrSync?: HrSyncService,
  ) {
    this.today = opts.today ?? (() => toISODate(new Date()));
  }

  // ---------- self-service (always the caller's own records) ----------

  async myBalance(userId: string, year = Number(this.today().slice(0, 4))): Promise<LeaveBalanceDto> {
    const asOf = this.today();
    const [allowances, entries] = await Promise.all([this.source.allowances(userId, year), this.source.entries(userId, year)]);
    const balances = allowances.map((a) => computeBalance(year, a, entries, asOf));
    // Leave types with records but no allowance (e.g. unpaid) still show what was taken.
    const typesWithAllowance = new Set(allowances.map((a) => a.leaveType));
    for (const t of new Set(entries.filter((e) => e.status === "APPROVED").map((e) => e.leaveType))) {
      if (!typesWithAllowance.has(t)) {
        balances.push(computeBalance(year, { leaveType: t, entitledHalfDays: 0, carriedHalfDays: 0, carryOverExpiresOn: null, adjustmentHalfDays: 0 }, entries, asOf));
      }
    }
    return {
      year,
      asOf,
      configured: allowances.length > 0,
      balances,
      upcoming: entries.filter((e) => e.status === "APPROVED" && e.startDate > asOf).map(toEntryDto),
      taken: entries.filter((e) => e.status === "APPROVED" && e.startDate <= asOf).map(toEntryDto),
      requests: entries
        .filter((e) => e.source === "REQUEST")
        .sort((a, b) => Number(b.status === "PENDING") - Number(a.status === "PENDING") || b.createdAt.localeCompare(a.createdAt))
        .map(toEntryDto),
    };
  }

  /** "If I take these dates, what's left?" — without booking anything. */
  async planDates(userId: string, startDate: string, endDate: string, leaveType: LeaveTypeName = "ANNUAL"): Promise<LeavePlanDto> {
    const { year, halfDays, dates, holidays } = await this.workingDaysFor(startDate, endDate);
    const asOf = this.today();
    const [allowances, entries] = await Promise.all([this.source.allowances(userId, year), this.source.entries(userId, year)]);
    const allowance = allowances.find((a) => a.leaveType === leaveType);
    const warnings: string[] = [];
    let requestable = true;
    if (startDate < asOf) {
      warnings.push("These dates are in the past.");
      requestable = false;
    }
    const clashes = overlapping(entries, startDate, endDate);
    if (clashes.length) {
      warnings.push(`You already have leave booked or requested on overlapping dates (${clashes.map((c) => `${c.startDate}–${c.endDate}`).join(", ")}).`);
      requestable = false;
    }
    if (halfDays === 0) {
      warnings.push("These dates contain no working days.");
      requestable = false;
    }

    let before = null;
    let after = null;
    if (allowance) {
      before = computeBalance(year, allowance, entries, asOf);
      after = computeBalance(year, allowance, [...entries, { leaveType, startDate, endDate, halfDays, status: "APPROVED" }], asOf);
      if (after.available < 0) {
        const pendingNote = before.pending > 0 ? ` (counting your ${before.pending} pending day(s))` : "";
        warnings.push(`That would overdraw your ${leaveType.toLowerCase()} leave by ${-after.available} day(s)${pendingNote}.`);
        requestable = false;
      }
    } else if (leaveType === "ANNUAL") {
      warnings.push("HR hasn't set up your annual leave allowance for that year yet.");
      requestable = false;
    }
    return {
      leaveType,
      startDate,
      endDate,
      workingDays: days(halfDays),
      workingDates: dates,
      holidaysInRange: holidays,
      configured: Boolean(allowance),
      remainingBefore: before?.remaining ?? null,
      remainingAfter: after?.remaining ?? null,
      availableBefore: before?.available ?? null,
      availableAfter: after?.available ?? null,
      warnings,
      requestable,
    };
  }

  // ---------- requests (option 3) ----------

  /**
   * Submits a leave request for the CALLER. Only ever called from an explicit
   * user action (button/API) — the assistant can propose a request but has no
   * tool that submits one. Serialised per user so two quick requests can't
   * both pass the balance check.
   */
  async createRequest(
    userId: string,
    input: { leaveType: LeaveTypeName; startDate: string; endDate: string; note?: string | null; actionRef?: string | null },
  ): Promise<LeaveEntryDto> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`leave:${userId}`}))`;
      const plan = await this.planDates(userId, input.startDate, input.endDate, input.leaveType);
      if (!plan.requestable) throw new AppError(409, "LEAVE_NOT_REQUESTABLE", plan.warnings.join(" ") || "These dates can't be requested", plan.warnings);
      if (input.actionRef) {
        const dup = await tx.leaveEntry.findFirst({ where: { userId, actionRef: input.actionRef, status: { in: ["PENDING", "APPROVED"] } } });
        if (dup) throw new AppError(409, "CONFLICT", "You've already submitted this request");
      }
      const e = await tx.leaveEntry.create({
        data: {
          userId,
          leaveType: input.leaveType,
          startDate: parseDate(input.startDate),
          endDate: parseDate(input.endDate),
          halfDays: halfDaysOf(plan.workingDays),
          status: "PENDING",
          source: "REQUEST",
          note: input.note?.slice(0, 500) || null,
          createdById: userId,
          actionRef: input.actionRef ?? null,
        },
      });
      await this.hrSync?.enqueue(tx, e.id, "leave.request_submitted");
      await this.access.audit(userId, "leave.request.created", "leave", e.id, { startDate: input.startDate, endDate: input.endDate, days: plan.workingDays, leaveType: input.leaveType });
      return this.entryDto(e);
    }, { timeout: 20_000 });
  }

  /** Withdraw a pending request, or cancel your own approved leave that hasn't started. */
  async cancelOwn(userId: string, entryId: string): Promise<LeaveEntryDto> {
    const e = await this.prisma.leaveEntry.findFirst({ where: { id: entryId, userId } });
    if (!e) throw notFound("Leave not found");
    const started = toISODate(e.startDate) <= this.today();
    if (!(e.status === "PENDING" || (e.status === "APPROVED" && !started))) {
      throw new AppError(409, "CONFLICT", e.status === "APPROVED" ? "Leave that has already started can only be changed by HR" : `This request is already ${e.status.toLowerCase()}`);
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.leaveEntry.update({ where: { id: entryId }, data: { status: "CANCELLED" } });
      await this.hrSync?.enqueue(tx, entryId, e.status === "PENDING" ? "leave.request_withdrawn" : "leave.cancelled");
      return u;
    });
    await this.access.audit(userId, e.status === "PENDING" ? "leave.request.withdrawn" : "leave.entry.cancelled_by_owner", "leave", entryId, {
      startDate: toISODate(e.startDate),
      endDate: toISODate(e.endDate),
    });
    return this.entryDto(updated);
  }

  /** HR inbox. */
  async listRequests(p: AccessPrincipal, status: "PENDING" | "DECIDED" = "PENDING"): Promise<LeaveRequestDto[]> {
    await this.requireManager(p);
    const rows = await this.prisma.leaveEntry.findMany({
      where: status === "PENDING" ? { source: "REQUEST", status: "PENDING" } : { source: "REQUEST", status: { in: ["APPROVED", "REJECTED"] } },
      orderBy: status === "PENDING" ? { startDate: "asc" } : { decidedAt: "desc" },
      take: 200,
      include: { user: { select: { email: true } } },
    });
    const deciders = new Map(
      (await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.decidedById).filter((x): x is string => !!x) } }, select: { id: true, email: true } })).map((u) => [u.id, u.email]),
    );
    return Promise.all(
      rows.map(async (r) => {
        const year = r.startDate.getUTCFullYear();
        const allowance = (await this.source.allowances(r.userId, year)).find((a) => a.leaveType === r.leaveType);
        let ifApproved: number | null = null;
        if (allowance) {
          const entries = await this.source.entries(r.userId, year);
          ifApproved = computeBalance(year, allowance, entries.map((x) => (x.id === r.id ? { ...x, status: "APPROVED" as const } : x)), this.today()).remaining;
        }
        return { ...this.entryDto(r), requesterEmail: r.user.email, decidedByEmail: r.decidedById ? deciders.get(r.decidedById) ?? null : null, availableIfApproved: ifApproved };
      }),
    );
  }

  async decide(p: AccessPrincipal, entryId: string, approve: boolean, note?: string | null): Promise<LeaveEntryDto> {
    await this.requireManager(p);
    return this.prisma.$transaction(async (tx) => {
      const e = await tx.leaveEntry.findUnique({ where: { id: entryId } });
      if (!e || e.source !== "REQUEST") throw notFound("Request not found");
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`leave:${e.userId}`}))`;
      const current = await tx.leaveEntry.findUnique({ where: { id: entryId } });
      if (current!.status !== "PENDING") throw new AppError(409, "CONFLICT", `This request was already ${current!.status.toLowerCase()}`);
      if (e.userId === p.userId) throw forbidden("You can't decide on your own leave request; another HR member or an admin has to");
      if (approve) {
        const year = e.startDate.getUTCFullYear();
        const [allowances, entries] = await Promise.all([this.source.allowances(e.userId, year), this.source.entries(e.userId, year)]);
        const others = entries.filter((x) => x.id !== e.id);
        const start = toISODate(e.startDate);
        const end = toISODate(e.endDate);
        if (overlapping(others.filter((x) => x.status === "APPROVED"), start, end).length) {
          throw new AppError(409, "CONFLICT", "It overlaps leave that's already approved; reject it or cancel the other leave first");
        }
        const allowance = allowances.find((a) => a.leaveType === e.leaveType);
        if (allowance) {
          const after = computeBalance(year, allowance, [...others, { leaveType: e.leaveType, startDate: start, endDate: end, halfDays: e.halfDays, status: "APPROVED" }], this.today());
          if (after.remaining < 0) throw new AppError(409, "CONFLICT", `Approving would overdraw their ${e.leaveType.toLowerCase()} leave by ${-after.remaining} day(s)`);
        }
      }
      const updated = await tx.leaveEntry.update({
        where: { id: entryId },
        data: { status: approve ? "APPROVED" : "REJECTED", decidedById: p.userId, decidedAt: new Date(), decisionNote: note?.slice(0, 500) || null },
      });
      await this.hrSync?.enqueue(tx, entryId, approve ? "leave.request_approved" : "leave.request_rejected", {
        decisionNote: note?.slice(0, 500) || null,
        decidedById: p.userId,
      });
      await this.access.audit(p.userId, approve ? "leave.request.approved" : "leave.request.rejected", "leave", entryId, {
        requester: e.userId,
        startDate: toISODate(e.startDate),
        endDate: toISODate(e.endDate),
        note: note ?? null,
      });
      return this.entryDto(updated);
    }, { timeout: 20_000 });
  }

  /** Status of requests submitted from chat cards ("messageId:actionId" → request). */
  async requestsForActions(userId: string, refs: string[]) {
    if (refs.length === 0) return new Map<string, { id: string; status: LeaveEntryDto["status"]; decisionNote: string | null }>();
    const rows = await this.prisma.leaveEntry.findMany({ where: { userId, actionRef: { in: refs } }, orderBy: { createdAt: "asc" } });
    return new Map(rows.map((r) => [r.actionRef!, { id: r.id, status: r.status, decisionNote: r.decisionNote }]));
  }

  private entryDto(e: { id: string; leaveType: LeaveTypeName; startDate: Date; endDate: Date; halfDays: number; status: LeaveEntryDto["status"]; note: string | null; source: "MANUAL" | "IMPORT" | "REQUEST"; decisionNote: string | null; decidedAt: Date | null; createdAt: Date }): LeaveEntryDto {
    return toEntryDto({
      id: e.id,
      leaveType: e.leaveType,
      startDate: toISODate(e.startDate),
      endDate: toISODate(e.endDate),
      halfDays: e.halfDays,
      status: e.status,
      note: e.note,
      source: e.source,
      decisionNote: e.decisionNote,
      decidedAt: e.decidedAt?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
    });
  }

  // ---------- HR / admin management ----------

  async canManage(p: AccessPrincipal): Promise<boolean> {
    if (p.role === "ADMIN") return true;
    if (p.groupIds.length === 0) return false;
    const n = await this.prisma.group.count({ where: { id: { in: p.groupIds }, name: this.opts.managerGroup } });
    return n > 0;
  }

  async requireManager(p: AccessPrincipal): Promise<void> {
    if (!(await this.canManage(p))) throw forbidden(`Only administrators and the ${this.opts.managerGroup} team can manage leave records`);
  }

  async people(p: AccessPrincipal, year: number): Promise<LeavePersonSummaryDto[]> {
    await this.requireManager(p);
    const users = await this.prisma.user.findMany({ orderBy: { email: "asc" }, select: { id: true, email: true } });
    const asOf = this.today();
    const summaries = await Promise.all(
      users.map(async (u) => {
        const [allowances, entries] = await Promise.all([this.source.allowances(u.id, year), this.source.entries(u.id, year)]);
        const a = allowances.find((x) => x.leaveType === "ANNUAL");
        return {
          userId: u.id,
          email: u.email,
          annual: a ? computeBalance(year, a, entries, asOf) : null,
          allowances: allowances.map((x) => ({
            leaveType: x.leaveType,
            entitledDays: days(x.entitledHalfDays),
            carriedOverDays: days(x.carriedHalfDays),
            carryOverExpiresOn: x.carryOverExpiresOn,
            adjustmentDays: days(x.adjustmentHalfDays),
          })),
          entries: entries.map(toEntryDto),
        };
      }),
    );
    // People HR has set up first, then everyone else (alphabetical within each).
    return summaries.sort((a, b) => Number(!a.annual) - Number(!b.annual) || a.email.localeCompare(b.email));
  }

  async upsertAllowance(
    p: AccessPrincipal,
    input: { userId: string; year: number; leaveType: LeaveTypeName; entitledDays: number; carriedOverDays?: number; carryOverExpiresOn?: string | null; adjustmentDays?: number; note?: string | null },
  ): Promise<void> {
    await this.requireManager(p);
    await this.requireUser(input.userId);
    const data = {
      entitledHalfDays: halfDaysOf(input.entitledDays),
      carriedHalfDays: halfDaysOf(input.carriedOverDays ?? 0),
      carryOverExpiresOn: input.carryOverExpiresOn ? parseDate(input.carryOverExpiresOn) : null,
      adjustmentHalfDays: halfDaysOf(input.adjustmentDays ?? 0),
      note: input.note ?? null,
    };
    await this.prisma.leaveAllowance.upsert({
      where: { userId_year_leaveType: { userId: input.userId, year: input.year, leaveType: input.leaveType } },
      update: data,
      create: { userId: input.userId, year: input.year, leaveType: input.leaveType, ...data },
    });
    await this.access.audit(p.userId, "leave.allowance.updated", "user", input.userId, { ...input });
  }

  async addEntry(
    p: AccessPrincipal,
    input: { userId: string; leaveType: LeaveTypeName; startDate: string; endDate: string; days?: number; note?: string | null },
    source: "MANUAL" | "IMPORT" = "MANUAL",
    tx: Prisma.TransactionClient | PrismaClient = this.prisma,
  ): Promise<LeaveEntryDto> {
    if (source === "MANUAL") await this.requireManager(p);
    await this.requireUser(input.userId, tx);
    const { halfDays } = await this.workingDaysFor(input.startDate, input.endDate);
    const effective = input.days !== undefined ? halfDaysOf(input.days) : halfDays;
    if (effective <= 0) throw badRequest("Leave must cover at least half a working day");
    if (input.days !== undefined && effective > halfDays && halfDays > 0) {
      throw badRequest(`${input.days} days is more than the ${days(halfDays)} working days in that range`);
    }
    const e = await tx.leaveEntry.create({
      data: {
        userId: input.userId,
        leaveType: input.leaveType,
        startDate: parseDate(input.startDate),
        endDate: parseDate(input.endDate),
        halfDays: effective,
        source,
        note: input.note ?? null,
        createdById: p.userId,
      },
    });
    await this.hrSync?.enqueue(tx, e.id, "leave.recorded");
    if (source === "MANUAL") await this.access.audit(p.userId, "leave.entry.added", "user", input.userId, { ...input, days: days(effective) });
    return toEntryDto({ id: e.id, leaveType: e.leaveType, startDate: input.startDate, endDate: input.endDate, halfDays: e.halfDays, status: e.status, note: e.note });
  }

  async cancelEntry(p: AccessPrincipal, entryId: string): Promise<void> {
    await this.requireManager(p);
    const e = await this.prisma.leaveEntry.findUnique({ where: { id: entryId } });
    if (!e) throw notFound("Leave entry not found");
    await this.prisma.$transaction(async (tx) => {
      await tx.leaveEntry.update({ where: { id: entryId }, data: { status: "CANCELLED" } });
      await this.hrSync?.enqueue(tx, entryId, e.status === "PENDING" ? "leave.request_withdrawn" : "leave.cancelled");
    });
    await this.access.audit(p.userId, "leave.entry.cancelled", "user", e.userId, { entryId, startDate: toISODate(e.startDate), endDate: toISODate(e.endDate) });
  }

  async listHolidays(year: number) {
    return this.source.holidays(`${year}-01-01`, `${year}-12-31`);
  }

  async addHoliday(p: AccessPrincipal, date: string, name: string) {
    await this.requireManager(p);
    try {
      await this.prisma.companyHoliday.create({ data: { date: parseDate(date), name } });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new AppError(409, "CONFLICT", `${date} is already a holiday`);
      throw err;
    }
    await this.access.audit(p.userId, "leave.holiday.added", "holiday", date, { name });
  }

  async removeHoliday(p: AccessPrincipal, date: string) {
    await this.requireManager(p);
    const { count } = await this.prisma.companyHoliday.deleteMany({ where: { date: parseDate(date) } });
    if (!count) throw notFound("Holiday not found");
    await this.access.audit(p.userId, "leave.holiday.removed", "holiday", date, {});
  }

  /**
   * Imports a spreadsheet export. All-or-nothing: every row is validated
   * first, and any error rejects the whole file with per-row messages.
   *
   *   allowances: email, year, leave_type, entitled_days, carried_over_days, carry_over_expires, adjustment_days, note
   *   entries:    email, leave_type, start_date, end_date, days, note
   */
  async importCsv(p: AccessPrincipal, kind: "allowances" | "entries", csv: string): Promise<{ imported: number }> {
    await this.requireManager(p);
    let rows: Record<string, string>[];
    try {
      rows = parseCsv(csv);
    } catch (err) {
      throw badRequest(`Couldn't read the CSV: ${(err as Error).message}`);
    }
    if (rows.length === 0) throw badRequest("The CSV has no data rows");
    const users = new Map((await this.prisma.user.findMany({ select: { id: true, email: true } })).map((u) => [u.email.toLowerCase(), u.id]));
    const errors: { row: number; message: string }[] = [];
    const num = (v: string | undefined, field: string, row: number, required = false) => {
      if (!v) {
        if (required) errors.push({ row, message: `${field} is required` });
        return undefined;
      }
      const n = Number(v);
      if (!Number.isFinite(n) || Math.abs(n) > 400 || Math.round(n * 2) !== n * 2) errors.push({ row, message: `${field} must be a number of days (halves allowed)` });
      return n;
    };
    const date = (v: string | undefined, field: string, row: number, required = false) => {
      if (!v) {
        if (required) errors.push({ row, message: `${field} is required` });
        return undefined;
      }
      try {
        parseDate(v);
        return v;
      } catch {
        errors.push({ row, message: `${field} must be a date like 2026-03-31` });
        return undefined;
      }
    };
    const type = (v: string | undefined, row: number) => {
      const t = (v || "ANNUAL").toUpperCase();
      if (!(LEAVE_TYPES as readonly string[]).includes(t)) errors.push({ row, message: `leave_type must be one of ${LEAVE_TYPES.join(", ")}` });
      return t as LeaveTypeName;
    };
    const user = (v: string | undefined, row: number) => {
      const id = users.get((v ?? "").toLowerCase());
      if (!id) errors.push({ row, message: `no account for "${v ?? ""}"` });
      return id;
    };

    const parsed = rows.map((r, i) => {
      const row = i + 2; // header is row 1
      if (kind === "allowances") {
        const year = Number(r.year);
        if (!Number.isInteger(year) || year < 2000 || year > 2100) errors.push({ row, message: "year must be like 2026" });
        return {
          userId: user(r.email, row),
          year,
          leaveType: type(r.leave_type, row),
          entitledDays: num(r.entitled_days, "entitled_days", row, true),
          carriedOverDays: num(r.carried_over_days, "carried_over_days", row),
          carryOverExpiresOn: date(r.carry_over_expires, "carry_over_expires", row),
          adjustmentDays: num(r.adjustment_days, "adjustment_days", row),
          note: r.note?.slice(0, 200) || null,
        };
      }
      return {
        userId: user(r.email, row),
        leaveType: type(r.leave_type, row),
        startDate: date(r.start_date, "start_date", row, true),
        endDate: date(r.end_date, "end_date", row, true),
        days: num(r.days, "days", row),
        note: r.note?.slice(0, 200) || null,
      };
    });
    if (errors.length) throw new AppError(400, "IMPORT_INVALID", `${errors.length} problem(s) in the file; nothing was imported`, errors.slice(0, 50));

    await this.prisma.$transaction(async (tx) => {
      for (const [i, r] of parsed.entries()) {
        try {
          if (kind === "allowances") {
            const a = r as { userId: string; year: number; leaveType: LeaveTypeName; entitledDays: number; carriedOverDays?: number; carryOverExpiresOn?: string; adjustmentDays?: number; note: string | null };
            const data = {
              entitledHalfDays: halfDaysOf(a.entitledDays),
              carriedHalfDays: halfDaysOf(a.carriedOverDays ?? 0),
              carryOverExpiresOn: a.carryOverExpiresOn ? parseDate(a.carryOverExpiresOn) : null,
              adjustmentHalfDays: halfDaysOf(a.adjustmentDays ?? 0),
              note: a.note,
            };
            await tx.leaveAllowance.upsert({
              where: { userId_year_leaveType: { userId: a.userId, year: a.year, leaveType: a.leaveType } },
              update: data,
              create: { userId: a.userId, year: a.year, leaveType: a.leaveType, ...data },
            });
          } else {
            const e = r as { userId: string; leaveType: LeaveTypeName; startDate: string; endDate: string; days?: number; note: string | null };
            await this.addEntry(p, e, "IMPORT", tx);
          }
        } catch (err) {
          const message = err instanceof AppError ? err.message : "could not be saved";
          throw new AppError(400, "IMPORT_INVALID", `Row ${i + 2}: ${message}; nothing was imported`, [{ row: i + 2, message }]);
        }
      }
    }, { timeout: 60_000 });
    await this.access.audit(p.userId, "leave.imported", "leave", kind, { rows: parsed.length });
    return { imported: parsed.length };
  }

  // ---------- helpers ----------

  private async workingDaysFor(startDate: string, endDate: string) {
    let year: number;
    try {
      parseDate(startDate);
      parseDate(endDate);
      year = Number(startDate.slice(0, 4));
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    if (endDate.slice(0, 4) !== startDate.slice(0, 4)) throw badRequest("Leave can't span two years; split it at 31 December");
    const holidays = await this.source.holidays(startDate, endDate);
    try {
      const w = workingDays(startDate, endDate, new Set(holidays.map((h) => h.date)));
      return { year, halfDays: w.halfDays, dates: w.dates, holidays };
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  }

  private async requireUser(userId: string, tx: Prisma.TransactionClient | PrismaClient = this.prisma) {
    if (!(await tx.user.findUnique({ where: { id: userId }, select: { id: true } }))) throw notFound("User not found");
  }
}
