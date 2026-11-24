# Architecture and design decisions

## Modules

The API is a modular monolith. Each module depends on interfaces, and everything is wired in one place
(`apps/api/src/container.ts`), so tests can swap the LLM, embeddings or vector store without mocking libraries.

| Layer | Key types | Responsibility |
|---|---|---|
| `ai/` | `OllamaClient`, `LlmService`, `EmbeddingService`, `Orchestrator` | Talk to models; run the tool loop |
| `rag/` | `IngestionService`, `RetrievalService`, `VectorStore` | Turn files into searchable chunks and search them |
| `modules/tools/` | `ToolRegistry`, `defineTool` | The only way the model can affect the system |
| `modules/chat/` | `ChatRepository` | Conversations, messages, tool audit trail |
| `modules/auth/` | `AuthService` | Accounts, password hashing, JWT |

## Ingestion pipeline

```
POST /api/documents/upload
  ├─ size limit, extension + magic-byte check, SHA-256 dedupe (per user)
  ├─ store original under data/uploads/<uuid> (0600), insert Document(PENDING)
  └─ 202 Accepted ──► background JobQueue (concurrency 1)
                         ├─ PROCESSING
                         ├─ extract: unpdf (per page) · mammoth (DOCX) · UTF-8 text
                         ├─ normalise + chunk (sentence-aware, overlap, page ranges)
                         ├─ embed in batches of 16 ("search_document:" prefix for nomic)
                         ├─ delete previous vectors (re-index) → upsert to Qdrant
                         └─ transaction: DocumentChunk rows + READY  (or FAILED + cleanup)
```

- **Why asynchronous?** Embedding a long PDF on a laptop takes seconds to minutes. The client polls the status.
- **Why keep the original file?** Changing the embedding model requires re-indexing; `POST /documents/:id/reindex` re-runs the pipeline.
- **Crash safety.** Documents left in `PENDING`/`PROCESSING` are re-queued at startup. If a document is deleted while it is being indexed, the job notices inside its final transaction and removes the vectors it just wrote.
- **Duplicates.** `(userId, contentHash)` is unique. Re-uploading a file whose previous attempt `FAILED` replaces it.

## Chunking

`rag/chunking.service.ts` splits text into sentence/line segments, packs them greedily up to
`CHUNK_SIZE_TOKENS` (≈ 4 characters per token) and starts the next chunk with the trailing segments that fit in
`CHUNK_OVERLAP_TOKENS` — at least one sentence, so facts spanning a boundary stay retrievable. Over-long
"sentences" (tables, minified text) are split at word boundaries or hard-cut. Pages are concatenated with an
offset map, so each chunk knows its `pageStart`/`pageEnd` and can be cited accurately even when it spans pages.

The defaults (600 / 100 tokens) are starting points; `npm run eval:rag -- --chunk-sizes=…` measures alternatives.

## Retrieval

- Query embedding uses the `search_query:` prefix (nomic-embed-text was trained with task prefixes).
- Qdrant collection: cosine distance, keyword payload indexes on `userId` and `documentId`.
- **Every** search has a `must: userId == <authenticated user>` filter. `VectorStore.search` refuses to run without a `userId`.
- `RETRIEVAL_SCORE_THRESHOLD` drops weak matches so the model is told "nothing found" instead of being fed noise.
- On startup the API verifies that an existing collection's vector size matches `EMBEDDING_DIMENSIONS`, so a
  model change can't silently corrupt the index.

## Orchestration

`ai/orchestrator.service.ts` runs one turn:

1. Resolve the conversation (ownership-checked), load the last `HISTORY_MESSAGE_LIMIT` messages, persist the user message.
2. Build the system prompt for the tools this user's role can use.
3. Loop up to `MAX_TOOL_ROUNDS`: call the model; if it requests tools, execute at most
   `MAX_TOOL_CALLS_PER_ROUND` of them through the registry and append results as `tool` messages.
4. If the budget runs out, call the model once more **without tools** so it must answer.
5. Persist the answer with the sources it cited and link the audited tool executions to it.

Sources are collected across all `search_knowledge` calls in a turn and labelled `S1…Sn`. If the answer cites
labels, only those sources are returned; otherwise all retrieved sources are shown. Citation markers are
stripped from replayed history because labels restart every turn.

Streaming uses the same code path: when an `onEvent` callback is present the LLM call streams tokens, and the
orchestrator emits `tool_start` / `tool_end` events. If a round turns out to be a tool call after some text was
streamed, a `reset` event tells the UI to discard that preamble.

## Tool registry — the security boundary

```
model output ──► name registered? ──► role allowed? ──► Zod parse ──► execute(args, trustedCtx) with timeout
                      │ no                 │ no              │ fail              │ throws
                      ▼                    ▼                 ▼                   ▼
                 error result         DENIED result     error result     ToolError → message
                                                                         other     → generic message + log
```

Every outcome is returned to the model as data (so it can recover) and written to `ToolExecution`.
`ToolContext` carries `userId`, `userRole`, `conversationId` and an `AbortSignal`; arguments never carry identity.

## Access control

Policy (`modules/access/access.policy.ts`): owner, **or** ORGANIZATION + classification ≤ clearance, **or** GROUPS ∩ user's groups ≠ ∅ + classification ≤ clearance.

- **Principal.** `{ userId, role, clearance, groupIds }`, loaded from PostgreSQL on every authenticated request. Nothing about access is baked into the JWT, so changes apply immediately.
- **Vector payload.** Each chunk carries `userId`, `visibility`, `classification`, `classificationLevel` (integer, range-filterable) and `groupIds`, all keyword/integer indexed. The Qdrant filter is a `should` of three clauses: owner, org + level, groups + level.
- **Two layers.** Qdrant filters inside the similarity search, so restricted chunks don't consume top-k slots. `RetrievalService` then re-checks every hit's document against PostgreSQL. A restriction is written to PostgreSQL first and enforced at once, even if the Qdrant payload update lags or fails. Widening access only takes effect once the payload sync succeeds, so failures fail closed.
- **Ingestion.** The payload is built from the document's sharing settings at indexing time. If sharing changes while embedding is in progress, the job re-syncs after committing.
- **Group deletion** cascades `DocumentGroupAccess` rows, and the affected documents' payloads are re-synced.
- **Audit.** `AuditEvent` records sharing at upload, access changes, admin deletions, group create/delete, and user role/clearance/membership changes.

## Data model

See `prisma/schema.prisma`. PostgreSQL is the system of record; Qdrant holds chunk text + vectors with a payload
of `{ userId, documentId, fileName, chunkIndex, content, pageStart, pageEnd }`. `DocumentChunk` maps each chunk
to its Qdrant point id so vectors can be audited and deleted. All child rows cascade on delete.

## Failure handling

| Failure | Behaviour |
|---|---|
| Ollama unreachable / 5xx / 429 | Retried twice with exponential backoff (not for timeouts or mid-stream errors) → `502` / SSE `error` |
| Ollama timeout | `504`, no retry |
| Model not pulled | Clear message: ``run `ollama pull <model>` `` |
| Tool throws / times out | Error result fed back to the model; turn continues |
| Model loops on tools | Forced final answer after `MAX_TOOL_ROUNDS` |
| Client disconnects | `AbortSignal` cancels the in-flight Ollama request |
| Qdrant down at startup | Retried, then the API exits with a clear message |
| Ingestion fails | Document `FAILED` with a user-readable reason; partial vectors removed |
