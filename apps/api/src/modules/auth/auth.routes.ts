import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AuthResponse } from "@clbuddy/shared";
import { toUserDto } from "./auth.service.js";
import { toPrincipal } from "../access/access.service.js";
import { parse } from "../../lib/validation.js";

const Credentials = z.object({
  email: z.email().max(254),
  password: z.string().min(8, "Password must be at least 8 characters").max(256),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  const userDto = async (id: string) => {
    const profile = (await app.services.access.loadProfile(id))!;
    return toUserDto(profile, await app.services.leave.canManage(toPrincipal(profile)));
  };
  const authRateLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

  app.post("/register", { config: authRateLimit }, async (req, reply) => {
    const { email, password } = parse(Credentials, req.body);
    const user = await app.services.auth.register(email, password);
    const token = await reply.jwtSign({ sub: user.id });
    const body: AuthResponse = { token, user: await userDto(user.id) };
    return reply.code(201).send(body);
  });

  app.post("/login", { config: authRateLimit }, async (req, reply) => {
    const { email, password } = parse(Credentials.extend({ password: z.string().min(1).max(256) }), req.body);
    const user = await app.services.auth.login(email, password);
    const token = await reply.jwtSign({ sub: user.id });
    const body: AuthResponse = { token, user: await userDto(user.id) };
    return body;
  });

  app.get("/me", { preHandler: app.authenticate }, async (req) => toUserDto(req.currentUser, await app.services.leave.canManage(req.principal)));
};
