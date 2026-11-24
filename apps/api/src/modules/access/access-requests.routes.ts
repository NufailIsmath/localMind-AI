import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { UuidParam, parse } from "../../lib/validation.js";

export const accessRequestRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  const { accessRequests } = app.services;

  /** Raise a request from a "that's confidential" notice shown in a chat answer. */
  app.post("/", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = parse(
      z.object({ messageId: z.uuid(), noticeId: z.string().regex(/^R\d{1,3}$/), note: z.string().max(500).optional() }),
      req.body,
    );
    return reply.code(201).send(await accessRequests.create(req.principal, body));
  });

  app.get("/", async (req) => accessRequests.list(req.principal));

  app.post("/:id/approve", async (req) => accessRequests.decide(req.principal, parse(UuidParam, req.params).id, true));
  app.post("/:id/deny", async (req) => accessRequests.decide(req.principal, parse(UuidParam, req.params).id, false));
};
