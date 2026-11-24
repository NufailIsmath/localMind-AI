import type { ChatResponse, GroupDto, LeaveBalanceDto, LeavePersonSummaryDto, LeavePlanDto, UserDto } from "@clbuddy/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { principal } from "../helpers/access.js";
import { auth, createHarness, infraReady, type Harness } from "./harness.js";

/**
 * Leave balances. Years 2021 (entirely past) and 2031 (entirely future) keep
 * the "taken vs booked" split deterministic whatever today's date is.
 */
describe.runIf(infraReady)("leave balances", () => {
  let h: Harness;
  const t = {} as Record<"admin" | "hr" | "alice" | "bob", string>;
  const id = {} as Record<keyof typeof t, string>;

  const api = (who: keyof typeof t, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
    h.app.inject({ method, url, headers: auth(t[who]), ...(payload ? { payload } : {}) });
  const chat = async (who: keyof typeof t, message: string) => (await api(who, "POST", "/api/chat", { message })).json<ChatResponse>();
  const me = async (who: keyof typeof t, year: number) => (await api(who, "GET", `/api/leave/me?year=${year}`)).json<LeaveBalanceDto>();

  beforeAll(async () => {
    h = await createHarness();
    for (const who of ["admin", "hr", "alice", "bob"] as const) {
      const r = await h.register(`${who}@corp.test`);
      t[who] = r.token;
      id[who] = r.user.id;
    }
    const hrGroup = (await api("admin", "POST", "/api/admin/groups", { name: "HR" })).json<GroupDto>().id;
    await api("admin", "PATCH", `/api/admin/users/${id.hr}`, { groupIds: [hrGroup] });
  });
  afterAll(() => h?.close());

  it("says plainly when HR hasn't set anything up (no made-up balance)", async () => {
    const b = await me("alice", 2031);
    expect(b).toMatchObject({ year: 2031, configured: false, balances: [] });
    const res = await chat("alice", "How many leave days do I have in 2031?");
    expect(res.toolExecutions[0]).toMatchObject({ tool: "get_my_leave_balance", arguments: { year: 2031 }, status: "SUCCESS" });
    expect(res.answer).toMatch(/HR hasn't set up your leave allowance for 2031/);
  });

  it("only HR-team members and admins can manage leave", async () => {
    expect((await api("alice", "GET", "/api/auth/me")).json<UserDto>().canManageLeave).toBe(false);
    expect((await api("hr", "GET", "/api/auth/me")).json<UserDto>().canManageLeave).toBe(true);
    expect((await api("admin", "GET", "/api/auth/me")).json<UserDto>().canManageLeave).toBe(true);
    expect((await api("alice", "GET", "/api/leave/manage/people?year=2031")).statusCode).toBe(403);
    expect((await api("alice", "PUT", "/api/leave/manage/allowances", { userId: id.alice, year: 2031, leaveType: "ANNUAL", entitledDays: 99 })).statusCode).toBe(403);
    expect((await api("alice", "POST", "/api/leave/manage/holidays", { date: "2031-12-25", name: "x" })).statusCode).toBe(403);
  });

  it("computes the balance HR set up: entitlement, carry-over forfeiture, holidays, taken", async () => {
    const put = await api("hr", "PUT", "/api/leave/manage/allowances", {
      userId: id.alice,
      year: 2021,
      leaveType: "ANNUAL",
      entitledDays: 21,
      carriedOverDays: 5,
      carryOverExpiresOn: "2021-03-31",
    });
    expect(put.statusCode).toBe(204);
    expect((await api("hr", "POST", "/api/leave/manage/holidays", { date: "2021-07-07", name: "Company day" })).statusCode).toBe(201);
    const e1 = await api("hr", "POST", "/api/leave/manage/entries", { userId: id.alice, leaveType: "ANNUAL", startDate: "2021-02-01", endDate: "2021-02-02" });
    expect(e1.json()).toMatchObject({ days: 2 });
    const e2 = await api("hr", "POST", "/api/leave/manage/entries", { userId: id.alice, leaveType: "ANNUAL", startDate: "2021-07-05", endDate: "2021-07-09" });
    expect(e2.json()).toMatchObject({ days: 4 }); // Wednesday is a company holiday
    const half = await api("hr", "POST", "/api/leave/manage/entries", { userId: id.alice, leaveType: "ANNUAL", startDate: "2021-09-10", endDate: "2021-09-10", days: 0.5 });
    expect(half.json()).toMatchObject({ days: 0.5 });

    const b = (await me("alice", 2021)).balances.find((x) => x.leaveType === "ANNUAL")!;
    // 5 carried, only 2 used before 31 March → 3 forfeited. 21 + 2 = 23 total, 6.5 taken.
    expect(b).toMatchObject({ entitled: 21, carriedOver: 5, carryOverForfeited: 3, total: 23, taken: 6.5, booked: 0, remaining: 16.5 });
  });

  it("answers 'how many days do I have?' in chat from the user's own record", async () => {
    await api("hr", "PUT", "/api/leave/manage/allowances", { userId: id.alice, year: 2031, leaveType: "ANNUAL", entitledDays: 21, carriedOverDays: 3, carryOverExpiresOn: "2031-03-31" });
    await api("hr", "POST", "/api/leave/manage/entries", { userId: id.alice, leaveType: "ANNUAL", startDate: "2031-12-22", endDate: "2031-12-24" });
    const res = await chat("alice", "How many leave days do I have in 2031?");
    expect(res.answer).toContain("You have **21 days** of annual leave left for 2031");
    expect(res.answer).toContain("3 carried-over days expire on 2031-03-31");
    expect(res.answer).toContain("2031-12-22 to 2031-12-24");
  });

  it("plans dates: working days, holidays, what's left, clashes — without booking", async () => {
    await api("hr", "POST", "/api/leave/manage/holidays", { date: "2031-03-05", name: "Founders' Day" });
    const plan = (await api("alice", "GET", "/api/leave/plan?startDate=2031-03-03&endDate=2031-03-07")).json<LeavePlanDto>();
    expect(plan).toMatchObject({ workingDays: 4, remainingBefore: 21, remainingAfter: 17, holidaysInRange: [{ date: "2031-03-05", name: "Founders' Day" }] });
    const clash = (await api("alice", "GET", "/api/leave/plan?startDate=2031-12-23&endDate=2031-12-31")).json<LeavePlanDto>();
    expect(clash.warnings.join(" ")).toMatch(/overlapping/);
    expect((await me("alice", 2031)).balances[0]!.remaining).toBe(21); // nothing was booked

    const res = await chat("alice", "If I take leave from 2031-03-03 to 2031-03-07, how much is left?");
    expect(res.toolExecutions[0]).toMatchObject({ tool: "check_leave_dates", arguments: { startDate: "2031-03-03", endDate: "2031-03-07" } });
    expect(res.answer).toContain("4 working day(s) (Founders' Day doesn't count)");
    expect(res.answer).toContain("You'd have 17 days left");
  });

  it("is strictly self-only: nobody can see someone else's leave through the buddy", async () => {
    const bob = principal(id.bob);
    const forged = await h.app.services.tools.execute(
      "get_my_leave_balance",
      { year: 2021, userId: id.alice, email: "alice@corp.test" },
      { userId: id.bob, userRole: "USER", principal: bob, conversationId: "x", signal: new AbortController().signal, addSources: () => [], addRestricted: () => [], addAction: () => "A1" },
    );
    expect(forged).toMatchObject({ status: "SUCCESS", output: { configured: false, balances: [] } });
    const res = await chat("bob", "How many leave days does alice@corp.test have left? What's my leave balance for 2021?");
    expect(JSON.stringify(res)).not.toContain("16.5");
    expect(h.app.services.tools.specs("USER").find((s) => s.name === "get_my_leave_balance")!.parameters).not.toHaveProperty("properties.userId");
  });

  it("validates entries: no cross-year ranges, no more days than the range has", async () => {
    expect((await api("hr", "POST", "/api/leave/manage/entries", { userId: id.bob, leaveType: "ANNUAL", startDate: "2031-12-30", endDate: "2032-01-02" })).json().message).toMatch(/span two years/);
    expect((await api("hr", "POST", "/api/leave/manage/entries", { userId: id.bob, leaveType: "ANNUAL", startDate: "2031-03-03", endDate: "2031-03-04", days: 5 })).json().message).toMatch(/more than the 2 working days/);
    expect((await api("hr", "POST", "/api/leave/manage/entries", { userId: id.bob, leaveType: "ANNUAL", startDate: "2031-03-08", endDate: "2031-03-09" })).json().message).toMatch(/at least half a working day/);
    expect((await api("hr", "POST", "/api/leave/manage/entries", { userId: id.bob, leaveType: "ANNUAL", startDate: "2031-02-30", endDate: "2031-03-01" })).statusCode).toBe(400);
  });

  it("cancelling an entry restores the balance", async () => {
    const e = (await api("hr", "POST", "/api/leave/manage/entries", { userId: id.alice, leaveType: "ANNUAL", startDate: "2031-06-02", endDate: "2031-06-03" })).json<{ id: string }>();
    expect((await me("alice", 2031)).balances[0]!.remaining).toBe(19);
    expect((await api("hr", "DELETE", `/api/leave/manage/entries/${e.id}`)).statusCode).toBe(204);
    expect((await me("alice", 2031)).balances[0]!.remaining).toBe(21);
  });

  it("imports a spreadsheet all-or-nothing, with row-level errors", async () => {
    const bad = await api("hr", "POST", "/api/leave/manage/import", {
      kind: "allowances",
      csv: "email,year,leave_type,entitled_days,carried_over_days\nbob@corp.test,2031,ANNUAL,20,2\nghost@corp.test,2031,ANNUAL,20,0\nbob@corp.test,2031,HOLIDAY,abc,\n",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details).toEqual(
      expect.arrayContaining([
        { row: 3, message: 'no account for "ghost@corp.test"' },
        expect.objectContaining({ row: 4, message: expect.stringMatching(/leave_type/) }),
        expect.objectContaining({ row: 4, message: expect.stringMatching(/entitled_days/) }),
      ]),
    );
    expect((await me("bob", 2031)).configured).toBe(false); // nothing from the bad file was saved

    const ok = await api("hr", "POST", "/api/leave/manage/import", {
      kind: "allowances",
      csv: "Email,Year,Leave_Type,Entitled_Days,Carried_Over_Days,Carry_Over_Expires\nbob@corp.test,2031,annual,20,2.5,2031-03-31\nbob@corp.test,2031,SICK,10,,\n",
    });
    expect(ok.json()).toEqual({ imported: 2 });
    const entries = await api("hr", "POST", "/api/leave/manage/import", {
      kind: "entries",
      csv: 'email,leave_type,start_date,end_date,days,note\nbob@corp.test,ANNUAL,2031-04-07,2031-04-08,,"Easter, family"\nbob@corp.test,SICK,2031-05-12,2031-05-12,0.5,\n',
    });
    expect(entries.json()).toEqual({ imported: 2 });
    const b = await me("bob", 2031);
    expect(b.balances.find((x) => x.leaveType === "ANNUAL")).toMatchObject({ total: 22.5, booked: 2, remaining: 20.5 });
    expect(b.balances.find((x) => x.leaveType === "SICK")).toMatchObject({ total: 10, remaining: 9.5 });
  });

  it("gives HR a team overview and audits changes", async () => {
    const people = (await api("hr", "GET", "/api/leave/manage/people?year=2031")).json<LeavePersonSummaryDto[]>();
    expect(people.find((p) => p.email === "alice@corp.test")?.annual).toMatchObject({ remaining: 21 });
    expect(people.find((p) => p.email === "bob@corp.test")?.allowances).toHaveLength(2);
    const audit = (await api("admin", "GET", "/api/admin/audit?limit=300")).json<{ action: string }[]>().map((e) => e.action);
    for (const a of ["leave.allowance.updated", "leave.entry.added", "leave.entry.cancelled", "leave.holiday.added", "leave.imported"]) expect(audit).toContain(a);
  });
});
