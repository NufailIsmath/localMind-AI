# LocalMind AI

A **local-first AI assistant** that can read your documents, retrieve relevant knowledge, query a database and run tools — with **no cloud LLM API and no API keys**. Everything (model inference, embeddings, vector search, storage) runs on your own machine.

Built to show the parts of AI engineering beyond "call an LLM API": local inference, embeddings and semantic search, a hand-written RAG pipeline, native tool calling with a security boundary, orchestration, observability and measurable retrieval quality.

| | |
|---|---|
| **LLM runtime** | [Ollama](https://ollama.com) — `qwen3:8b` (chat + tool calling), `nomic-embed-text` (embeddings) |
| **Backend** | Node.js · TypeScript · Fastify · Zod · Prisma |
| **Data** | Qdrant (vectors) · PostgreSQL (users, documents, chats, tool audit log) |
| **Frontend** | Next.js 16 · React 19 (streaming chat UI) |
| **Testing** | Vitest — 84 unit + 94 integration tests (real Postgres/Qdrant), 11 Playwright E2E, RAG evaluation harness |
| **Infra** | Docker Compose |

## Features

- **Chat with your documents** — upload PDF, DOCX, TXT or Markdown; answers cite the exact passages (`[S1]`) with file name, page range and similarity score.
- **Native tool calling** — the model can search your knowledge base, do exact arithmetic, check the time, and query PostgreSQL (your documents, usage stats). Admin-only tools demonstrate role-based permissions.
- **Streaming** — tokens and live tool activity over Server-Sent Events.
- **Conversation memory** — multi-turn chats persisted in PostgreSQL.
- **Document-level access control** — documents are private, shared with the whole organisation, or shared with groups (HR, Executives…), and classified Public → Internal → Confidential → Restricted. Users have a clearance level and group memberships. An intern asking for the CEO's salary never retrieves the compensation file, so the model never sees it. Enforced in Qdrant *and* re-checked in PostgreSQL, outside the model.
- **Observability** — every tool execution is audited (arguments, status, duration); structured logs for ingestion and chat turns.
- **Fault tolerance** — timeouts, retries with backoff for transient Ollama failures, tool timeouts, bounded tool loops, graceful degradation.
- **Measurable RAG** — an evaluation harness reports Hit@k, Precision@k, MRR, answer accuracy and citation accuracy over a labelled question set.

## Architecture

```mermaid
flowchart TB
  subgraph Web["Next.js frontend"]
    UI["Chat UI · document manager · tool activity · citations"]
  end

  subgraph API["Fastify API (modular monolith)"]
    direction TB
    Routes["auth · chat · documents · tools · health"]
    Orch["AI Orchestrator<br/>LLM ⇄ tool loop"]
    Reg["Tool Registry<br/>Zod validation · RBAC · timeouts · audit"]
    RAG["RAG engine<br/>extract → chunk → embed → index / retrieve"]
    Routes --> Orch
    Routes --> RAG
    Orch --> Reg
    Reg -->|search_knowledge| RAG
  end

  UI -- "REST + SSE (JWT)" --> Routes
  Orch -- "/api/chat (tools)" --> Ollama[("Ollama<br/>qwen3:8b")]
  RAG -- "/api/embed" --> Emb[("Ollama<br/>nomic-embed-text")]
  RAG --> Qdrant[("Qdrant<br/>chunk vectors + payload")]
  Reg --> PG[("PostgreSQL<br/>users · docs · chats · tool logs")]
  Routes --> PG
```

### One chat turn

```
user ──► Orchestrator ──► LLM (messages + tool specs filtered by role)
              ▲                 │
              │       tool_calls? ── no ──► answer ─► persist ─► stream "done"
              │                 │ yes
              │                 ▼
              │       ToolRegistry.execute(name, args, trustedContext)
              │         • unknown tool?   → error result
              │         • role allowed?   → else DENIED
              │         • Zod-valid args? → else error result
              │         • run with timeout, audit to PostgreSQL
              └──────── tool result appended as a `tool` message (≤ MAX_TOOL_ROUNDS)
```

RAG is exposed *as a tool* (`search_knowledge`), so the model decides when document context is needed, and retrieved passages come back labelled `S1…Sn` for citation. If the model keeps calling tools past the limit, the orchestrator forces a final answer with tools disabled.

More detail and design decisions: [`docs/architecture.md`](docs/architecture.md).

## Quick start

### 1. Prerequisites

- Node.js ≥ 20.11, Docker
- [Ollama](https://ollama.com/download)

### 2. Choose a model for your hardware

| Machine | Chat model | Notes |
|---|---|---|
| 16 GB+ RAM, or a GPU with 8 GB+ VRAM | `qwen3:8b` (default) | Best tool-calling reliability of the three |
| 8–16 GB RAM | `qwen3:4b` | Noticeably faster on CPU, still calls tools well |
| Low-end / quick experiments | `qwen3:1.7b` | Expect weaker tool selection |

Any Ollama model with **tool support** works (e.g. `qwen2.5:7b-instruct`, `llama3.1:8b`). Set `CHAT_MODEL` in `.env`.

```bash
ollama pull qwen3:8b            # or qwen3:4b
ollama pull nomic-embed-text
```

### 3. Start the infrastructure and the app

```bash
cp .env.example .env
# set JWT_SECRET to a random value:  openssl rand -base64 48

npm install                     # also generates the Prisma client
npm run infra:up                # Qdrant + PostgreSQL (bound to 127.0.0.1 only)
npm run db:deploy               # apply database migrations

npm run dev:api                 # http://localhost:4000
npm run dev:web                 # http://localhost:3000  (in a second terminal)
```

Open http://localhost:3000, create an account (the first account becomes the administrator), drop some documents into the knowledge base and start asking questions. `GET http://localhost:4000/api/health` reports the status of PostgreSQL, Qdrant and both Ollama models.

> **No GPU / can't run Ollama?** `npm run mock:ollama` starts a rule-based stand-in for the Ollama API on port 11434 so you can click through the whole app. It pattern-matches instead of generating text — use it for demos and E2E tests, not for judging answer quality.

## Access control

Who can read a document is decided by one policy ([`access.policy.ts`](apps/api/src/modules/access/access.policy.ts)):

> A user can read a document if they **own** it, **or** it's shared with the **organisation** and its classification ≤ their clearance, **or** it's shared with a **group they belong to** and its classification ≤ their clearance.

Classification is checked *on top of* group membership, so adding an intern to the HR group by mistake still doesn't expose Restricted files. Admins manage people, groups and any document, but they **don't** automatically read everything: their retrieval follows the same policy.

**Where it's enforced**

```
question ─► search_knowledge(query)          ← model controls only the query text
              │  principal = { userId, clearance, groupIds } from the login token,
              │              reloaded from PostgreSQL on every request
              ▼
         Qdrant search with a payload filter  ← chunks the user can't read are never candidates
              ▼
         PostgreSQL re-check of every hit      ← source of truth; stale vector payloads can't widen access
              ▼
         passages the user may read ─► model
```

The policy is compiled into a Qdrant filter, a Prisma `where` and a plain predicate, so retrieval, document listing, the `list_documents` tool and the in-memory test store all apply the same rule. Sharing changes update PostgreSQL first, so revocations take effect immediately, then sync the vector payloads. Removing someone from a group, lowering their clearance or deleting a group applies on their very next request. Sharing, permission and group changes are written to an **audit log**.

Rules for sharing: non-admins can only share with groups they belong to, so nobody can push content (or prompt injections) into another team's knowledge base. Readers can't change, re-index or delete documents they don't own. Users without read access get `404` rather than `403`, so they can't tell the document exists.

**Try it:** `npm run seed:demo` creates a demo company (CEO, CFO, HR, engineer, intern) with classified documents (password `demo-password` for every account):
1. As `intern@demo.local`, ask *"What is the CEO salary?"* and get a playful no.
2. As `hr@demo.local`, ask the same and get the answer with a Confidential source.
3. As `engineer@demo.local`, ask *"What do new hires get on day one?"*, then click **Ask for access**.
4. Approve the request as `hr@demo.local`.

**Tested by** a 41-case integration matrix: 5 people × 5 documents for retrieval, listing and direct access, checked both through Qdrant alone and through the full path. It also covers attempts to widen access through tool arguments, sharing into foreign groups, revocation via group removal, clearance changes and group deletion, a tampered vector payload, admin-only endpoints and the audit trail. Deliberately breaking either enforcement layer makes the suite fail.

### "Ah-ah, that's confidential" and asking for access

When a question strongly matches a document the user can't read, LocalMind says so in a friendly way instead of pretending nothing exists, and gives them something to do next:

| Situation | Reply | Under the reply |
|---|---|---|
| Above their clearance (intern → CEO salary) | *"Ha, good one, but my lips are sealed! 🤐 That one's confidential: it's above your clearance level…"* | 🤫 card + quick-reply suggestions (no request button, since only an admin can change clearance) |
| Clearance is fine, just not shared with them | *"Ah-ah, nice try! 🤫 That's confidential: it's only shared with HR…"* | 🔒 card with **Ask for access** (optional note) |

The request goes to the document's owner, who sees it in an **Access requests** inbox with **Approve / Decline**. Approval grants that one person access, still capped by their clearance. The requester's card updates live to *"✓ Access granted!"* with an **Ask again** button. Owners can revoke individual grants from the Access editor, and everything lands in the audit log.

**What the acknowledgement does and doesn't reveal.** Saying "that's confidential" admits that *something* matched, which can be probed. So it's deliberately narrow:
- **Only shared documents:** only READY documents shared with a team or the whole organisation are acknowledged. Someone's private files never are.
- **Only strong matches:** similarity must reach `RESTRICTED_NOTICE_SCORE_THRESHOLD`, default 0.55.
- **Minimal detail:** at most one "above your clearance" notice per answer, carrying only the classification and audience. No title, excerpt, score or document id reaches the client or the model. The requester only learns the file name once approved.
- **Silent mode:** set `ACCESS_DENIAL_MODE=silent` to go back to revealing nothing.

Requests can only be raised from a notice the assistant actually showed that user (message + notice id are checked server-side), so they can't be used to fish for document ids.

**Not covered:** answers given *before* access was revoked stay in that user's chat history. Revocation stops future retrieval; it can't un-tell a past answer.

## API

All endpoints except `auth/register`, `auth/login` and `health` require `Authorization: Bearer <token>`.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/register` | Create an account → `{ token, user }` |
| POST | `/api/auth/login` | Sign in → `{ token, user }` |
| GET | `/api/auth/me` | Current user |
| POST | `/api/chat` | Send a message → `{ conversationId, messageId, answer, sources, toolExecutions }` |
| POST | `/api/chat/stream` | Same, streamed as SSE: `conversation`, `token`, `reset`, `tool_start`, `tool_end`, `done`, `error` |
| GET | `/api/chat` | List conversations |
| GET | `/api/chat/:id` | Conversation with messages, sources and tool executions |
| DELETE | `/api/chat/:id` | Delete a conversation |
| POST | `/api/documents/upload` | Upload (multipart `file`, optional `visibility`, `classification`, `groupIds`) → `202` |
| GET | `/api/documents` | Your documents plus those shared with you, with access settings |
| GET | `/api/documents/:id` | One document |
| POST | `/api/documents/:id/reindex` | Re-extract and re-embed (e.g. after changing the embedding model) |
| DELETE | `/api/documents/:id` | Delete from PostgreSQL, Qdrant and disk |
| GET | `/api/tools` | Tools available to your role, with JSON-schema parameters |
| PATCH | `/api/documents/:id/access` | Change visibility, classification, groups (owner or admin) |
| DELETE | `/api/documents/:id/grants/:userId` | Revoke an individual grant (owner or admin) |
| POST | `/api/access-requests` | Ask for access from a notice in a chat answer (`messageId`, `noticeId`, optional `note`) |
| GET | `/api/access-requests` | `incoming` (to decide on) and `outgoing` (yours) |
| POST | `/api/access-requests/:id/approve` · `/deny` | Decide (document owner or admin) |
| GET | `/api/tools/executions` | Your tool audit log |
| GET / PATCH | `/api/admin/users`, `/api/admin/users/:id` | People: role, clearance, groups (admin) |
| GET / POST / DELETE | `/api/admin/groups`, `/api/admin/groups/:id` | Groups (admin) |
| GET | `/api/admin/audit` | Sharing / permission audit log (admin) |
| GET | `/api/health` | Dependency health (200 / 503) |

Example:

```bash
curl -s localhost:4000/api/chat -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"message":"What does my company policy say about annual leave?"}'
```

```json
{
  "conversationId": "4f0c…",
  "messageId": "a81e…",
  "answer": "Full-time employees get 21 days of paid annual leave per year [S1].",
  "sources": [{ "ref": "S1", "documentId": "9b2d…", "fileName": "employee-handbook.md", "pageStart": null, "pageEnd": null, "score": 0.71, "excerpt": "…" }],
  "toolExecutions": [{ "id": "…", "tool": "search_knowledge", "arguments": { "query": "annual leave policy" }, "status": "SUCCESS", "durationMs": 84 }]
}
```

## Tools

| Tool | Data source | Who |
|---|---|---|
| `search_knowledge` | Qdrant semantic search over *your* documents | everyone |
| `calculate` | Fixed binary operations (no `eval`) | everyone |
| `get_current_time` | Server clock, optional IANA time zone | everyone |
| `list_documents` | PostgreSQL (predefined query, access-policy scoped) | everyone |
| `get_usage_stats` | PostgreSQL aggregates for your account | everyone |
| `get_system_stats` | Instance-wide PostgreSQL aggregates | **ADMIN** |

Adding a tool is one file — define a Zod schema and an `execute(args, ctx)` function, then register it in [`apps/api/src/modules/tools/index.ts`](apps/api/src/modules/tools/index.ts). The JSON schema the model sees is generated from the Zod schema, so validation and documentation never drift apart.

```ts
export const weatherTool = defineTool({
  name: "get_weather",
  description: "Get the current weather for a city",
  schema: z.object({ city: z.string().min(1).max(100) }),
  timeoutMs: 5000,
  async execute({ city }, ctx) {
    // ctx.userId / ctx.userRole come from the authenticated request, never from the model
    return fetchWeather(city, { signal: ctx.signal });
  },
});
```

## Security design

- **The model never chooses what data it sees.** Tools receive identity, clearance and groups from a trusted server-side context. Every Qdrant search carries the access-policy filter, every hit is re-checked in PostgreSQL, and every SQL query is scoped in code. See [Access control](#access-control).
- **Tools are an allow-list.** Unknown tools are rejected, arguments are Zod-validated before any code runs, each tool has a timeout, and role checks run both when advertising tools and when executing them.
- **No arbitrary SQL, shell or `eval`.** Database access is via predefined, read-only Prisma queries; the calculator is a fixed set of operations.
- **Retrieved text is untrusted.** The system prompt tells the model to treat tool output as data, and results are JSON-encoded. The real protection is architectural: even a successful prompt injection can only call read-only tools scoped to the current user. (`eval/documents/security-policy.md` contains a deliberate injection test case.)
- **Internal errors are not echoed to the model.** Unexpected tool exceptions become a generic message and are logged server-side.
- **Uploads** are size-limited, type-checked by extension *and* magic bytes, deduplicated by SHA-256 per user, stored with `0600` permissions under a server-generated name. DOCX archives are checked for zip bombs before parsing, documents are capped at 5,000 chunks, and documents interrupted mid-indexing are marked failed on restart rather than retried, so one bad file can't crash-loop the server.
- **Auth**: scrypt password hashing, JWT (HS256) with expiry, users re-loaded on every request (deleted users lose access immediately), rate-limited login/registration/chat/upload, uniform login errors with timing equalisation.
- **Local infrastructure**: Docker publishes Qdrant/PostgreSQL/Ollama on `127.0.0.1` only — Qdrant has no auth by default and Ollama has none at all.

## Evaluating RAG quality

```bash
npm run eval:rag                                  # retrieval metrics with your real embedding model
npm run eval:rag -- --answers -v                  # + answer accuracy & citation accuracy (uses the chat model)
npm run eval:rag -- --chunk-sizes=300,600,900     # compare chunking strategies
npm run eval:rag -- --fake                        # offline smoke run (hash embeddings)
```

The corpus is in [`apps/api/eval/documents`](apps/api/eval/documents) and the 28 labelled questions in [`apps/api/eval/questions.json`](apps/api/eval/questions.json). Each question names the file and an evidence span that must be retrieved, plus facts the answer must contain.

| Metric | Meaning |
|---|---|
| Hit@k (recall) | Evidence passage appears in the top k results |
| Precision@k | Share of retrieved chunks that come from the right document |
| MRR | 1 / rank of the first relevant chunk |
| Answer accuracy | Answer contains all expected facts (`--answers`) |
| Citation accuracy | Every `[S#]` cited points at the right document (`--answers`) |

Per-question results are written to `apps/api/eval/results/`.

## Testing

```bash
npm test                      # unit tests (no infrastructure needed)
npm run infra:up
npm run test:integration      # real PostgreSQL (localmind_test DB) + real Qdrant + fake Ollama over HTTP
npm run typecheck

# End-to-end (browser) — against the running stack with the mock model:
npm run mock:ollama & RETRIEVAL_SCORE_THRESHOLD=0.05 RESTRICTED_NOTICE_SCORE_THRESHOLD=0.1 npm run dev:api &
npm run build -w @localmind/web && npm run start -w @localmind/web &
npm run seed:demo             # demo organisation used by the access-control E2E tests
npm run e2e -w @localmind/web
```

- **Unit** — chunking (overlap, page attribution, pathological input), extraction (real PDF/DOCX fixtures), tool registry (validation, RBAC, timeouts, error masking), orchestrator loop (citations, round limits, per-round caps, hallucinated tools, history, streaming order), Ollama client (NDJSON split across TCP packets, retries, timeouts, aborts), config, auth crypto.
- **Integration** — the real Fastify app through HTTP: auth flows and token tampering, uploads of every format, duplicate/oversize/spoofed files, background indexing, cross-user isolation of documents, retrieval, conversations and tool logs, re-indexing and deletion verified directly in Qdrant, end-to-end tool calling, permission denial, SSE streaming, failure paths, health checks.

- **Access control** — the matrix described above, plus unit tests of the policy.
- **E2E (Playwright)** — intern vs. HR asking for the CEO's salary, readers unable to manage others' documents, the admin panel, editing a document's access, sign-up, multi-file upload, cited RAG answer with citation highlighting, calculator tool, history restore after reload, backend-failure banner, switching chats mid-stream, unsupported uploads, and a mobile layout check.

The integration suite uses a separate `localmind_test` database (created automatically by `infrastructure/postgres/init.sql`) and a throw-away Qdrant collection per run. It is skipped with a warning if the infrastructure isn't running.

## Configuration

All settings are environment variables validated at startup (see [`.env.example`](.env.example) and [`apps/api/src/config/env.ts`](apps/api/src/config/env.ts)). The important ones:

| Variable | Default | |
|---|---|---|
| `CHAT_MODEL` | `qwen3:8b` | Any Ollama model with tool support |
| `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` | `nomic-embed-text` / `768` | Must match; re-index after changing |
| `OLLAMA_THINK` | `false` | Qwen3 reasoning mode (slower, sometimes better) |
| `CHUNK_SIZE_TOKENS` / `CHUNK_OVERLAP_TOKENS` | `600` / `100` | Starting values — tune with the eval harness |
| `RETRIEVAL_LIMIT` / `RETRIEVAL_SCORE_THRESHOLD` | `5` / `0.35` | Top-k and minimum cosine similarity |
| `ACCESS_DENIAL_MODE` | `acknowledge` | `acknowledge`: friendly "that's confidential" + request access; `silent`: reveal nothing |
| `RESTRICTED_NOTICE_SCORE_THRESHOLD` | `0.55` | Minimum similarity before a restricted document is acknowledged |
| `MAX_TOOL_ROUNDS` / `MAX_TOOL_CALLS_PER_ROUND` | `5` / `5` | Bounds on the agent loop |
| `TOOL_TIMEOUT_MS` / `LLM_TIMEOUT_MS` | `15000` / `180000` | Fault-tolerance limits |
| `ALLOW_REGISTRATION` | `true` | Set to `false` after creating your account |

## Project structure

```
localmind-ai/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── ai/            # Ollama client, LLM + embedding services, orchestrator, prompts
│   │   │   ├── rag/           # extraction, chunking, ingestion queue, retrieval, Qdrant store
│   │   │   ├── modules/
│   │   │   │   ├── access/    # access policy, sharing, groups, clearance, audit
│   │   │   │   ├── admin/     # organisation administration endpoints
│   │   │   │   ├── auth/      # registration, login, JWT, scrypt
│   │   │   │   ├── chat/      # routes (REST + SSE) and conversation repository
│   │   │   │   ├── documents/ # upload / list / reindex / delete
│   │   │   │   ├── tools/     # registry, tool definitions, audit endpoints
│   │   │   │   └── health/
│   │   │   ├── config/        # Zod-validated environment
│   │   │   ├── lib/           # errors, retries/timeouts, job queue, validation
│   │   │   ├── container.ts   # composition root (dependency injection)
│   │   │   ├── app.ts         # Fastify app factory
│   │   │   └── server.ts      # process entry point
│   │   ├── test/              # unit, integration, helpers (fake Ollama, scripted LLM, fixtures)
│   │   ├── eval/              # RAG evaluation corpus + questions
│   │   └── scripts/           # eval-rag.ts, mock-ollama.ts, seed-demo.ts
│   └── web/                   # Next.js chat UI
├── packages/shared/           # API contract types shared by api and web
├── prisma/                    # schema + migrations
├── infrastructure/            # docker-compose.yml, postgres init
└── docs/architecture.md
```

## Limitations and next steps

- The ingestion queue is in-process; interrupted jobs are re-queued on startup, but a multi-instance deployment would want a durable queue (pg-boss / BullMQ).
- Scanned PDFs need OCR before indexing.
- Retrieval is pure dense search; hybrid (BM25 + vectors) and a re-ranker would improve precision on keyword-heavy questions.
- A web-search tool is a natural next addition — the registry makes it a single file, but it should be opt-in since it sends queries off the machine.
- JWTs are stored in `localStorage` for simplicity; an httpOnly cookie session would harden the browser side.
