import { describe, it, expect, vi, beforeEach } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("openai", () => ({
  default: class OpenAIMock {
    chat = { completions: { create: createMock } };
    constructor(_opts: unknown) {}
  },
}));

import { runToolLoop, type ToolSpec } from "../model-service";

const tools: ToolSpec[] = [
  { name: "echo", description: "echo", parameters: { type: "object", properties: { text: { type: "string" } } } },
];

function assistantToolCall(id: string, text: string) {
  return { choices: [{ message: { content: null, tool_calls: [{ id, type: "function", function: { name: "echo", arguments: JSON.stringify({ text }) } }] } }] };
}
function assistantFinal(content: string) {
  return { choices: [{ message: { content, tool_calls: [] } }] };
}

const platform = { providerMode: "platform" as const, provider: "openrouter", modelName: "test/model" };

describe("runToolLoop", () => {
  beforeEach(() => {
    createMock.mockReset();
    process.env.OPENROUTER_API_KEY = "test-key";
  });

  it("executes tool calls and returns the final assistant message", async () => {
    createMock
      .mockResolvedValueOnce(assistantToolCall("c1", "hello"))
      .mockResolvedValueOnce(assistantFinal("## Logbook\ndone"));
    const execute = vi.fn(async (_name: string, args: Record<string, unknown>) => `echoed:${args.text}`);

    const result = await runToolLoop(platform, "sys", "user", tools, execute, {
      maxToolCalls: 10,
      deadlineMs: Date.now() + 60_000,
    });

    expect(result.content).toBe("## Logbook\ndone");
    expect(result.stoppedBy).toBe("model");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: "echo", args: { text: "hello" }, result: "echoed:hello", error: false });
    expect(execute).toHaveBeenCalledWith("echo", { text: "hello" });

    // The tool result was fed back to the model with the matching call id.
    const secondCallMessages = createMock.mock.calls[1][0].messages;
    const toolMsg = secondCallMessages.find((m: any) => m.role === "tool");
    expect(toolMsg).toMatchObject({ tool_call_id: "c1", content: "echoed:hello" });
  });

  it("forces a tool-free final turn once the tool budget is exhausted", async () => {
    createMock
      .mockResolvedValueOnce(assistantToolCall("c1", "a"))
      .mockResolvedValueOnce(assistantToolCall("c2", "b"))
      .mockResolvedValueOnce(assistantFinal("final logbook"));
    const execute = vi.fn(async () => "ok");

    const result = await runToolLoop(platform, "sys", "user", tools, execute, {
      maxToolCalls: 2,
      deadlineMs: Date.now() + 60_000,
    });

    expect(result.stoppedBy).toBe("tool-budget");
    expect(result.content).toBe("final logbook");
    expect(result.toolCalls).toHaveLength(2);
    const lastRequest = createMock.mock.calls[2][0];
    expect(lastRequest.tools).toBeUndefined();
    const stopMsg = lastRequest.messages.filter((m: any) => m.role === "user").pop();
    expect(stopMsg.content).toMatch(/budget is exhausted/);
  });

  it("records tool errors without aborting the loop", async () => {
    createMock
      .mockResolvedValueOnce(assistantToolCall("c1", "boom"))
      .mockResolvedValueOnce(assistantFinal("recovered"));
    const execute = vi.fn(async () => { throw new Error("kaboom"); });

    const result = await runToolLoop(platform, "sys", "user", tools, execute, {
      maxToolCalls: 5,
      deadlineMs: Date.now() + 60_000,
    });

    expect(result.content).toBe("recovered");
    expect(result.toolCalls[0]).toMatchObject({ error: true });
    expect(result.toolCalls[0].result).toContain("kaboom");
  });

  it("rejects Anthropic BYOC, which has no OpenAI-compatible tool calling here", async () => {
    await expect(runToolLoop(
      { providerMode: "byoc", provider: "anthropic", modelName: "claude", apiKey: "k" },
      "sys", "user", tools, async () => "", { maxToolCalls: 1, deadlineMs: Date.now() + 1000 },
    )).rejects.toThrow(/OpenAI-compatible/);
    expect(createMock).not.toHaveBeenCalled();
  });
});
