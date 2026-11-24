import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { ApiErrorBody } from "@localmind/shared";
import type { AppConfig } from "./config/env.js";
import { createServices, type ServiceOverrides, type Services } from "./container.js";
import { AppError, UpstreamError, unauthorized } from "./lib/errors.js";
import type { AccessPrincipal } from "./modules/access/access.policy.js";
import { toPrincipal, type UserProfile } from "./modules/access/access.service.js";
import { adminRoutes } from "./modules/admin/admin.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { chatRoutes } from "./modules/chat/chat.routes.js";
import { documentRoutes } from "./modules/documents/documents.routes.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { toolRoutes } from "./modules/tools/tools.routes.js";

export type CurrentUser = UserProfile;

declare module "fastify" {
  interface FastifyInstance {
    services: Services;
    authenticate: (req: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    currentUser: CurrentUser;
    /** Identity used for every access decision (documents, retrieval, tools). */
    principal: AccessPrincipal;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

export interface BuildAppOptions {
  overrides?: ServiceOverrides;
  /** Disable request logging (tests). */
  logger?: boolean;
}

export async function buildApp(config: AppConfig, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: ["req.headers.authorization", "req.headers.cookie"],
          },
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });

  const services = createServices(config, app.log, opts.overrides);
  app.decorate("services", services);
  app.decorateRequest("currentUser", null as unknown as CurrentUser);
  app.decorateRequest("principal", null as unknown as AccessPrincipal);

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } });
  await app.register(cors, {
    origin: config.corsOrigins,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["authorization", "content-type"],
    maxAge: 600,
  });
  // Per-route limits (auth, chat, upload) are declared in each route's config.
  if (config.rateLimitEnabled) await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(jwt, { secret: config.auth.jwtSecret, sign: { expiresIn: config.auth.jwtExpiresIn } });
  await app.register(multipart, {
    limits: { fileSize: config.rag.maxUploadBytes, files: 1, fields: 5, parts: 6 },
  });

  app.decorate("authenticate", async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw unauthorized("Invalid or expired token");
    }
    // Look the user up on every request so deletions, role, clearance and
    // group changes take effect immediately (they are not baked into the JWT).
    const user = await services.access.loadProfile(req.user.sub);
    if (!user) throw unauthorized("Account no longer exists");
    req.currentUser = user;
    req.principal = toPrincipal(user);
  });

  app.setErrorHandler((err, req, reply) => {
    const send = (status: number, body: ApiErrorBody) => reply.code(status).send(body);
    if (err instanceof AppError) {
      return send(err.statusCode, { error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    if (err instanceof UpstreamError) {
      req.log.error({ err }, "upstream failure");
      return send(err.timedOut ? 504 : 502, { error: "UPSTREAM_ERROR", message: err.message });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    // Prisma: record vanished mid-request (e.g. conversation deleted during a chat turn).
    if (e.code === "P2025" || e.code === "P2003") return send(404, { error: "NOT_FOUND", message: "Resource not found" });
    if (e.statusCode === 429) return send(429, { error: "RATE_LIMITED", message: e.message ?? "Too many requests" });
    if (e.code === "FST_REQ_FILE_TOO_LARGE") return send(413, { error: "PAYLOAD_TOO_LARGE", message: "File is too large" });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return send(e.statusCode, { error: e.code ?? "BAD_REQUEST", message: e.message ?? "Bad request" });
    }
    req.log.error({ err }, "unhandled error");
    return send(500, { error: "INTERNAL_ERROR", message: "Internal server error" });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: "NOT_FOUND", message: `Route ${req.method} ${req.url} not found` } satisfies ApiErrorBody),
  );

  await app.register(healthRoutes, { prefix: "/api/health" });
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(chatRoutes, { prefix: "/api/chat" });
  await app.register(documentRoutes, { prefix: "/api/documents" });
  await app.register(toolRoutes, { prefix: "/api/tools" });
  await app.register(adminRoutes, { prefix: "/api/admin" });

  app.addHook("onClose", async () => {
    await services.ingestion.onIdle();
    await services.prisma.$disconnect();
  });

  return app;
}
