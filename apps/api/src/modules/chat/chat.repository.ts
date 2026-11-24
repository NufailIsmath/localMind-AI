import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  ConversationDto,
  ConversationSummaryDto,
  MessageDto,
  Source,
  ToolExecutionStatus,
  ToolExecutionSummary,
} from "@clbuddy/shared";
import { notFound } from "../../lib/errors.js";
import type { StoredNotice } from "../access/access-requests.service.js";
import { toNoticeDto } from "../../ai/orchestrator.service.js";

export interface HistoryMessage {
  role: "USER" | "ASSISTANT";
  content: string;
}

export interface ToolExecutionRecord {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: ToolExecutionStatus;
  error?: string;
  durationMs: number;
}

/** Persistence port used by the orchestrator (makes it unit-testable without a DB). */
export interface ChatRepository {
  resolveConversation(userId: string, conversationId: string | undefined, title: string): Promise<{ id: string; created: boolean }>;
  loadHistory(conversationId: string, limit: number): Promise<HistoryMessage[]>;
  addUserMessage(conversationId: string, content: string): Promise<string>;
  addAssistantMessage(conversationId: string, content: string, sources: Source[], restricted?: StoredNotice[]): Promise<string>;
  recordToolExecution(conversationId: string, record: ToolExecutionRecord): Promise<void>;
  linkToolExecutions(ids: string[], messageId: string): Promise<void>;
}

export class PrismaChatRepository implements ChatRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async resolveConversation(userId: string, conversationId: string | undefined, title: string) {
    if (conversationId) {
      const conv = await this.prisma.conversation.findFirst({ where: { id: conversationId, userId }, select: { id: true } });
      // Same response for "doesn't exist" and "belongs to someone else".
      if (!conv) throw notFound("Conversation not found");
      return { id: conv.id, created: false };
    }
    const conv = await this.prisma.conversation.create({ data: { userId, title }, select: { id: true } });
    return { id: conv.id, created: true };
  }

  async loadHistory(conversationId: string, limit: number): Promise<HistoryMessage[]> {
    if (limit <= 0) return [];
    const rows = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { role: true, content: true },
    });
    return completedExchanges(rows.reverse());
  }

  async addUserMessage(conversationId: string, content: string): Promise<string> {
    const [msg] = await this.prisma.$transaction([
      this.prisma.message.create({ data: { conversationId, role: "USER", content }, select: { id: true } }),
      this.prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }),
    ]);
    return msg.id;
  }

  async addAssistantMessage(conversationId: string, content: string, sources: Source[], restricted: StoredNotice[] = []): Promise<string> {
    const [msg] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: {
          conversationId,
          role: "ASSISTANT",
          content,
          sources: sources as unknown as Prisma.InputJsonValue,
          ...(restricted.length ? { restricted: restricted as unknown as Prisma.InputJsonValue } : {}),
        },
        select: { id: true },
      }),
      this.prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }),
    ]);
    return msg.id;
  }

  async recordToolExecution(conversationId: string, r: ToolExecutionRecord): Promise<void> {
    await this.prisma.toolExecution.create({
      data: {
        id: r.id,
        conversationId,
        toolName: r.toolName,
        arguments: r.arguments as Prisma.InputJsonValue,
        status: r.status,
        error: r.error?.slice(0, 1000),
        durationMs: r.durationMs,
      },
    });
  }

  async linkToolExecutions(ids: string[], messageId: string): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.toolExecution.updateMany({ where: { id: { in: ids } }, data: { messageId } });
  }

  // ----- read models for the HTTP API -----

  async listConversations(userId: string, limit = 50): Promise<ConversationSummaryDto[]> {
    const rows = await this.prisma.conversation.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });
    return rows.map(toSummary);
  }

  async getConversation(
    userId: string,
    id: string,
    requestStatuses: (messageIds: string[]) => Promise<Map<string, "PENDING" | "APPROVED" | "DENIED">> = async () => new Map(),
  ): Promise<ConversationDto> {
    const conv = await this.prisma.conversation.findFirst({
      where: { id, userId },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          include: { toolExecutions: { orderBy: { createdAt: "asc" } } },
        },
      },
    });
    if (!conv) throw notFound("Conversation not found");
    const statuses = await requestStatuses(conv.messages.filter((m) => m.restricted).map((m) => m.id));
    return {
      ...toSummary(conv),
      messages: conv.messages.map(
        (m): MessageDto => ({
          id: m.id,
          role: m.role,
          content: m.content,
          sources: (m.sources as unknown as Source[] | null) ?? [],
          restricted: ((m.restricted as unknown as StoredNotice[] | null) ?? []).map((n) =>
            toNoticeDto(n, statuses.get(`${m.id}:${n.id}`) ?? null),
          ),
          toolExecutions: m.toolExecutions.map(
            (t): ToolExecutionSummary => ({
              id: t.id,
              tool: t.toolName,
              arguments: (t.arguments ?? {}) as Record<string, unknown>,
              status: t.status,
              durationMs: t.durationMs,
              ...(t.error ? { error: t.error } : {}),
            }),
          ),
          createdAt: m.createdAt.toISOString(),
        }),
      ),
    };
  }

  async deleteConversation(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.conversation.deleteMany({ where: { id, userId } });
    if (count === 0) throw notFound("Conversation not found");
  }
}

/**
 * Keeps only user messages that received an answer. A turn that failed
 * (model error, client disconnect) leaves an unanswered user message behind;
 * replaying it would confuse the model with back-to-back user turns.
 */
export function completedExchanges(messages: HistoryMessage[]): HistoryMessage[] {
  return messages.filter((m, i) => m.role === "ASSISTANT" || messages[i + 1]?.role === "ASSISTANT");
}

function toSummary(c: { id: string; title: string; createdAt: Date; updatedAt: Date }): ConversationSummaryDto {
  return { id: c.id, title: c.title, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString() };
}
