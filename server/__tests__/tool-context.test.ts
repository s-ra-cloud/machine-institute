import { describe, expect, it } from "vitest";
import { ContextBudgetError, RequestContextBudget } from "../llm-context";
import { fitToolContext } from "../tool-context";

const config = {
  providerMode: "byoc" as const,
  provider: "openai",
  modelName: "gpt-4o",
};

function budget(inputLimit: number): RequestContextBudget {
  const result = new RequestContextBudget(config, 8_000, "tool-loop", 128_000);
  result.inputLimit = inputLimit;
  return result;
}

describe("fitToolContext", () => {
  it("fits a clone while preserving system, exact state, paired calls, and canonical args", () => {
    const args = JSON.stringify({ command: "python reproduce.py", source: "x".repeat(3_000) });
    const request = {
      model: "gpt-4o",
      tools: [{ type: "function", function: { name: "run_command", parameters: { type: "object" } } }],
      messages: [
        { role: "system", content: "Never omit the evidence contract." },
        { role: "user", content: "A very large initial paper prompt " + "p".repeat(2_000) },
        { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "run_command", arguments: args } }] },
        { role: "tool", tool_call_id: "call-1", content: "[Tool call #1]\n" + "result ".repeat(1_000) },
      ],
    };
    const fitted = fitToolContext(request, {
      budget: budget(1_500),
      protection: {
        getState: () => "Current ledger state",
        compactUserMessage: "Read existing files and continue from the ledger.",
      },
    });

    expect(fitted).not.toBe(request);
    expect(request.messages[1].content).toContain("large initial");
    expect(request.messages[2].tool_calls[0].function.arguments).toBe(args);
    expect(fitted.messages[0]).toEqual(request.messages[0]);
    expect(fitted.messages.at(-1)).toEqual({ role: "user", content: "Current ledger state" });
    expect(JSON.stringify(fitted)).toContain("read_tool_result");
    expect(JSON.stringify(fitted)).toContain("old command arguments omitted");
    const ids = fitted.messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id);
    const declared = fitted.messages.flatMap((m: any) => m.tool_calls ?? []).map((c: any) => c.id);
    expect(ids.every((id: string) => declared.includes(id))).toBe(true);
  });

  it("does not allow a recent-output exemption to bypass the hard bound", () => {
    const request = {
      messages: [
        { role: "system", content: "system" },
        ...Array.from({ length: 10 }, (_, i) => [
          { role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] },
          { role: "tool", tool_call_id: `c${i}`, content: "x".repeat(500) },
        ]).flat(),
      ],
    };
    const fitted = fitToolContext(request, {
      budget: budget(800),
      protection: { getState: () => "state" },
    });
    expect(JSON.stringify(fitted).length).toBeLessThan(JSON.stringify(request).length);
  });

  it("keeps the newest retrieval evidence bounded instead of blanking it", () => {
    const request = {
      messages: [
        { role: "system", content: "system" },
        ...Array.from({ length: 3 }, (_, i) => [
          { role: "assistant", content: "", tool_calls: [{ id: `old-${i}`, type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "x".repeat(500) }) } }] },
          { role: "tool", tool_call_id: `old-${i}`, content: "old noise ".repeat(400) },
        ]).flat(),
        { role: "assistant", content: "", tool_calls: [{ id: "retrieval-1", type: "function", function: { name: "read_tool_result", arguments: JSON.stringify({ index: 1 }) } }] },
        { role: "tool", tool_call_id: "retrieval-1", content: "BEGIN evidence " + "e".repeat(1_500) + " END evidence" },
      ],
    };
    const fitted = fitToolContext(request, {
      budget: budget(3_000),
      protection: { getState: () => "state" },
    });
    const latest = fitted.messages.find((message: any) => message.tool_call_id === "retrieval-1");
    expect(latest.content).toContain("read_tool_result");
    expect(latest.content).toContain("BEGIN");
    expect(latest.content).toMatch(/evidence|nce/);
    expect(latest.content).toContain("output shortened");
  });

  it("throws before a request when system plus exact state is irreducible", () => {
    expect(() => fitToolContext(
      { messages: [{ role: "system", content: "instructions" }] },
      { budget: budget(1), protection: { getState: () => "state" } },
    )).toThrow(ContextBudgetError);
  });
});