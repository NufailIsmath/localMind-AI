import { describe, expect, it } from "vitest";
import { computeBalance, overlapping, parseDate, workingDays, type AllowanceInput, type EntryInput } from "../../src/modules/leave/leave.calc.js";
import { parseCsv } from "../../src/modules/leave/csv.js";

const annual = (over: Partial<AllowanceInput> = {}): AllowanceInput => ({
  leaveType: "ANNUAL",
  entitledHalfDays: 42, // 21 days
  carriedHalfDays: 0,
  carryOverExpiresOn: null,
  adjustmentHalfDays: 0,
  ...over,
});
const entry = (startDate: string, endDate: string, halfDays: number, over: Partial<EntryInput> = {}): EntryInput => ({
  leaveType: "ANNUAL",
  startDate,
  endDate,
  halfDays,
  status: "APPROVED",
  ...over,
});

describe("workingDays", () => {
  it("skips weekends and company holidays", () => {
    // Mon 2 Mar – Fri 6 Mar 2026 = 5 days; with a holiday on Wed = 4
    expect(workingDays("2026-03-02", "2026-03-06", new Set()).halfDays).toBe(10);
    const r = workingDays("2026-03-02", "2026-03-06", new Set(["2026-03-04"]));
    expect(r.halfDays).toBe(8);
    expect(r.holidaysHit).toEqual(["2026-03-04"]);
    // Fri → Mon spans a weekend: 2 days
    expect(workingDays("2026-03-06", "2026-03-09", new Set()).dates).toEqual(["2026-03-06", "2026-03-09"]);
    expect(workingDays("2026-03-07", "2026-03-08", new Set()).halfDays).toBe(0);
  });

  it("rejects invalid ranges and dates", () => {
    expect(() => workingDays("2026-03-06", "2026-03-02", new Set())).toThrow(/before start/);
    expect(() => workingDays("2026-01-01", "2027-06-01", new Set())).toThrow(/longer than a year/);
    expect(() => parseDate("2026-02-30")).toThrow(/Invalid date/);
    expect(() => parseDate("06/03/2026")).toThrow(/YYYY-MM-DD/);
  });
});

describe("computeBalance", () => {
  it("splits taken vs booked around the as-of date", () => {
    const b = computeBalance(2026, annual(), [entry("2026-02-10", "2026-02-11", 4), entry("2026-12-22", "2026-12-24", 6)], "2026-11-24");
    expect(b).toMatchObject({ entitled: 21, total: 21, taken: 2, booked: 3, remaining: 16 });
  });

  it("supports half days, adjustments, and ignores other types, years and cancelled leave", () => {
    const b = computeBalance(
      2026,
      annual({ adjustmentHalfDays: 2 }),
      [
        entry("2026-05-04", "2026-05-04", 1),
        entry("2026-05-05", "2026-05-05", 2, { leaveType: "SICK" }),
        entry("2025-12-30", "2025-12-31", 4),
        entry("2026-06-01", "2026-06-05", 10, { status: "CANCELLED" }),
      ],
      "2026-11-24",
    );
    expect(b).toMatchObject({ adjustments: 1, total: 22, taken: 0.5, remaining: 21.5 });
  });

  it("forfeits carry-over not used by the expiry date", () => {
    const allowance = annual({ carriedHalfDays: 10, carryOverExpiresOn: "2026-03-31" }); // 5 carried
    const entries = [entry("2026-02-02", "2026-02-04", 6)]; // 3 days before expiry
    const before = computeBalance(2026, allowance, entries, "2026-03-01");
    expect(before).toMatchObject({ total: 26, carryOverToUseBeforeExpiry: 2, carryOverForfeited: 0, remaining: 23 });
    const after = computeBalance(2026, allowance, entries, "2026-04-01");
    expect(after).toMatchObject({ total: 24, carryOverForfeited: 2, carryOverToUseBeforeExpiry: 0, remaining: 21 });
  });

  it("can go negative (overdrawn) rather than hiding it", () => {
    expect(computeBalance(2026, annual({ entitledHalfDays: 4 }), [entry("2026-03-02", "2026-03-06", 10)], "2026-11-24").remaining).toBe(-3);
  });
});

describe("overlapping", () => {
  it("finds approved entries touching a range", () => {
    const es = [entry("2026-03-02", "2026-03-04", 6), entry("2026-03-10", "2026-03-10", 2, { status: "CANCELLED" })];
    expect(overlapping(es, "2026-03-04", "2026-03-12")).toHaveLength(1);
    expect(overlapping(es, "2026-03-05", "2026-03-12")).toHaveLength(0);
  });
});

describe("parseCsv", () => {
  it("handles quotes, commas, CRLF, BOM and blank lines", () => {
    const rows = parseCsv('﻿Email,Note\r\n"a@x.co","Hello, ""world"""\r\n\r\nb@x.co,plain\n');
    expect(rows).toEqual([
      { email: "a@x.co", note: 'Hello, "world"' },
      { email: "b@x.co", note: "plain" },
    ]);
    expect(() => parseCsv('a\n"unterminated')).toThrow(/Unterminated/);
    expect(() => parseCsv("h\n" + "x\n".repeat(20), 10)).toThrow(/Too many rows/);
  });
});
