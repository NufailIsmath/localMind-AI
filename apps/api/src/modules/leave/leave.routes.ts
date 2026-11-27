import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { UuidParam, parse } from "../../lib/validation.js";
import { LEAVE_TYPES } from "./leave.service.js";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const YEAR = z.coerce.number().int().min(2000).max(2100);
const DAYS = z.number().min(-400).max(400).refine((n) => Number.isInteger(n * 2), "Use whole or half days");

export const leaveRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  const { leave } = app.services;

  // ----- self-service: only ever the caller's own records -----
  app.get("/me", async (req) => {
    const { year } = parse(z.object({ year: YEAR.optional() }), req.query);
    return leave.myBalance(req.principal.userId, year);
  });

  app.get("/plan", async (req) => {
    const q = parse(z.object({ startDate: DATE, endDate: DATE, leaveType: z.enum(LEAVE_TYPES).optional() }), req.query);
    return leave.planDates(req.principal.userId, q.startDate, q.endDate, q.leaveType);
  });

  app.get("/holidays", async (req) => {
    const { year } = parse(z.object({ year: YEAR }), req.query);
    return leave.listHolidays(year);
  });

  /**
   * Submit a leave request. Either from a chat card ({ messageId, actionId }:
   * the server re-reads the card the assistant prepared and submits exactly
   * that) or directly ({ leaveType, startDate, endDate, note }).
   */
  app.post("/requests", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = parse(
      z.union([
        z.object({ messageId: z.uuid(), actionId: z.string().regex(/^A\d{1,3}$/) }),
        z.object({ leaveType: z.enum(LEAVE_TYPES).default("ANNUAL"), startDate: DATE, endDate: DATE, note: z.string().trim().max(500).optional() }),
      ]),
      req.body,
    );
    if ("messageId" in body) {
      const msg = await app.services.prisma.message.findFirst({
        where: { id: body.messageId, role: "ASSISTANT", conversation: { userId: req.principal.userId } },
        select: { actions: true },
      });
      const action = ((msg?.actions as { id: string; kind: string; leaveType: (typeof LEAVE_TYPES)[number]; startDate: string; endDate: string; note: string | null }[] | null) ?? []).find(
        (a) => a.id === body.actionId && a.kind === "leave_request",
      );
      if (!action) return reply.code(404).send({ error: "NOT_FOUND", message: "Request card not found" });
      return reply.code(201).send(
        await leave.createRequest(req.principal.userId, {
          ...action,
          note: await app.services.moderation.screenNote(action.note ?? undefined) ?? null,
          actionRef: `${body.messageId}:${body.actionId}`,
        }),
      );
    }
    return reply.code(201).send(await leave.createRequest(req.principal.userId, { ...body, note: await app.services.moderation.screenNote(body.note) }));
  });

  /** Withdraw a pending request / cancel your own future leave. */
  app.post("/requests/:id/cancel", async (req) => {
    const { id } = parse(UuidParam, req.params);
    return leave.cancelOwn(req.principal.userId, id);
  });

  // ----- HR team / admins -----
  app.get("/manage/requests", async (req) => {
    const { status } = parse(z.object({ status: z.enum(["PENDING", "DECIDED"]).default("PENDING") }), req.query);
    return leave.listRequests(req.principal, status);
  });

  app.post("/manage/requests/:id/approve", async (req) => {
    const { id } = parse(UuidParam, req.params);
    const { note } = parse(z.object({ note: z.string().trim().max(500).optional() }), req.body ?? {});
    return leave.decide(req.principal, id, true, await app.services.moderation.screenNote(note));
  });

  app.post("/manage/requests/:id/reject", async (req) => {
    const { id } = parse(UuidParam, req.params);
    const { note } = parse(z.object({ note: z.string().trim().max(500).optional() }), req.body ?? {});
    return leave.decide(req.principal, id, false, await app.services.moderation.screenNote(note));
  });

  app.get("/manage/people", async (req) => {
    const { year } = parse(z.object({ year: YEAR }), req.query);
    return leave.people(req.principal, year);
  });

  app.put("/manage/allowances", async (req, reply) => {
    const body = parse(
      z.object({
        userId: z.uuid(),
        year: z.number().int().min(2000).max(2100),
        leaveType: z.enum(LEAVE_TYPES),
        entitledDays: DAYS.refine((n) => n >= 0, "Must be zero or more"),
        carriedOverDays: DAYS.refine((n) => n >= 0, "Must be zero or more").optional(),
        carryOverExpiresOn: DATE.nullable().optional(),
        adjustmentDays: DAYS.optional(),
        note: z.string().max(200).nullable().optional(),
      }),
      req.body,
    );
    await leave.upsertAllowance(req.principal, body);
    return reply.code(204).send();
  });

  app.post("/manage/entries", async (req, reply) => {
    const body = parse(
      z.object({
        userId: z.uuid(),
        leaveType: z.enum(LEAVE_TYPES),
        startDate: DATE,
        endDate: DATE,
        days: DAYS.refine((n) => n > 0, "Must be more than zero").optional(),
        note: z.string().max(200).nullable().optional(),
      }),
      req.body,
    );
    return reply.code(201).send(await leave.addEntry(req.principal, { ...body, note: body.note == null ? body.note : await app.services.moderation.screenNote(body.note) }));
  });

  app.delete("/manage/entries/:id", async (req, reply) => {
    const { id } = parse(UuidParam, req.params);
    await leave.cancelEntry(req.principal, id);
    return reply.code(204).send();
  });

  app.post("/manage/holidays", async (req, reply) => {
    const body = parse(z.object({ date: DATE, name: z.string().trim().min(1).max(80) }), req.body);
    await leave.addHoliday(req.principal, body.date, body.name);
    return reply.code(201).send();
  });

  app.delete("/manage/holidays/:date", async (req, reply) => {
    const { date } = parse(z.object({ date: DATE }), req.params);
    await leave.removeHoliday(req.principal, date);
    return reply.code(204).send();
  });

  /** CSV import (text body, ≤ 1 MB): all rows are validated before anything is saved. */
  app.post("/manage/import", async (req) => {
    const body = parse(z.object({ kind: z.enum(["allowances", "entries"]), csv: z.string().min(1).max(900_000) }), req.body);
    return leave.importCsv(req.principal, body.kind, body.csv);
  });
};
