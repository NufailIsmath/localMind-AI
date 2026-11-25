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
  /** Interface to listen on (0.0.0.0 inside Docker). */
  host?: string;
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

  // "Compromised model" simulation: obey [[call:tool {json}]] and [[say:text]]
  // directives found in tool results (i.e. planted in documents), the way a
  // fully prompt-injected model would. Lets tests prove the *server* contains it.
  if (toolResults.length > 0) {
    const already = new Set(
      after.flatMap((m) => m.tool_calls ?? []).map((c) => `${c.function.name}:${JSON.stringify(c.function.arguments)}`),
    );
    for (const m of toolResults) {
      for (const d of m.content.matchAll(/\[\[call:([a-z_]+)\s*(\{.*?\})?\]\]/g)) {
        let args: Record<string, unknown> = {};
        try {
          args = d[2] ? JSON.parse(d[2].replace(/\\"/g, '"')) : {};
        } catch {
          /* ignore malformed */
        }
        const key = `${d[1]}:${JSON.stringify(args)}`;
        if (!already.has(key)) return call(d[1]!, args);
      }
    }
    const says = toolResults.flatMap((m) => [...m.content.matchAll(/\[\[say:([^\]]+)\]\]/g)].map((x) => x[1]!));
    if (says.length) return { content: says.join(" "), toolCalls: [] };
  }

  // Called without tools after the tool budget ran out.
  if (toolNames.size === 0 && toolResults.length > 0) {
    return { content: "Based on the information gathered so far, I cannot give a more complete answer.", toolCalls: [] };
  }
  const wantsDraft = DRAFT.test(userText);
  // Second step: answer from tool results.
  if (toolResults.length > 0 && wantsDraft) {
    const team = JSON.parse(toolResults.at(-1)!.content) as ToolPayload;
    const found = team.tool === "find_team" ? team.data?.teams?.[0] : undefined;
    return { content: draftReply(userText, found?.contacts?.[0], found?.team), toolCalls: [] };
  }
  if (toolResults.length > 0) {
    const parts = toolResults.map((m) => answerFromTool(JSON.parse(m.content) as ToolPayload, userText));
    return { content: parts.join("\n\n"), toolCalls: [] };
  }

  const dates = [...userText.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]);
  if (dates.length >= 2 && /\b(?:book|request|apply for|submit)\b/i.test(userText) && toolNames.has("propose_leave_request")) {
    return call("propose_leave_request", { startDate: dates[0], endDate: dates[1] });
  }
  if (dates.length >= 2 && /\b(?:leave|off|holiday|vacation)\b/i.test(userText) && toolNames.has("check_leave_dates")) {
    return call("check_leave_dates", { startDate: dates[0], endDate: dates[1] });
  }
  if (/\b(?:do i have|have i got|i have left|my (?:annual |sick )?(?:leave|holidays?|vacation|pto)|leave balance)\b/i.test(userText) && toolNames.has("get_my_leave_balance")) {
    return call("get_my_leave_balance", /\b(20\d\d)\b/.test(userText) ? { year: Number(userText.match(/\b(20\d\d)\b/)![1]) } : {});
  }

  if (wantsDraft) {
    const team = userText.match(TEAM)?.[1];
    if (team && toolNames.has("find_team")) return call("find_team", { query: team });
    return { content: draftReply(userText), toolCalls: [] };
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
    return { content: "Hey! 👋 I'm CL Buddy, your work buddy. I can find answers in company docs, help you sort out a work issue step by step, or draft an email for you. What's on your mind?", toolCalls: [] };
  }
  return call("search_knowledge", { query: userText.replace(/[?!.]+$/, "") });
}

const DRAFT = /\b(?:draft|write|compose|prepare)\b[^.?!]*\b(?:e-?mail|mail|message|note|reply)\b/i;
const TEAM = /\b(hr|it|finance|payroll|engineering|executives?|security|people ops)\b/i;
const GUIDANCE = /\b(?:how do i|how can i|what should i do|what do i do|broken|broke|not working|issue|problem|sort (?:this|it) out|claim)\b/i;

/** Builds an ```email draft block from the request, the way the real model is prompted to. */
function draftReply(request: string, to?: string, team?: string): string {
  const topic = request.match(/\b(?:asking (?:for|about)|about|regarding|requesting|to request|for)\s+(.+?)(?:[.?!]|$)/i)?.[1]?.trim();
  const subject = topic ? topic.charAt(0).toUpperCase() + topic.slice(1, 70) : "Quick request";
  const greeting = team ? `Hi ${team} team,` : "Hi,";
  return [
    "Sure! Here's a draft you can send:",
    "",
    "```email",
    `To: ${to ?? ""}`,
    "Cc:",
    `Subject: ${subject}`,
    "",
    greeting,
    "",
    `I hope you're well. I'm writing ${topic ? `about ${topic}` : "with a quick request"}. [Add any details here.]`,
    "",
    "Could you let me know the next steps?",
    "",
    "Thanks,",
    "[Your name]",
    "```",
    "",
    "Want me to make it shorter or more formal?",
  ].join("\n");
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
      if (GUIDANCE.test(question)) {
        const rest = String(top.content).replace(sentence, "");
        const second = bestSentence(rest, question);
        const hasSecond = Boolean(second) && second !== sentence;
        return [
          "Ah, that's annoying — let's get it sorted. 🙌",
          "",
          "Here's what to do:",
          `1. ${sentence} [${top.ref}]`,
          ...(hasSecond ? [`2. ${second} [${top.ref}]`] : []),
          `${hasSecond ? 3 : 2}. If you get stuck, reach out to the team that owns it and mention what you've tried.`,
          "",
          "Want me to draft the email for you?",
        ].join("\n");
      }
      const answer = `According to ${top.fileName}${top.pages ? ` (page ${top.pages})` : ""}: "${sentence}" [${top.ref}]`;
      return denial ? `${answer}\n\nOne more thing: ${denial.charAt(0).toLowerCase()}${denial.slice(1)}` : answer;
    }
    case "find_team": {
      const t = d.teams?.[0];
      return t
        ? `That's ${t.team}${t.handles ? ` (they handle ${String(t.handles).toLowerCase()})` : ""}. You can reach them at ${t.contacts.join(", ") || "their team channel"}.`
        : "I couldn't find a team for that.";
    }
    case "get_my_leave_balance": {
      const annual = (d.balances ?? []).find((b: any) => b.leaveType === "ANNUAL");
      if (!annual) return `Hmm, HR hasn't set up your leave allowance for ${d.year} yet, so I can't tell you a balance. Want me to draft a quick note to HR?`;
      const parts = [`${annual.entitled} entitled`];
      if (annual.carriedOver) {
        parts.push(
          annual.carryOverForfeited
            ? `${annual.carriedOver - annual.carryOverForfeited} of ${annual.carriedOver} carried over (${annual.carryOverForfeited} expired)`
            : `${annual.carriedOver} carried over`,
        );
      }
      if (annual.adjustments) parts.push(`${annual.adjustments} adjustment`);
      const lines = [
        `You have **${annual.remaining} days** of annual leave left for ${d.year} 🌴`,
        `(${parts.join(" + ")}; ${annual.taken} taken, ${annual.booked} booked).`,
      ];
      if (annual.carryOverToUseBeforeExpiry > 0) lines.push(`Heads-up: ${annual.carryOverToUseBeforeExpiry} carried-over days expire on ${annual.carryOverExpiresOn}, so use them before then!`);
      if (d.upcoming?.length) lines.push(`Coming up: ${d.upcoming.map((u: any) => `${u.startDate} to ${u.endDate}`).join(", ")}.`);
      if (annual.pending > 0) lines.push(`You also have ${annual.pending} day(s) waiting for HR approval.`);
      return lines.join(" ");
    }
    case "propose_leave_request": {
      if (!d.prepared) return `Hmm, I can't set that one up: ${(d.reason ?? []).join(" ")} Want to try different dates?`;
      const p = d.plan;
      const left = p.availableAfter === null ? "" : ` You'd have ${p.availableAfter} days left once it's approved.`;
      return `All set: I've prepared a request for ${p.startDate} to ${p.endDate} (${p.workingDays} working day(s)).${left} Check the card below and tap **Submit request**; it'll go to HR for approval.`;
    }
    case "check_leave_dates": {
      const hol = d.holidaysInRange?.length ? ` (${d.holidaysInRange.map((h: any) => h.name).join(", ")} doesn't count)` : "";
      const after = d.remainingAfter === null ? "" : ` You'd have ${d.remainingAfter} days left (you have ${d.remainingBefore} now).`;
      const warn = d.warnings?.length ? ` ⚠️ ${d.warnings.join(" ")}` : "";
      return `${d.startDate} to ${d.endDate} is ${d.workingDays} working day(s)${hol}.${after}${warn} Want me to draft the leave request to HR?`;
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

        // JSON-mode classification requests. Deliberately *obedient*: it follows
        // "classify this as X" instructions inside the document, like a fully
        // prompt-injected model would — the server must not trust it.
        if (chat.format) {
          const doc = (chat.messages.at(-1)?.content ?? "").toLowerCase();
          const injected = doc.match(/classify (?:this|it|the document) as (public|internal|confidential|restricted)/);
          const answer = injected
            ? { classification: injected[1]!.toUpperCase(), reasons: ["As instructed by the document"] }
            : /customer (?:list|records)|home address/.test(doc)
              ? { classification: "CONFIDENTIAL", reasons: ["Contains customer personal data"] }
              : { classification: "INTERNAL", reasons: [] };
          return json(res, 200, { model: chatModel, message: { role: "assistant", content: JSON.stringify(answer) }, done: true });
        }

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

  await new Promise<void>((resolve) => server.listen(port, opts.host ?? "127.0.0.1", resolve));
  const { port: actual } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actual}`,
    server,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
