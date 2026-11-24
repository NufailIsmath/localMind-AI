import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ChatStreamEvent } from "@localmind/shared";
import { AppError, UpstreamError } from "../../lib/errors.js";
import { UuidParam, parse } from "../../lib/validation.js";

const ChatBody = z.object({
  conversationId: z.uuid().optional(),
  message: z.string().trim().min(1, "Message is required").max(8000),
});

const chatRateLimit = { rateLimit: { max: 30, timeWindow: "1 minute" } };

export const chatRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.post("/", { config: chatRateLimit }, async (req, reply) => {
    const body = parse(ChatBody, req.body);
    // Stop generating if the client goes away before we answer.
    const controller = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    return app.services.orchestrator.run({
      user: { id: req.currentUser.id, role: req.currentUser.role },
      conversationId: body.conversationId,
      message: body.message,
      signal: controller.signal,
    });
  });

  /**
   * Server-Sent Events variant: streams tokens and tool activity as they
   * happen. POST (not EventSource) so the message and auth header can be sent.
   */
  app.post("/stream", { config: chatRateLimit }, async (req, reply) => {
    const body = parse(ChatBody, req.body);
    const controller = new AbortController();

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (event: ChatStreamEvent) => {
      if (!res.writableEnded) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const heartbeat = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), 15_000);
    res.on("close", () => {
      clearInterval(heartbeat);
      if (!res.writableFinished) controller.abort();
    });

    try {
      await app.services.orchestrator.run({
        user: { id: req.currentUser.id, role: req.currentUser.role },
        conversationId: body.conversationId,
        message: body.message,
        signal: controller.signal,
        onEvent: send,
      });
    } catch (err) {
      if (!controller.signal.aborted) {
        req.log.error({ err }, "chat stream failed");
        send({ type: "error", message: clientMessage(err) });
      }
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });

  app.get("/", async (req) => app.services.chatRepository.listConversations(req.currentUser.id));

  app.get("/:id", async (req) => {
    const { id } = parse(UuidParam, req.params);
    return app.services.chatRepository.getConversation(req.currentUser.id, id);
  });

  app.delete("/:id", async (req, reply) => {
    const { id } = parse(UuidParam, req.params);
    await app.services.chatRepository.deleteConversation(req.currentUser.id, id);
    return reply.code(204).send();
  });
};

function clientMessage(err: unknown): string {
  if (err instanceof AppError) return err.message;
  if (err instanceof UpstreamError) return `The AI backend is unavailable (${err.message}).`;
  return "Something went wrong while generating the answer.";
}
