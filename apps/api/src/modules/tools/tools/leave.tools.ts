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

/**
 * Prepares a leave request for the user to CONFIRM. It does not submit
 * anything: it attaches an action card with a "Submit request" button, and
 * only the user's click (an authenticated API call) creates the request. So a
 * prompt-injected model can at most show a card the user can ignore.
 */
export const proposeLeaveRequestTool = (leave: LeaveService) =>
  defineTool({
    name: "propose_leave_request",
    description:
      "Prepare a leave request for the current user to review and submit with one click. It does NOT submit the request — " +
      "the user must press 'Submit request' on the card. Use when they want to book or request time off. Resolve relative " +
      "dates with get_current_time first.",
    schema: z.object({
      startDate: DATE.describe("First day off, YYYY-MM-DD"),
      endDate: DATE.describe("Last day off, YYYY-MM-DD"),
      leaveType: z.enum(TYPES).optional().describe("Defaults to ANNUAL"),
      note: z.string().trim().max(300).optional().describe("Optional short reason for HR"),
    }),
    async execute({ startDate, endDate, leaveType, note }, ctx) {
      const plan = await leave.planDates(ctx.userId, startDate, endDate, leaveType);
      if (!plan.requestable) {
        return { prepared: false, reason: plan.warnings, plan, note: "Explain the problem and suggest alternatives; no card was shown." };
      }
      const actionId = ctx.addAction({
        kind: "leave_request",
        leaveType: plan.leaveType,
        startDate,
        endDate,
        workingDays: plan.workingDays,
        availableAfter: plan.availableAfter,
        warnings: plan.warnings,
        note: note ?? null,
      });
      return {
        prepared: true,
        actionId,
        plan,
        instruction: "A request card is shown under your reply. Tell the user to check it and press 'Submit request'; it goes to HR for approval. Don't say it has been submitted.",
      };
    },
  });
