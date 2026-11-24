import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { OllamaChatBody, OllamaMessage, OllamaToolCall } from "../../src/ai/ollama.client.js";
import { hashEmbed } from "./hash-embeddings.js";

/**
 * A rule-based stand-in for the Ollama HTTP API (/api/tags, /api/embed,
 * /api/chat with streaming and tool calls). It lets the whole stack — HTTP
 * client, orchestrator, tools, Qdrant, PostgreSQL, SSE and the web UI — be
 * exercised end-to-end on machines without a GPU or the real models.
 *
 * It is *not* a language model: it maps message patterns to tool calls and
 * builds answers from tool results.
 */
export interface FakeOllamaOptions {
  chatModel?: string;
  embeddingModel?: string;
  dimensions?: number;
  /** Artificial delay between streamed tokens. */
  tokenDelayMs?: number;
}

export interface FakeOllama {
  url: string;
  server: Server;
  requests: { path: string; body: unknown }[];
  close(): Promise<void>;
}

type ToolPayload = { tool: string; status: string; data?: any; error?: string };

const CALC = /(-?\d+(?:\.\d+)?)\s*(\+|plus|-|minus|\*|x|times|multiplied by|\/|divided by|\^|to the power of)\s*(-?\d+(?:\.\d+)?)/i;
const OPS: Record<string, string> = {
  "+": "add", plus: "add", "-": "subtract", minus: "subtract", "*": "multiply", x: "multiply", times: "multiply",
  "multiplied by": "multiply", "/": "divide", "divided by": "divide", "^": "power", "to the power of": "power",
};

function decide(messages: OllamaMessage[], toolNames: Set<string>): { content: string; toolCalls: OllamaToolCall[] } {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const userText = messages[lastUserIdx]?.content ?? "";
  const after = messages.slice(lastUserIdx + 1);
  const toolResults = after.filter((m) => m.role === "tool");
  const call = (name: string, args: Record<string, unknown>) => ({ content: "", toolCalls: [{ function: { name, arguments: args } }] });

  if (/\[loop\]/.test(userText) && toolNames.has("get_current_time")) return call("get_current_time", {});

  // Called without tools after the tool budget ran out.
  if (toolNames.size === 0 && toolResults.length > 0) {
    return { content: "Based on the information gathered so far, I cannot give a more complete answer.", toolCalls: [] };
  }
  // Second step: answer from tool results.
  if (toolResults.length > 0) {
    const parts = toolResults.map((m) => answerFromTool(JSON.parse(m.content) as ToolPayload, userText));
    return { content: parts.join("\n\n"), toolCalls: [] };
  }

  const calc = userText.match(CALC);
  if (calc && toolNames.has("calculate")) {
    return call("calculate", { a: Number(calc[1]), b: Number(calc[3]), operation: OPS[calc[2]!.toLowerCase()] });
  }
  if (/\[admin\]/.test(userText)) return call("get_system_stats", {});
  if (/(?<![-\w])(time|date|today)\b/i.test(userText) && toolNames.has("get_current_time")) return call("get_current_time", {});
  if (/\b(list|which|how many)\b.*\b(documents?|files?)\b/i.test(userText) && toolNames.has("list_documents")) {
    return call("list_documents", {});
  }
  if (/\b(stats|statistics|usage)\b/i.test(userText) && toolNames.has("get_usage_stats")) return call("get_usage_stats", {});
  if (/^\s*(hi|hello|hey|thanks|thank you|what can you)\b/i.test(userText) || !toolNames.has("search_knowledge")) {
    return { content: "Hey! 👋 I'm LocalMind. Ask me anything about your team's documents, or throw me a calculation. What's on your mind?", toolCalls: [] };
  }
  return call("search_knowledge", { query: userText.replace(/[?!.]+$/, "") });
}

const words = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2));

/** Picks the sentence of a passage that shares the most words with the question. */
function bestSentence(passage: string, question: string): string {
  const q = words(question);
  const sentences = passage.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  let best = sentences[0] ?? passage;
  let bestScore = -1;
  for (const s of sentences) {
    const score = [...words(s)].filter((w) => q.has(w)).length;
    if (score > bestScore) [best, bestScore] = [s, score];
  }
  return best.slice(0, 240);
}

const OPENERS = ["Ah-ah, nice try! 🤫", "Ooh, I'd love to tell you, but no. 🙊", "Ha, good one, but my lips are sealed! 🤐"];

/** Playful refusal for restricted matches (deterministic per question so tests are stable). */
function confidentialReply(r: { reason: string; sharedWith: string[]; userCanRequestAccess: boolean }, question: string): string {
  const opener = OPENERS[[...question].reduce((a, c) => a + c.charCodeAt(0), 0) % OPENERS.length];
  const audience = r.sharedWith.join(" and ");
  if (r.reason === "above_clearance") {
    return `${opener} That one's confidential: it's above your clearance level, so I can't share it. If you really need it, your manager or ${audience} would be the people to ask.`;
  }
  return `${opener} That's confidential: it's only shared with ${audience}. ${r.userCanRequestAccess ? 'Tap "Ask for access" below and I\'ll send the owner a request.' : ""}`.trim();
}

function answerFromTool(p: ToolPayload, question: string): string {
  if (p.status !== "success") return `The ${p.tool} tool reported a problem: ${p.error}`;
  const d = p.data;
  switch (p.tool) {
    case "search_knowledge": {
      const restricted = (d.restricted ?? []) as { reason: string; sharedWith: string[]; userCanRequestAccess: boolean }[];
      const denial = restricted.length ? confidentialReply(restricted[0]!, question) : "";
      if (!d.results?.length) return denial || "Hmm, I couldn't find anything about that in your documents. Want to try different wording?";
      const top = d.results[0];
      const sentence = bestSentence(String(top.content), question);
      const answer = `According to ${top.fileName}${top.pages ? ` (page ${top.pages})` : ""}: "${sentence}" [${top.ref}]`;
      return denial ? `${answer}\n\nOne more thing: ${denial.charAt(0).toLowerCase()}${denial.slice(1)}` : answer;
    }
    case "calculate":
      return `The result of ${d.expression} is **${d.result}**.`;
    case "get_current_time":
      return `The current time is ${d.local}.`;
    case "list_documents":
      return `You have ${d.count} document(s)${d.count ? `: ${d.documents.map((x: any) => `${x.filename} (${x.status})`).join(", ")}` : ""}.`;
    case "get_usage_stats":
      return `You have ${d.documents} documents, ${d.conversations} conversations and ${d.messages} messages.`;
    default:
      return `${p.tool} returned: ${JSON.stringify(d)}`;
  }
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export async function startFakeOllama(opts: FakeOllamaOptions = {}, port = 0): Promise<FakeOllama> {
  const chatModel = opts.chatModel ?? "qwen3:8b";
  const embeddingModel = opts.embeddingModel ?? "nomic-embed-text";
  const dims = opts.dimensions ?? 768;
  const requests: FakeOllama["requests"] = [];

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/api/tags") {
        return json(res, 200, { models: [{ name: chatModel }, { name: `${embeddingModel}:latest` }] });
      }
      if (req.method === "GET" && req.url === "/api/version") return json(res, 200, { version: "fake" });
      if (req.method !== "POST") return json(res, 404, { error: "not found" });
      const body = await readJson(req);
      requests.push({ path: req.url ?? "", body });

      if (req.url === "/api/embed") {
        if (body.model !== embeddingModel) return json(res, 404, { error: `model "${body.model}" not found, try pulling it first` });
        const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
        // Test hook: documents containing this marker embed slowly, to exercise races.
        if (inputs.some((t) => t.includes("SLOW_EMBED_MARKER"))) await new Promise((r) => setTimeout(r, 600));
        const embeddings = inputs.map((t) => hashEmbed(t.replace(/^search_(document|query):\s*/, ""), dims));
        return json(res, 200, { model: embeddingModel, embeddings });
      }

      if (req.url === "/api/chat") {
        const chat = body as OllamaChatBody;
        if (chat.model !== chatModel) return json(res, 404, { error: `model "${chat.model}" not found, try pulling it first` });
        const lastUser = [...chat.messages].reverse().find((m) => m.role === "user")?.content ?? "";
        if (lastUser.includes("[fail-llm]")) return json(res, 500, { error: "simulated model crash" });

        const toolNames = new Set((chat.tools ?? []).map((t) => t.function.name));
        const { content, toolCalls } = decide(chat.messages, toolNames);
        const stats = { total_duration: 1_000_000, prompt_eval_count: 42, eval_count: content.split(" ").length };

        if (chat.stream === false) {
          return json(res, 200, {
            model: chatModel,
            message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
            done: true,
            done_reason: "stop",
            ...stats,
          });
        }
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        const write = (obj: unknown) => res.write(JSON.stringify(obj) + "\n");
        if (toolCalls.length) {
          write({ model: chatModel, message: { role: "assistant", content: "", tool_calls: toolCalls }, done: false });
        } else {
          for (const token of content.split(/(?<= )/)) {
            write({ model: chatModel, message: { role: "assistant", content: token }, done: false });
            if (opts.tokenDelayMs) await new Promise((r) => setTimeout(r, opts.tokenDelayMs));
          }
        }
        write({ model: chatModel, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", ...stats });
        return res.end();
      }
      return json(res, 404, { error: "not found" });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: actual } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actual}`,
    server,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
