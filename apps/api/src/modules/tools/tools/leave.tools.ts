import { z } from "zod";
import type { LeaveService } from "../../leave/leave.service.js";
import { defineTool } from "../tool.types.js";

const TYPES = ["ANNUAL", "SICK", "PARENTAL", "UNPAID", "OTHER"] as const;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/**
 * Leave tools. Deliberately self-only: neither takes a user parameter, so the
 * model can't look up anyone else's leave — identity comes from the session.
 */
export const myLeaveBalanceTool = (leave: LeaveService) =>
  defineTool({
    name: "get_my_leave_balance",
    description:
      "Get the current user's own leave balance: entitlement, carried-over days (and when they expire), days taken, " +
      "upcoming booked leave and days remaining, per leave type. Use for 'how many leave days do I have?' questions.",
    schema: z.object({
      year: z.number().int().min(2000).max(2100).optional().describe("Defaults to the current year"),
    }),
    async execute({ year }, ctx) {
      const b = await leave.myBalance(ctx.userId, year);
      if (!b.configured && b.balances.length === 0) {
        return { ...b, note: "HR hasn't set up a leave allowance for this person for that year yet. Don't estimate one from the policy; suggest asking HR." };
      }
      return b;
    },
  });

export const checkLeaveDatesTool = (leave: LeaveService) =>
  defineTool({
    name: "check_leave_dates",
    description:
      "Plan time off for the current user without booking it: counts working days between two dates (skipping " +
      "weekends and company holidays), shows holidays in the range, clashes with existing leave, and the balance " +
      "before and after. Resolve relative dates like 'next Friday' with get_current_time first.",
    schema: z.object({
      startDate: DATE.describe("First day off, YYYY-MM-DD"),
      endDate: DATE.describe("Last day off, YYYY-MM-DD"),
      leaveType: z.enum(TYPES).optional().describe("Defaults to ANNUAL"),
    }),
    async execute({ startDate, endDate, leaveType }, ctx) {
      return leave.planDates(ctx.userId, startDate, endDate, leaveType);
    },
  });
