import { randomUUID } from "node:crypto";
import type { ChatActionDto, ChatResponse, ChatStreamEvent, RestrictedNoticeDto, Source, ToolExecutionSummary } from "@clbuddy/shared";
import type { StoredAction } from "../modules/tools/tool.types.js";
import type { StoredNotice } from "../modules/access/access-requests.service.js";
import type { ChatRepository } from "../modules/chat/chat.repository.js";
import type { ToolRegistry } from "../modules/tools/tool.registry.js";
import type { ToolResult } from "../modules/tools/tool.types.js";
import type { AccessPrincipal } from "../modules/access/access.policy.js";
import type { RetrievedChunk, WithheldMatch } from "../rag/retrieval.service.js";
import {
  buildSystemPrompt,
  cleanAssistantContent,
  conversationTitle,
  formatToolResult,
  stripCitations,
} from "./prompt.service.js";
import type { ChatMessage, LlmService, ToolCall } from "./types.js";
import { detectInjection } from "../rag/injection-detector.js";
import type { ModerationService } from "../modules/moderation/moderation.service.js";
import type { ModerationNoticeDto } from "@clbuddy/shared";

export interface ModerationEvent {
  userId: string;
  conversationId: string;
  action: "blocked" | "warned" | "output_filtered";
  category: string;
}

export interface OrchestratorOptions {
  maxToolRounds: number;
  maxToolCallsPerRound: number;
  historyMessageLimit: number;
}

export interface OrchestratorLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface ChatTurnInput {
  /** The authenticated user — identity, role, clearance and groups. */
  user: AccessPrincipal;
  /** Display context for the system prompt (email, team names). */
  profile?: { email: string; teams: string[] };
  conversationId?: string;
  message: string;
  signal?: AbortSignal;
  /** Receives streaming events. When set, LLM output is streamed token by token. */
  onEvent?: (event: ChatStreamEvent) => void;
}

const EXCERPT_CHARS = 280;

/**
 * Picks the ~280-character window of a chunk that best matches the query, so
 * the citation card shows the relevant passage rather than the chunk's start.
 */
export function bestExcerpt(content: string, query = ""): string {
  if (content.length <= EXCERPT_CHARS) return content;
  const terms = new Set((query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []));
  const sentences = [...content.matchAll(/[^.!?\n]+[.!?]*\s*/g)];
  let bestStart = 0;
  let bestScore = 0;
  for (const s of sentences) {
    const words = s[0].toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
    const score = words.filter((w) => terms.has(w)).length;
    if (score > bestScore) [bestScore, bestStart] = [score, s.index ?? 0];
  }
  const start = Math.max(0, Math.min(bestStart, content.length - EXCERPT_CHARS));
  const slice = content.slice(start, start + EXCERPT_CHARS).trim();
  return `${start > 0 ? "…" : ""}${slice}${start + EXCERPT_CHARS < content.length ? "…" : ""}`;
}

/** Collects retrieved chunks across tool calls and assigns stable S1, S2… refs. */
class SourceCollector {
  private readonly byChunk = new Map<string, Source>();

  add(chunks: RetrievedChunk[], query?: string): string[] {
    return chunks.map((c) => {
      const key = `${c.documentId}:${c.chunkIndex}`;
      let source = this.byChunk.get(key);
      if (!source) {
        source = {
          ref: `S${this.byChunk.size + 1}`,
          documentId: c.documentId,
          fileName: c.fileName,
          chunkIndex: c.chunkIndex,
          pageStart: c.pageStart,
          pageEnd: c.pageEnd,
          classification: c.classification,
          shared: c.shared,
          score: Number(c.score.toFixed(4)),
          injectionFlags: detectInjection(c.content),
          excerpt: bestExcerpt(c.content, query),
        };
        this.byChunk.set(key, source);
      } else if (c.score > source.score) {
        source.score = Number(c.score.toFixed(4));
      }
      return source.ref;
    });
  }

  /**
   * Sources cited in the answer, falling back to everything retrieved when the
   * model did not use citation markers.
   */
  flagged(): Source[] {
    return [...this.byChunk.values()].filter((s) => s.injectionFlags.length > 0);
  }

  forAnswer(answer: string): Source[] {
    const all = [...this.byChunk.values()];
    const cited = new Set([...answer.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]));
    const used = all.filter((s) => cited.has(s.ref));
    return used.length > 0 ? used : all;
  }
}

/** Collects "that's confidential" notices across tool calls (one per document). */
class RestrictedCollector {
  private readonly byDoc = new Map<string, StoredNotice>();

  add(matches: WithheldMatch[]): string[] {
    return matches.map((m) => {
      let n = this.byDoc.get(m.documentId);
      if (!n) {
        n = { id: `R${this.byDoc.size + 1}`, ...m };
        this.byDoc.set(m.documentId, n);
      }
      return n.id;
    });
  }

  all(): StoredNotice[] {
    return [...this.byDoc.values()];
  }
}

/** Collects action cards prepared by tools during a turn (A1, A2…). */
class ActionCollector {
  private readonly actions: (StoredAction & { id: string })[] = [];
  add(a: StoredAction): string {
    const id = `A${this.actions.length + 1}`;
    this.actions.push({ ...a, id });
    return id;
  }
  all() {
    return this.actions;
  }
}

export const toActionDto = (a: StoredAction & { id: string }, request: ChatActionDto["request"] = null): ChatActionDto => ({ ...a, request });

/** Client view of a notice: the document id stays on the server. */
export const toNoticeDto = (n: StoredNotice, requestStatus: RestrictedNoticeDto["requestStatus"] = null): RestrictedNoticeDto => ({
  id: n.id,
  reason: n.reason,
  classification: n.classification,
  sharedWith: n.sharedWith,
  canRequest: n.canRequest,
  requestStatus,
});

/**
 * The AI orchestrator runs one chat turn:
 *
 *   user message → LLM (with tool specs) ─┬─ answer → persist → respond
 *                                          └─ tool calls → registry → results → LLM … (≤ maxToolRounds)
 *
 * The model only *requests* tools; this class validates, authorises, executes,
 * audits and feeds results back. RAG happens through the search_knowledge tool
 * so the model decides when document context is needed.
 */
export class Orchestrator {
  constructor(
    private readonly llm: LlmService,
    private readonly tools: ToolRegistry,
    private readonly repo: ChatRepository,
    private readonly opts: OrchestratorOptions,
    private readonly log: OrchestratorLogger,
    /** Called when retrieved passages look like prompt-injection attempts (for auditing). */
    private readonly onInjectionDetected?: (e: { userId: string; conversationId: string; documentId: string; flags: string[] }) => Promise<void>,
    /** Content guardrails applied to the user's message and the final answer. */
    private readonly moderation?: ModerationService,
    /** Called when the guardrails step in (for auditing; never receives the message text). */
    private readonly onModeration?: (e: ModerationEvent) => Promise<void>,
  ) {}

  async run(input: ChatTurnInput): Promise<ChatResponse> {
    const { user, onEvent } = input;
    const signal = input.signal ?? new AbortController().signal;
    const emit = (e: ChatStreamEvent) => onEvent?.(e);
    const started = Date.now();

    // Guardrails run before anything is stored or sent to the model.
    const verdict = this.moderation?.checkInput(input.message);
    const userMessage = verdict?.text ?? input.message;

    const title = verdict?.action === "block" ? "New conversation" : conversationTitle(userMessage);
    const conversation = await this.repo.resolveConversation(user.userId, input.conversationId, title);
    const history = await this.repo.loadHistory(conversation.id, this.opts.historyMessageLimit);
    await this.repo.addUserMessage(conversation.id, userMessage);
    emit({ type: "conversation", conversationId: conversation.id });

    const audit = (action: ModerationEvent["action"], category: string) =>
      this.onModeration?.({ userId: user.userId, conversationId: conversation.id, action, category }).catch(() => {});
    if (verdict?.reply) {
      // Blocked, or the user may be in distress: answer directly, without the model.
      if (verdict.action === "block") await audit("blocked", verdict.category!);
      this.log.info({ conversationId: conversation.id, moderation: verdict.action, category: verdict.category }, "chat turn answered by guardrails");
      return this.finish(conversation.id, verdict.reply, [], [], [], [], verdict.notice ?? null, emit);
    }
    if (verdict?.action === "warn") await audit("warned", verdict.category!);

    const toolSpecs = this.tools.specs(user.role);
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt({ tools: toolSpecs, user: input.profile }) },
      ...history.map(
        (h): ChatMessage =>
          h.role === "USER" ? { role: "user", content: h.content } : { role: "assistant", content: stripCitations(h.content) },
      ),
      ...(verdict?.systemNotes ?? []).map((content): ChatMessage => ({ role: "system", content })),
      { role: "user", content: userMessage },
    ];

    const sources = new SourceCollector();
    const restricted = new RestrictedCollector();
    const actions = new ActionCollector();
    const executions: ToolExecutionSummary[] = [];
    const onToken = onEvent ? (delta: string) => emit({ type: "token", content: delta }) : undefined;
    let answer: string | undefined;
    let rounds = 0;

    for (; rounds < this.opts.maxToolRounds; rounds++) {
      const result = await this.llm.chat({ messages, tools: toolSpecs, signal, onToken });
      if (result.toolCalls.length === 0) {
        answer = cleanAssistantContent(result.content);
        break;
      }
      if (onEvent && result.content.trim()) emit({ type: "reset" });

      messages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });
      const accepted = result.toolCalls.slice(0, this.opts.maxToolCallsPerRound);
      for (const call of accepted) {
        const summary = await this.executeTool(call, conversation.id, user, sources, restricted, actions, signal, emit);
        executions.push(summary.execution);
        messages.push({ role: "tool", toolName: call.name, content: summary.content, ...(call.id ? { toolCallId: call.id } : {}) });
      }
      for (const call of result.toolCalls.slice(accepted.length)) {
        messages.push({
          role: "tool",
          toolName: call.name,
          content: JSON.stringify({ tool: call.name, status: "error", error: `Skipped: at most ${this.opts.maxToolCallsPerRound} tool calls per step` }),
          ...(call.id ? { toolCallId: call.id } : {}),
        });
      }
    }

    if (answer === undefined) {
      // Tool budget exhausted: ask for a final answer with tools disabled.
      this.log.warn({ conversationId: conversation.id, rounds }, "tool round limit reached; forcing final answer");
      if (onEvent) emit({ type: "reset" });
      messages.push({
        role: "system",
        content: "The tool-use limit for this turn has been reached. Answer now using only the information gathered so far.",
      });
      const final = await this.llm.chat({ messages, signal, onToken });
      answer = cleanAssistantContent(final.content);
    }
    if (!answer) answer = "I wasn't able to produce an answer. Please try rephrasing your question.";
    const checked = this.moderation?.checkOutput(answer);
    if (checked?.changed) {
      answer = checked.text;
      this.log.warn({ conversationId: conversation.id, category: checked.category }, "answer adjusted by content guardrails");
      await audit("output_filtered", checked.category ?? "unknown");
    }

    const answerSources = sources.forAnswer(answer);
    for (const s of sources.flagged()) {
      this.log.warn({ conversationId: conversation.id, documentId: s.documentId, flags: s.injectionFlags }, "possible prompt injection in retrieved passage");
      await this.onInjectionDetected?.({ userId: user.userId, conversationId: conversation.id, documentId: s.documentId, flags: s.injectionFlags }).catch(() => {});
    }
    const response = await this.finish(conversation.id, answer, answerSources, restricted.all(), actions.all(), executions, verdict?.notice ?? null, emit);
    this.log.info(
      {
        conversationId: conversation.id,
        rounds: rounds + 1,
        tools: executions.map((e) => `${e.tool}:${e.status}`),
        sources: answerSources.length,
        ms: Date.now() - started,
      },
      "chat turn completed",
    );
    return response;
  }

  /** Stores the answer and sends the final event. */
  private async finish(
    conversationId: string,
    answer: string,
    sources: Source[],
    notices: StoredNotice[],
    actions: (StoredAction & { id: string })[],
    executions: ToolExecutionSummary[],
    moderation: ModerationNoticeDto | null,
    emit: (e: ChatStreamEvent) => void,
  ): Promise<ChatResponse> {
    const messageId = await this.repo.addAssistantMessage(conversationId, answer, sources, notices, actions, moderation);
    await this.repo.linkToolExecutions(executions.map((e) => e.id), messageId);
    const response: ChatResponse = {
      conversationId,
      messageId,
      answer,
      sources,
      restricted: notices.map((n) => toNoticeDto(n)),
      actions: actions.map((a) => toActionDto(a)),
      toolExecutions: executions,
      moderation,
    };
    emit({ type: "done", response });
    return response;
  }

  private async executeTool(
    call: ToolCall,
    conversationId: string,
    user: AccessPrincipal,
    sources: SourceCollector,
    restricted: RestrictedCollector,
    actions: ActionCollector,
    signal: AbortSignal,
    emit: (e: ChatStreamEvent) => void,
  ): Promise<{ execution: ToolExecutionSummary; content: string }> {
    const id = randomUUID();
    emit({ type: "tool_start", id, tool: call.name, arguments: call.arguments });

    const result: ToolResult = await this.tools.execute(call.name, call.arguments, {
      userId: user.userId,
      userRole: user.role,
      principal: user,
      conversationId,
      signal,
      addSources: (chunks, query) => sources.add(chunks, query),
      addRestricted: (matches) => restricted.add(matches),
      addAction: (a) => actions.add(a),
    });

    const execution: ToolExecutionSummary = {
      id,
      tool: call.name,
      arguments: call.arguments,
      status: result.status,
      durationMs: result.durationMs,
      ...(result.status !== "SUCCESS" ? { error: result.error } : {}),
    };
    await this.repo.recordToolExecution(conversationId, {
      id,
      toolName: call.name.slice(0, 100),
      arguments: call.arguments,
      status: result.status,
      error: result.status !== "SUCCESS" ? result.error : undefined,
      durationMs: result.durationMs,
    });
    emit({ type: "tool_end", execution });
    return { execution, content: formatToolResult(call.name, result) };
  }
}
