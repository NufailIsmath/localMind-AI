import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ToolRegistry, toParametersSchema } from "../../src/modules/tools/tool.registry.js";
import { ToolError, defineTool, type ToolContext } from "../../src/modules/tools/tool.types.js";
import { calculate, calculatorTool } from "../../src/modules/tools/tools/calculator.tool.js";
import { getCurrentTimeTool } from "../../src/modules/tools/tools/time.tool.js";

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  userId: "user-1",
  userRole: "USER",
  principal: { userId: "user-1", role: over.userRole ?? "USER", clearance: "INTERNAL", groupIds: [] },
  conversationId: "conv-1",
  signal: new AbortController().signal,
  addSources: () => [],
  ...over,
});

const echo = defineTool({
  name: "echo",
  description: "Echo",
  schema: z.object({ text: z.string().min(1) }),
  async execute({ text }, c) {
    return { text, userId: c.userId };
  },
});

describe("ToolRegistry", () => {
  it("validates arguments with Zod before executing", async () => {
    const execute = vi.fn(echo.execute);
    const reg = new ToolRegistry(1000).register({ ...echo, execute });
    const bad = await reg.execute("echo", { text: "" }, ctx());
    expect(bad.status).toBe("ERROR");
    expect(bad.status !== "SUCCESS" && bad.error).toMatch(/Invalid arguments for echo/);
    expect(execute).not.toHaveBeenCalled();

    const good = await reg.execute("echo", { text: "hi" }, ctx());
    expect(good).toMatchObject({ status: "SUCCESS", output: { text: "hi", userId: "user-1" } });
  });

  it("takes identity from the trusted context, not from model arguments", async () => {
    const reg = new ToolRegistry(1000).register(echo);
    const res = await reg.execute("echo", { text: "x", userId: "attacker" }, ctx());
    expect(res).toMatchObject({ status: "SUCCESS", output: { userId: "user-1" } });
  });

  it("rejects unknown tools and lists the available ones", async () => {
    const reg = new ToolRegistry(1000).register(echo);
    const res = await reg.execute("rm_rf", {}, ctx());
    expect(res).toMatchObject({ status: "ERROR" });
    expect(res.status !== "SUCCESS" && res.error).toContain("Available tools: echo");
  });

  it("enforces role permissions at listing and execution time", async () => {
    const adminOnly = defineTool({ ...echo, name: "admin_echo", requiredRole: "ADMIN" });
    const reg = new ToolRegistry(1000).register(echo).register(adminOnly);
    expect(reg.specs("USER").map((s) => s.name)).toEqual(["echo"]);
    expect(reg.specs("ADMIN").map((s) => s.name)).toEqual(["echo", "admin_echo"]);
    expect(await reg.execute("admin_echo", { text: "x" }, ctx())).toMatchObject({ status: "DENIED" });
    expect(await reg.execute("admin_echo", { text: "x" }, ctx({ userRole: "ADMIN" }))).toMatchObject({ status: "SUCCESS" });
  });

  it("times out slow tools and aborts their signal", async () => {
    let aborted = false;
    const slow = defineTool({
      name: "slow",
      description: "slow",
      schema: z.object({}),
      timeoutMs: 30,
      execute: (_a, c) =>
        new Promise((resolve) => {
          c.signal.addEventListener("abort", () => (aborted = true));
          setTimeout(resolve, 500);
        }),
    });
    const res = await new ToolRegistry(1000).register(slow).execute("slow", {}, ctx());
    expect(res).toMatchObject({ status: "ERROR", error: "Tool slow timed out after 30ms" });
    expect(aborted).toBe(true);
  });

  it("returns ToolError messages but masks unexpected internal errors", async () => {
    const onUnexpected = vi.fn();
    const reg = new ToolRegistry(1000, onUnexpected)
      .register(defineTool({ name: "known", description: "", schema: z.object({}), execute: async () => { throw new ToolError("Nice message"); } }))
      .register(defineTool({ name: "boom", description: "", schema: z.object({}), execute: async () => { throw new Error("password=hunter2 at db:5432"); } }));
    expect(await reg.execute("known", {}, ctx())).toMatchObject({ status: "ERROR", error: "Nice message" });
    const res = await reg.execute("boom", {}, ctx());
    expect(res).toMatchObject({ status: "ERROR", error: "The boom tool failed due to an internal error" });
    expect(onUnexpected).toHaveBeenCalledOnce();
  });

  it("propagates cancellation of the whole request", async () => {
    const controller = new AbortController();
    const hang = defineTool({
      name: "hang",
      description: "",
      schema: z.object({}),
      execute: (_a, c) => new Promise((_, reject) => c.signal.addEventListener("abort", () => reject(new Error("aborted")))),
    });
    const p = new ToolRegistry(5000).register(hang).execute("hang", {}, ctx({ signal: controller.signal }));
    controller.abort();
    await expect(p).rejects.toThrow("aborted");
  });

  it("refuses invalid or duplicate tool names", () => {
    expect(() => new ToolRegistry(1).register({ ...echo, name: "Bad Name" })).toThrow();
    expect(() => new ToolRegistry(1).register(echo).register(echo)).toThrow(/already registered/);
  });

  it("produces Ollama-compatible JSON schema parameters", () => {
    expect(toParametersSchema(calculatorTool.schema)).toEqual({
      type: "object",
      properties: {
        a: { type: "number", description: "First operand" },
        b: { type: "number", description: "Second operand" },
        operation: {
          type: "string",
          enum: ["add", "subtract", "multiply", "divide", "power", "modulo"],
          description: "Operation to apply: a <op> b",
        },
      },
      required: ["a", "b", "operation"],
    });
    expect(toParametersSchema(z.object({}))).toMatchObject({ type: "object", properties: {}, required: [] });
  });
});

describe("calculate tool", () => {
  it.each([
    [2, 3, "add", 5],
    [2, 3, "subtract", -1],
    [2, 3, "multiply", 6],
    [3, 2, "divide", 1.5],
    [2, 10, "power", 1024],
    [10, 3, "modulo", 1],
  ] as const)("%d %s %d", (a, b, op, expected) => {
    expect(calculate(a, b, op)).toBe(expected);
  });

  it("rejects division by zero and non-finite results", () => {
    expect(() => calculate(1, 0, "divide")).toThrow("Division by zero");
    expect(() => calculate(1, 0, "modulo")).toThrow("Division by zero");
    expect(() => calculate(10, 400, "power")).toThrow("finite");
  });

  it("validates operation names through the registry", async () => {
    const reg = new ToolRegistry(1000).register(calculatorTool);
    expect(await reg.execute("calculate", { a: 1, b: 2, operation: "eval" }, ctx())).toMatchObject({ status: "ERROR" });
    expect(await reg.execute("calculate", { a: "1", b: 2, operation: "add" }, ctx())).toMatchObject({ status: "ERROR" });
    expect(await reg.execute("calculate", { a: 6, b: 7, operation: "multiply" }, ctx())).toMatchObject({
      status: "SUCCESS",
      output: { result: 42 },
    });
  });
});

describe("get_current_time tool", () => {
  const fixed = new Date("2026-03-01T12:34:56Z");
  const reg = new ToolRegistry(1000).register(getCurrentTimeTool(() => fixed));

  it("returns ISO and localised time", async () => {
    const res = await reg.execute("get_current_time", { timezone: "Asia/Colombo" }, ctx());
    expect(res).toMatchObject({ status: "SUCCESS", output: { iso: "2026-03-01T12:34:56.000Z", timeZone: "Asia/Colombo" } });
    expect(res.status === "SUCCESS" && (res.output as { local: string }).local).toContain("18:04:56");
  });

  it("rejects unknown time zones", async () => {
    expect(await reg.execute("get_current_time", { timezone: "Mars/Olympus" }, ctx())).toMatchObject({
      status: "ERROR",
      error: 'Unknown time zone "Mars/Olympus"',
    });
  });
});
