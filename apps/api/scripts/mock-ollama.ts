/**
 * Starts a rule-based fake Ollama server for demos/E2E tests on machines that
 * can't run the real models:
 *
 *   npm run mock:ollama -w @clbuddy/api    # listens on 127.0.0.1:11434
 *
 * Answers are pattern-matched, not generated. Use real Ollama for anything else.
 */
import { startFakeOllama } from "../test/helpers/fake-ollama-server.js";

const port = Number(process.env.MOCK_OLLAMA_PORT ?? 11434);
const fake = await startFakeOllama(
  {
    chatModel: process.env.CHAT_MODEL ?? "qwen3:8b",
    embeddingModel: process.env.EMBEDDING_MODEL ?? "nomic-embed-text",
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 768),
    tokenDelayMs: Number(process.env.MOCK_OLLAMA_TOKEN_DELAY_MS ?? 25),
    host: process.env.MOCK_OLLAMA_HOST ?? "127.0.0.1",
  },
  port,
);
console.log(`Mock Ollama listening on ${fake.url}`);
