import { z } from "zod";
import { ToolError, defineTool } from "../tool.types.js";

const OPERATIONS = ["add", "subtract", "multiply", "divide", "power", "modulo"] as const;
export type Operation = (typeof OPERATIONS)[number];

export function calculate(a: number, b: number, operation: Operation): number {
  if ((operation === "divide" || operation === "modulo") && b === 0) throw new ToolError("Division by zero");
  let result: number;
  switch (operation) {
    case "add":
      result = a + b;
      break;
    case "subtract":
      result = a - b;
      break;
    case "multiply":
      result = a * b;
      break;
    case "divide":
      result = a / b;
      break;
    case "power":
      result = a ** b;
      break;
    case "modulo":
      result = a % b;
      break;
  }
  if (!Number.isFinite(result)) throw new ToolError("Result is not a finite number");
  return result;
}

/**
 * Deliberately a fixed set of binary operations rather than an expression
 * evaluator: the model never gets anything resembling `eval`.
 */
export const calculatorTool = defineTool({
  name: "calculate",
  description:
    "Perform an exact arithmetic operation on two numbers. Use this instead of doing arithmetic yourself. " +
    "For multi-step calculations call it once per step.",
  schema: z.object({
    a: z.number().describe("First operand"),
    b: z.number().describe("Second operand"),
    operation: z.enum(OPERATIONS).describe("Operation to apply: a <op> b"),
  }),
  async execute({ a, b, operation }) {
    return { expression: `${a} ${operation} ${b}`, result: calculate(a, b, operation) };
  },
});
