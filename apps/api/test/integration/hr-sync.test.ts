import type { GroupDto, LeaveEntryDto } from "@clbuddy/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockHr } from "../helpers/mock-hr-server.js";
import { auth, createHarness, infraReady, type Harness } from "./harness.js";

describe.runIf(infraReady)("sync with the external HR leave system", () => {
  let h: Harness;
  let hr: Awaited<ReturnType<typeof startMockHr>>;
  const t = {} as Record<"admin" | "lead" | "sam", string>;
  const id = {} as Record<keyof typeof t, string>;
  const api = (who: keyof typeof t, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
    h.app.inject({ method, url, headers: auth(t[who]), ...(payload ? { payload } : {}) });
  const sync = () => h.app.services.hrSync.processDue();
  const outbox = () => h.app.services.prisma.hrSyncEvent.findMany({ orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    hr = await startMockHr();
    h = await createHarness({ HR_SYNC_ENABLED: "true", HR_API_BASE_URL: hr.url, HR_API_TOKEN: "test-token", HR_SYNC_INTERVAL_MS: "0", HR_SYNC_MAX_ATTEMPTS: "3" });
    await h.app.services.prisma.hrSyncEvent.deleteMany();
    for (const who of ["admin", "lead", "sam"] as const) {
      const r = await h.register(`${who}@corp.test`);
      t[who] = r.token;
      id[who] = r.user.id;
    }
    const g = (await api("admin", "POST", "/api/admin/groups", { name: "HR" })).json<GroupDto>().id;
    await api("admin", "PATCH", `/api/admin/users/${id.lead}`, { groupIds: [g] });
    await api("admin", "PUT", "/api/leave/manage/allowances", { userId: id.sam, year: 2031, leaveType: "ANNUAL", entitledDays: 20 });
  });
  afterAll(async () => {
    await h?.close();
    await hr?.close();
  });

  let requestId: string;

  it("sends a submitted request with auth and an idempotency key, and stores the HR system's id", async () => {
    const r = (await api("sam", "POST", "/api/leave/requests", { leaveType: "ANNUAL", startDate: "2031-03-03", endDate: "2031-03-05", note: "Family trip" })).json<LeaveEntryDto>();
    requestId = r.id;
    expect(hr.calls).toHaveLength(0); // written to the outbox, delivered in the background
    expect(await sync()).toBe(1);
    expect(hr.calls[0]).toMatchObject({
      method: "POST",
      path: "/v1/leave-requests",
      headers: expect.objectContaining({ authorization: "Bearer test-token", "content-type": "application/json" }),
      body: {
        clbuddy_leave_id: r.id,
        employee_email: "sam@corp.test",
        leave_type: "annual",
        start_date: "2031-03-03",
        end_date: "2031-03-05",
        days: 3,
        note: "Family trip",
        status: "pending",
        submitted_at: expect.any(String),
      },
    });
    const [ev] = await outbox();
    expect(hr.calls[0]!.headers["idempotency-key"]).toBe(ev!.id);
    expect(ev).toMatchObject({ status: "SENT", attempts: 1 });
    expect((await h.app.services.prisma.leaveEntry.findUnique({ where: { id: r.id } }))?.externalId).toBe("HR-1");
  });

  it("sends the approval to the HR system's record for that request", async () => {
    await api("lead", "POST", `/api/leave/manage/requests/${requestId}/approve`, { note: "Enjoy" });
    await sync();
    expect(hr.calls.at(-1)).toMatchObject({
      path: "/v1/leave-requests/HR-1/decision",
      body: { decision: "approved", note: "Enjoy", decided_by: "lead@corp.test", decided_at: expect.any(String) },
    });
  });

  it("retries transient failures with back-off, then delivers (same idempotency key)", async () => {
    hr.failNext(1, 503);
    await api("sam", "POST", `/api/leave/requests/${requestId}/cancel`);
    await sync();
    const ev = (await outbox()).at(-1)!;
    expect(ev).toMatchObject({ eventType: "leave.cancelled", status: "PENDING", attempts: 1, lastError: expect.stringContaining("503") });
    expect(ev.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000); // backed off
    await h.app.services.prisma.hrSyncEvent.update({ where: { id: ev.id }, data: { nextAttemptAt: new Date() } }); // fast-forward
    await sync();
    const calls = hr.calls.filter((c) => c.path === "/v1/leave-requests/HR-1/cancel");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers["idempotency-key"]).toBe(calls[1]!.headers["idempotency-key"]);
    expect((await outbox()).at(-1)).toMatchObject({ status: "SENT", attempts: 2 });
  });

  it("keeps per-leave order: a decision waits until its request has been delivered", async () => {
    hr.failNext(1, 503);
    const r = (await api("sam", "POST", "/api/leave/requests", { leaveType: "ANNUAL", startDate: "2031-05-05", endDate: "2031-05-05" })).json<LeaveEntryDto>();
    await api("lead", "POST", `/api/leave/manage/requests/${r.id}/reject`, { note: "Busy week" });
    await sync(); // submit fails (503) → the rejection must not be sent before it
    expect(hr.calls.some((c) => c.path.includes("/decision") && c.body?.decision === "rejected")).toBe(false);
    await h.app.services.prisma.hrSyncEvent.updateMany({ where: { status: "PENDING" }, data: { nextAttemptAt: new Date() } });
    await sync();
    await h.app.services.prisma.hrSyncEvent.updateMany({ where: { status: "PENDING" }, data: { nextAttemptAt: new Date() } });
    await sync();
    const order = hr.calls.filter((c) => c.body?.clbuddy_leave_id === r.id || c.path.startsWith("/v1/leave-requests/HR-2"));
    expect(order.map((c) => c.path)).toEqual(["/v1/leave-requests", "/v1/leave-requests", "/v1/leave-requests/HR-2/decision"]);
    expect(order.at(-1)!.body).toMatchObject({ decision: "rejected", note: "Busy week" });
  });

  it("marks non-retryable rejections FAILED, shows them to admins, and lets them retry", async () => {
    hr.failNext(1, 422);
    await api("lead", "POST", "/api/leave/manage/entries", { userId: id.sam, leaveType: "SICK", startDate: "2031-06-02", endDate: "2031-06-02" });
    await sync();
    const status = (await api("admin", "GET", "/api/admin/integrations/hr")).json();
    expect(status).toMatchObject({ enabled: true, counts: expect.objectContaining({ FAILED: 1 }) });
    expect(status.failures[0]).toMatchObject({ eventType: "leave.recorded", employeeEmail: "sam@corp.test", lastError: expect.stringContaining("422") });
    expect((await api("lead", "GET", "/api/admin/integrations/hr")).statusCode).toBe(403);

    expect((await api("admin", "POST", `/api/admin/integrations/hr/events/${status.failures[0].id}/retry`)).statusCode).toBe(204);
    expect((await api("admin", "POST", "/api/admin/integrations/hr/sync")).json()).toEqual({ delivered: 1 });
    expect(hr.calls.at(-1)).toMatchObject({ path: "/v1/leave-records", body: { leave_type: "sick", status: "approved", days: 1 } });
  });

  it("gives up after HR_SYNC_MAX_ATTEMPTS and reports a timeout/unreachable host clearly", async () => {
    hr.failNext(3, 500);
    const r = (await api("sam", "POST", "/api/leave/requests", { leaveType: "ANNUAL", startDate: "2031-07-07", endDate: "2031-07-07" })).json<LeaveEntryDto>();
    for (let i = 0; i < 3; i++) {
      await h.app.services.prisma.hrSyncEvent.updateMany({ where: { status: "PENDING" }, data: { nextAttemptAt: new Date() } });
      await sync();
    }
    const ev = await h.app.services.prisma.hrSyncEvent.findFirst({ where: { entryId: r.id } });
    expect(ev).toMatchObject({ status: "FAILED", attempts: 3 });
  });
});

describe.runIf(infraReady)("HR sync switched off (the default)", () => {
  it("records nothing and calls nothing", async () => {
    const hr = await startMockHr();
    const h = await createHarness({ HR_API_BASE_URL: hr.url, HR_SYNC_INTERVAL_MS: "0" }, { reset: false });
    try {
      const before = await h.app.services.prisma.hrSyncEvent.count();
      const u = await h.register();
      await h.app.services.prisma.leaveAllowance.create({ data: { userId: u.user.id, year: 2031, leaveType: "ANNUAL", entitledHalfDays: 10 } });
      const res = await h.app.inject({ method: "POST", url: "/api/leave/requests", headers: auth(u.token), payload: { leaveType: "ANNUAL", startDate: "2031-08-04", endDate: "2031-08-04" } });
      expect(res.statusCode).toBe(201); // the leave change itself happened…
      expect(await h.app.services.hrSync.processDue()).toBe(0);
      expect(await h.app.services.prisma.hrSyncEvent.count()).toBe(before); // …but nothing was queued
      expect(hr.calls).toEqual([]);
      expect(h.app.services.hrSync.enabled).toBe(false);
    } finally {
      await h.close();
      await hr.close();
    }
  });
});
