# Using a hosted AI provider (e.g. Roar AI)

By default CL Buddy runs its models locally with Ollama. It can instead use any
hosted provider that offers an **OpenAI-compatible API**: Roar AI, OpenAI,
OpenRouter, Together, Groq and others. Nothing else changes: access control,
tools, citations, leave and the content guardrails all work the same way.

## Before you switch: what leaves your machines

With a hosted provider, **each chat turn is sent to the provider**: the user's
message, recent history, the system prompt, and the document passages
retrieved for that user. Access control still applies (the model only ever
sees what that user may read), but those passages, including Confidential
ones such as payroll for HR staff, are processed by the provider.

- Check the provider's data-processing terms (retention, training on your
  data, data location) before sending company documents.
- To keep the documents themselves off the provider, run **embeddings locally**
  (`EMBEDDING_PROVIDER=ollama`, the cheapest option anyway).
  Passages retrieved for a question still go to the chat model.
- The app says so: the header shows **"AI by Roar AI"** instead of
  "All systems local", and the assistant no longer claims to run locally.

## 1. Get the details from the provider

From the provider's dashboard (for Roar AI, sign up and open the API keys page):

| You need | Example |
|---|---|
| **Base URL** of the OpenAI-compatible API, including the version | `https://<provider host>/v1` |
| **API key** | `sk-…` |
| A **chat model** that supports **tool/function calling** | e.g. `gpt-4o-mini`, a Llama 3.1/3.3 70B, Qwen 2.5 72B… |
| (optional) an **embedding model** and its dimensions | e.g. `text-embedding-3-small` = 1536 |
| (optional) a **Llama Guard** model | e.g. `meta-llama/Llama-Guard-3-8B` |

Tool calling matters: CL Buddy searches documents, checks leave and looks up
teams through tools. A model without it will answer from general knowledge.

## 2. Configure `.env`

**Recommended: hosted chat, local embeddings and Llama Guard.** Documents stay
local for indexing, no re-indexing is needed, and Ollama only runs two small
models (about 2 GB):

```bash
AI_PROVIDER=openai
AI_BASE_URL=https://<provider host>/v1
AI_API_KEY=<your key>
AI_PROVIDER_LABEL=Roar AI
CHAT_MODEL=<a tool-calling model from the provider>
EMBEDDING_PROVIDER=ollama
GUARD_PROVIDER=ollama
```

**Fully hosted (no Ollama at all):**

```bash
AI_PROVIDER=openai
AI_BASE_URL=https://<provider host>/v1
AI_API_KEY=<your key>
AI_PROVIDER_LABEL=Roar AI
CHAT_MODEL=<a tool-calling model>
EMBEDDING_MODEL=<embedding model>
EMBEDDING_DIMENSIONS=<its dimensions>
QDRANT_COLLECTION=documents_hosted   # a new index for the new embeddings
GUARD_MODEL=<the provider's Llama Guard model>   # or MODERATION_GUARD=off
```

Then re-embed the existing documents once: `npm run reindex:all` (Docker:
`docker compose exec api npx tsx scripts/reindex-all.ts`).

Settings are checked at startup, with a clear message for anything missing.
The key must go to an `https://` address and is never logged or shown in
errors.

## 3. Start

```bash
# development
npm run dev:api

# Docker, fully hosted: no Ollama containers needed
docker compose up -d --build postgres qdrant api web

# Docker, hosted chat + local embeddings/guard: Ollama pulls only those two
docker compose up -d --build
```

Check **Organization → health** (hover the header badge) or
`GET /api/health` with a token: it shows `ai: ok — <models> via Roar AI`, or
what's wrong.

## When the trial ends (or the key stops working)

| What you'll see | Meaning |
|---|---|
| Health: "Roar AI rejected the API key"; chat: "HTTP 401 … check AI_API_KEY, and that the trial hasn't expired" | Key revoked or trial over |
| "out of credit" (HTTP 402) | Billing needed |
| "rate limit or quota reached" (HTTP 429) | Retried automatically a couple of times, then shown |
| "missing models: …" in health | A model name isn't in the provider's list |

To go back to local models at any time, set `AI_PROVIDER=ollama` (and remove
the `EMBEDDING_*`/`QDRANT_COLLECTION` changes if you made them) and restart.
With the recommended setup (local embeddings), switching back and forth needs
no re-indexing.

## Cost

Hosted pricing is per token. A typical CL Buddy turn (system prompt + tools +
a few retrieved passages) is roughly 3–6k input tokens and a few hundred
output tokens, plus a second call when a tool is used. Llama Guard adds two
short calls per turn if it's hosted (`GUARD_PROVIDER=ollama` keeps those
free). Set a spend limit in the provider's dashboard.
