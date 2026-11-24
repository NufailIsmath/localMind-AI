import type { LlmChatRequest, LlmChatResult, LlmService } from "../../src/ai/types.js";

export type Step = LlmChatResult | ((req: LlmChatRequest) => LlmChatResult | Promise<LlmChatResult>);

export const say = (content: string): LlmChatResult => ({ content, toolCalls: [] });
export const callTool = (name: string, args: Record<string, unknown> = {}, content = ""): LlmChatResult => ({
  content,
  toolCalls: [{ name, arguments: args }],
});

/** Replays a fixed script of model turns and records every request. */
export class ScriptedLlm implements LlmService {
  readonly model = "scripted";
  readonly requests: LlmChatRequest[] = [];
  private i = 0;

  constructor(private readonly steps: Step[]) {}

  async chat(req: LlmChatRequest): Promise<LlmChatResult> {
    // Snapshot messages: the orchestrator mutates the array after the call.
    this.requests.push({ ...req, messages: [...req.messages] });
    const step = this.steps[this.i++];
    if (!step) throw new Error(`ScriptedLlm: no step #${this.i}`);
    const result = typeof step === "function" ? await step(req) : step;
    if (req.onToken && result.content) {
      for (const token of result.content.split(/(?<= )/)) req.onToken(token);
    }
    return result;
  }
}
