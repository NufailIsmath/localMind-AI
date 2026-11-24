/**
 * Pure leave arithmetic (no I/O), in HALF-DAY units so half days are exact.
 *
 * Balance for a year and leave type:
 *   total     = entitlement + usable carry-over + adjustments
 *   taken     = approved leave that has started (start ≤ as-of date)
 *   booked    = approved leave in the future
 *   remaining = total − taken − booked
 *
 * Carry-over: days carried from last year must be used by their expiry date.
 * After that date, only the carried days actually used before it still count;
 * the rest are forfeited.
 */
export type LeaveTypeName = "ANNUAL" | "SICK" | "PARENTAL" | "UNPAID" | "OTHER";

export interface AllowanceInput {
  leaveType: LeaveTypeName;
  entitledHalfDays: number;
  carriedHalfDays: number;
  carryOverExpiresOn: string | null; // YYYY-MM-DD
  adjustmentHalfDays: number;
}

export interface EntryInput {
  id?: string;
  leaveType: LeaveTypeName;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  halfDays: number;
  status: "APPROVED" | "CANCELLED";
  note?: string | null;
}

export interface Balance {
  year: number;
  leaveType: LeaveTypeName;
  entitled: number;
  carriedOver: number;
  carryOverExpiresOn: string | null;
  carryOverForfeited: number;
  /** Carried-over days still to use before they expire (0 once expired). */
  carryOverToUseBeforeExpiry: number;
  adjustments: number;
  total: number;
  taken: number;
  booked: number;
  remaining: number;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(s: string): Date {
  if (!ISO.test(s)) throw new Error(`Invalid date "${s}" (use YYYY-MM-DD)`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error(`Invalid date "${s}"`);
  return d;
}

export const toISODate = (d: Date): string => d.toISOString().slice(0, 10);
export const days = (halfDays: number): number => halfDays / 2;
export const halfDaysOf = (d: number): number => Math.round(d * 2);

/** Working days in [start, end], excluding weekends and the given holidays. */
export function workingDays(start: string, end: string, holidays: ReadonlySet<string>): { halfDays: number; dates: string[]; holidaysHit: string[] } {
  const s = parseDate(start);
  const e = parseDate(end);
  if (e < s) throw new Error("End date is before start date");
  if ((e.getTime() - s.getTime()) / 86_400_000 > 366) throw new Error("Range is longer than a year");
  const dates: string[] = [];
  const holidaysHit: string[] = [];
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const iso = toISODate(d);
    if (holidays.has(iso)) {
      holidaysHit.push(iso);
      continue;
    }
    dates.push(iso);
  }
  return { halfDays: dates.length * 2, dates, holidaysHit };
}

export function computeBalance(year: number, allowance: AllowanceInput, entries: EntryInput[], asOf: string): Balance {
  const relevant = entries.filter(
    (e) => e.status === "APPROVED" && e.leaveType === allowance.leaveType && e.startDate.startsWith(`${year}-`),
  );
  const taken = relevant.filter((e) => e.startDate <= asOf).reduce((a, e) => a + e.halfDays, 0);
  const booked = relevant.filter((e) => e.startDate > asOf).reduce((a, e) => a + e.halfDays, 0);

  let usableCarry = allowance.carriedHalfDays;
  let forfeited = 0;
  let toUse = 0;
  const expiry = allowance.carryOverExpiresOn;
  if (expiry && allowance.carriedHalfDays > 0) {
    const usedByExpiry = relevant.filter((e) => e.startDate <= expiry).reduce((a, e) => a + e.halfDays, 0);
    if (asOf > expiry) {
      usableCarry = Math.min(allowance.carriedHalfDays, usedByExpiry);
      forfeited = allowance.carriedHalfDays - usableCarry;
    } else {
      toUse = Math.max(0, allowance.carriedHalfDays - usedByExpiry);
    }
  }

  const total = allowance.entitledHalfDays + usableCarry + allowance.adjustmentHalfDays;
  return {
    year,
    leaveType: allowance.leaveType,
    entitled: days(allowance.entitledHalfDays),
    carriedOver: days(allowance.carriedHalfDays),
    carryOverExpiresOn: expiry,
    carryOverForfeited: days(forfeited),
    carryOverToUseBeforeExpiry: days(toUse),
    adjustments: days(allowance.adjustmentHalfDays),
    total: days(total),
    taken: days(taken),
    booked: days(booked),
    remaining: days(total - taken - booked),
  };
}

/** Returns entries that overlap [start, end]. */
export function overlapping(entries: EntryInput[], start: string, end: string): EntryInput[] {
  return entries.filter((e) => e.status === "APPROVED" && e.startDate <= end && e.endDate >= start);
}
