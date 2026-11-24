import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuditEventDto, GroupDto } from "@localmind/shared";
import { forbidden } from "../../lib/errors.js";
import { UuidParam, parse } from "../../lib/validation.js";
import { CLASSIFICATIONS } from "../access/access.policy.js";

const toGroupDto = (g: { id: string; name: string; description: string | null; createdAt: Date; memberCount: number; documentCount: number }): GroupDto => ({
  ...g,
  createdAt: g.createdAt.toISOString(),
});

/** Organisation administration: groups, user clearance/membership, audit log. ADMIN only. */
export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    if (req.principal.role !== "ADMIN") throw forbidden("Administrator access required");
  });
  const { access } = app.services;

  app.get("/users", async () =>
    (await access.listUsers()).map((u) => ({ ...u, createdAt: u.createdAt.toISOString() })),
  );

  /** Add a person (the normal path when self-service sign-up is closed). */
  app.post("/users", async (req, reply) => {
    const body = parse(
      z.object({
        email: z.email().max(254),
        password: z.string().min(12, "Temporary password must be at least 12 characters").max(256),
        role: z.enum(["USER", "ADMIN"]).default("USER"),
        clearance: z.enum(CLASSIFICATIONS).default("INTERNAL"),
        groupIds: z.array(z.uuid()).max(100).default([]),
      }),
      req.body,
    );
    const user = await app.services.auth.createUser(body);
    await access.audit(req.principal.userId, "user.created", "user", user.id, { email: user.email, role: body.role, clearance: body.clearance });
    const u = body.groupIds.length
      ? await access.updateUser(req.principal, user.id, { groupIds: body.groupIds })
      : (await access.listUsers()).find((x) => x.id === user.id)!;
    return reply.code(201).send({ ...u, createdAt: u.createdAt.toISOString() });
  });

  app.patch("/users/:id", async (req) => {
    const { id } = parse(UuidParam, req.params);
    const body = parse(
      z.object({
        role: z.enum(["USER", "ADMIN"]).optional(),
        clearance: z.enum(CLASSIFICATIONS).optional(),
        groupIds: z.array(z.uuid()).max(100).optional(),
      }),
      req.body ?? {},
    );
    const u = await access.updateUser(req.principal, id, body);
    return { ...u, createdAt: u.createdAt.toISOString() };
  });

  app.get("/groups", async () => (await access.listGroups()).map(toGroupDto));

  app.post("/groups", async (req, reply) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(60).regex(/^[\p{L}\p{N} _&-]+$/u, "Use letters, numbers, spaces, - _ &"),
        description: z.string().trim().max(200).optional(),
      }),
      req.body,
    );
    return reply.code(201).send(toGroupDto(await access.createGroup(req.principal, body.name, body.description)));
  });

  app.delete("/groups/:id", async (req, reply) => {
    const { id } = parse(UuidParam, req.params);
    await access.deleteGroup(req.principal, id);
    return reply.code(204).send();
  });

  app.get("/audit", async (req): Promise<AuditEventDto[]> => {
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return access.listAudit(limit);
  });
};
