import { randomUUID } from "node:crypto";
import type { Source } from "@clbuddy/shared";
import type { ChatRepository, HistoryMessage, ToolExecutionRecord } from "../../src/modules/chat/chat.repository.js";
import { notFound } from "../../src/lib/errors.js";

export class InMemoryChatRepository implements ChatRepository {
  conversations = new Map<string, { userId: string; title: string }>();
  messages: { id: string; conversationId: string; role: "USER" | "ASSISTANT"; content: string; sources?: Source[] }[] = [];
  tools: (ToolExecutionRecord & { conversationId: string; messageId?: string })[] = [];

  async resolveConversation(userId: string, conversationId: string | undefined, title: string) {
    if (conversationId) {
      const c = this.conversations.get(conversationId);
      if (!c || c.userId !== userId) throw notFound("Conversation not found");
      return { id: conversationId, created: false };
    }
    const id = randomUUID();
    this.conversations.set(id, { userId, title });
    return { id, created: true };
  }
  async loadHistory(conversationId: string, limit: number): Promise<HistoryMessage[]> {
    return this.messages.filter((m) => m.conversationId === conversationId).slice(-limit).map(({ role, content }) => ({ role, content }));
  }
  async addUserMessage(conversationId: string, content: string) {
    const id = randomUUID();
    this.messages.push({ id, conversationId, role: "USER", content });
    return id;
  }
  async addAssistantMessage(conversationId: string, content: string, sources: Source[]) {
    const id = randomUUID();
    this.messages.push({ id, conversationId, role: "ASSISTANT", content, sources });
    return id;
  }
  async recordToolExecution(conversationId: string, record: ToolExecutionRecord) {
    this.tools.push({ ...record, conversationId });
  }
  async linkToolExecutions(ids: string[], messageId: string) {
    for (const t of this.tools) if (ids.includes(t.id)) t.messageId = messageId;
  }
}
