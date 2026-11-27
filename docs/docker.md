# Running CL Buddy with Docker

Everything runs in Docker: the web app, API, PostgreSQL, Qdrant and Ollama with
the AI models. You need Docker Desktop (or Docker Engine + Compose v2) and
about **10 GB of free disk space** (the chat model alone is ~5 GB).

## 1. Configure

```bash
git clone <your repo> cl-buddy && cd cl-buddy
cp .env.example .env
```

Edit `.env`. The only required change is a real secret:

```bash
JWT_SECRET=<paste the output of: openssl rand -base64 48>
```

Everything else has sensible defaults. In particular, `ALLOW_REGISTRATION=first-user` means the first account you create becomes the administrator, and sign-up closes after that.

## 2. Start

```bash
docker compose up -d --build        # or: npm run docker:up
```

The first run builds the images (a few minutes) and **downloads the models** (`qwen3:8b` ≈ 5 GB, `nomic-embed-text` ≈ 270 MB, and the `llama-guard3:1b` safety classifier ≈ 1.6 GB). Follow the download:

```bash
docker compose logs -f ollama-pull  # ends with "Models ready."
```

Then open **http://localhost:3000** and create your account.

Check every dependency is up:

```bash
curl -s http://localhost:4000/api/health
# {"status":"ok","checks":{"database":{"ok":true},"qdrant":{"ok":true},"ollama":{"ok":true}}}
```

(Log in first to see the model names in the health details.)

### Optional: load the demo company

```bash
docker compose exec api npx tsx scripts/seed-demo.ts   # or: npm run docker:seed
```

This creates `ceo@`, `cfo@`, `hr@`, `engineer@`, `intern@` and `it@demo.local` (password `demo-password`), plus classified documents, teams, leave balances and a pending leave request.

## Choose how the AI model runs

| Your machine | Recommended setup |
|---|---|
| **Mac (Apple Silicon)** | Run Ollama **natively**. Docker on a Mac can't use the GPU, so the in-Docker model is very slow. See below. |
| **Linux / Windows with an NVIDIA GPU** | Ollama in Docker **with the GPU** (needs the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)). |
| **No GPU, 16 GB+ RAM** | The default setup works on CPU, but answers take 20–60 s. Try `CHAT_MODEL=qwen3:4b` in `.env`. |
| **No GPU, or a small one** | A **hosted provider** for chat (e.g. Roar AI): see [hosted-ai.md](hosted-ai.md). Ollama then only runs the small embedding and Llama Guard models, or nothing at all. |
| **Just want to click around** | Mock mode: no downloads, canned answers. |

**NVIDIA GPU**

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

**Ollama installed on your computer (recommended on Mac)**

```bash
ollama pull qwen3:8b && ollama pull nomic-embed-text && ollama pull llama-guard3:1b
echo "DOCKER_OLLAMA_HOST=http://host.docker.internal:11434" >> .env
docker compose up -d --build postgres qdrant api web     # skips the Ollama containers
```

**Mock mode (no models)**

```bash
DOCKER_OLLAMA_HOST=http://mock-ollama:11434 RETRIEVAL_SCORE_THRESHOLD=0.05 RESTRICTED_NOTICE_SCORE_THRESHOLD=0.1 \
  docker compose --profile mock up -d --build postgres qdrant mock-ollama api web
```

The mock pattern-matches instead of generating text, and its toy embeddings need the lower thresholds shown.

## Everyday commands

```bash
docker compose ps                       # what's running
docker compose logs -f api              # API logs
docker compose restart api              # after changing .env
docker compose up -d --build            # after pulling new code
docker compose down                     # stop (data is kept in volumes)
docker compose down -v                  # stop AND delete all data (documents, chats, models)
```

Change models by editing `CHAT_MODEL` in `.env`, then run `docker compose up -d ollama-pull api`. If you change `EMBEDDING_MODEL`, also re-index documents (they're stored as vectors from the old model).

## What's where

| Service | Purpose | Reachable at |
|---|---|---|
| `web` | Next.js UI | http://localhost:3000 |
| `api` | Fastify API (runs database migrations on start) | http://localhost:4000 |
| `postgres` | Users, documents, chats, leave, audit log | internal only |
| `qdrant` | Document vectors | internal only |
| `ollama` | Local models | `127.0.0.1:11434` (so you can run `ollama` commands) |
| `ollama-pull` | One-off model download | exits when done |

Published ports are bound to **127.0.0.1**, so nothing is exposed to your network. Data lives in Docker volumes:

| Volume | Holds |
|---|---|
| `postgres_data` | the database |
| `qdrant_data` | document vectors |
| `ollama_data` | the downloaded models |
| `uploads` | original uploaded files |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `JWT_SECRET` error on `docker compose up` | Set it in `.env` (step 1). |
| Health shows `ollama: ok: false`, or chat says "cannot reach Ollama" | Check `docker compose ps`: is `ollama` running? Are the models downloaded (`docker compose logs ollama-pull`)? If you use your own Ollama, `DOCKER_OLLAMA_HOST` must be `http://host.docker.internal:11434`, never `localhost`. Then `docker compose up -d api`. |
| Documents show **failed** after seeding without a model | Fix the model first, then run the seed again: failed documents are re-uploaded and re-indexed automatically. |
| Chat says "the safety check is unavailable" | Llama Guard isn't downloaded or Ollama can't load it: `docker compose logs ollama-pull`, or `ollama pull llama-guard3:1b` for your own Ollama. To run without it temporarily, set `GUARD_FAIL_MODE=open` (skips it, logged) or `MODERATION_GUARD=off`, then `docker compose up -d api`. |
| Answers are very slow | No GPU in use: use the NVIDIA override, native Ollama on Mac, or `CHAT_MODEL=qwen3:4b`. |
| Browser can't reach the API | The web image has the API address baked in at build time. If you serve it elsewhere, set `PUBLIC_API_URL` and `CORS_ORIGINS` in `.env`, then rebuild: `docker compose up -d --build web api`. |
| Port 3000/4000 already in use | Stop the other app, or change the `ports:` mapping in `docker-compose.yml`. |
| `npm ci` fails during the build behind a corporate proxy | Pass the proxy's CA as a build secret: `docker build --secret id=npm_ca,src=/path/to/ca.pem …`. |

## Notes

- **Image size.** The API image is large (~2.8 GB) because it carries the full dependency set, which lets the demo seed and mock model run inside it. A slimmer production image is a later optimisation.
- **HTTPS.** This setup is for running on your own machine. For a server, put an HTTPS reverse proxy in front, use strong passwords, set up backups, and see the hosting notes.
