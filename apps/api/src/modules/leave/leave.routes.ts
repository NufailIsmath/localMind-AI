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

  // ----- HR team / admins -----
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
    return reply.code(201).send(await leave.addEntry(req.principal, body));
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
