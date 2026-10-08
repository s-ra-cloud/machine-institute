import { describe, it, expect, vi, beforeEach } from "vitest";

const { createMock, constructorOptions } = vi.hoisted(() => ({
  createMock: vi.fn(),
  constructorOptions: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class OpenAIMock {
    chat = { completions: { create: createMock } };
    constructor(opts: unknown) { constructorOptions(opts); }
  },
}));

import { runToolLoop, type ToolSpec } from "../model-service";
import { ReproductionReadGuard } from "../reproduction-read-guard";

const tools: ToolSpec[] = [
  { name: "echo", description: "echo", parameters: { type: "object", properties: { text: { type: "string" } } } },
];

function assistantToolCall(id: string, text: string) {
  return { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id, type: "function", function: { name: "echo", arguments: JSON.stringify({ text }) } }] } }] };
}
function assistantFinal(content: string) {
  return { choices: [{ finish_reason: "stop", message: { content, tool_calls: [] } }] };
}

const platform = { providerMode: "platform" as const, provider: "openai", modelName: "openai/gpt-4o" };

describe("runToolLoop", () => {
  it("repairs a missing required call after the general premature-stop reminder was used", async () => {
    createMock
      .mockResolvedValueOnce(assistantFinal("still inspecting"))
      .mockResolvedValueOnce(assistantToolCall("browse", "inspection"))
      .mockResolvedValueOnce(assistantFinal("I have a plan"))
      .mockResolvedValueOnce(assistantToolCall("plan", "accepted"));
    let executions = 0;
    const execute = vi.fn(async () => { executions++; return "ok"; });
    const result = await runToolLoop(platform, "sys", "user", tools, execute, {
      maxToolCalls: 8, deadlineMs: Date.now() + 60_000,
      onPrematureStop: () => "Use the tools.", maxPrematureStopRecoveries: 1,
      getRequiredTool: () => executions === 1 ? "echo" : undefined,
      isStageComplete: () => executions === 2,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.toolCalls).toHaveLength(2);
    expect(createMock).toHaveBeenCalledTimes(4);
    expect(createMock.mock.calls[3][0].tool_choice).toEqual({ type: "function", function: { name: "echo" } });
  });

  it("stops unresolved after one required-call correction rather than returning prose as completion", async () => {
    createMock.mockResolvedValue(assistantFinal("done without the tool"));
    const execute = vi.fn();
    const result = await runToolLoop(platform, "sys", "user", tools, execute, {
      maxToolCalls: 8, deadlineMs: Date.now() + 60_000,
      getRequiredTool: () => "echo",
      onPrematureStop: () => "Continue", maxPrematureStopRecoveries: 20,
    });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    expect(result.stoppedBy).toBe("no-progress");
    expect(result.content).toBe("");
  });

  beforeEach(() => {
    createMock.mockReset();
    constructorOptions.mockReset();
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", "https://managed.example.test");
    vi.stubEnv("LAB_ALLOWED_MODELS", "openai/gpt-4o");
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

  it("stops repetitive reproduction reads before the budget, preserving honest finalization", async () => {
    const guard = new ReproductionReadGuard();
    const readTools: ToolSpec[] = [{
      name: "read_file", description: "read paper",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }];
    let calls = 0;
    createMock.mockImplementation(async (request: any) => {
      if (!request.tools) return assistantFinal("## Claims\nNo claims registered.");
      calls++;
      return { choices: [{
        finish_reason: "tool_calls",
        message: { content: null, tool_calls: [{
          id: `r${calls}`, type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "/work/paper.md" }) },
        }] },
      }] };
    });
    const execute = vi.fn(async () =>
      "Verified file: /work/paper.md\nReturned characters: 0-100 of 1000\n---\nA real paper section");
    const result = await runToolLoop(platform, "sys", "user", readTools, execute, {
      maxToolCalls: 100, deadlineMs: Date.now() + 60_000,
      getStallReason: () => guard.stopReason,
      transformToolResult: (name, text) => guard.observe(name, text, { acceptedClaims: 0, assessed: false }),
    });
    expect(result.stoppedBy).toBe("no-progress");
    expect(result.toolCalls.length).toBeLessThan(20);
    expect(result.toolCalls[0].result).toContain("A real paper section");
    expect(result.toolCalls.at(-1)?.result).toContain("Repeated inspection");
    expect(createMock.mock.calls.at(-1)?.[0].tools).toBeUndefined();
    expect(createMock.mock.calls.at(-1)?.[0].messages.some(
      (message: any) => message.role === "user" && String(message.content).startsWith("STOP:"),
    )).toBe(true);
    expect(execute).toHaveBeenCalledTimes(result.toolCalls.length);
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

  it("rejects a BYOK request without a syntactically valid key before any provider call", async () => {
    await expect(runToolLoop(
      { providerMode: "byoc", provider: "anthropic", modelName: "claude", apiKey: "k" },
      "sys", "user", tools, async () => "", { maxToolCalls: 1, deadlineMs: Date.now() + 1000 },
    )).rejects.toThrow(/API key/i);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("uses Anthropic's OpenAI-compatible endpoint for BYOK tool calls", async () => {
    createMock
      .mockResolvedValueOnce(assistantToolCall("c1", "anthropic-tool"))
      .mockResolvedValueOnce(assistantFinal("Anthropic result"));
    const apiKey = "sk-ant-api03-test-key-123456";
    const execute = vi.fn(async (_name: string, args: Record<string, unknown>) => `done:${args.text}`);

    const result = await runToolLoop(
      { providerMode: "byoc", provider: "anthropic", modelName: "claude-sonnet-4-20250514", apiKey },
      "sys", "user", tools, execute, { maxToolCalls: 1, deadlineMs: Date.now() + 60_000 },
    );

    expect(result.content).toBe("Anthropic result");
    expect(execute).toHaveBeenCalledWith("echo", { text: "anthropic-tool" });
    expect(constructorOptions).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: "https://api.anthropic.com/v1",
      apiKey,
      maxRetries: 0,
    }));
    expect(createMock.mock.calls[0][0]).toMatchObject({
      model: "claude-sonnet-4-20250514",
      tool_choice: "auto",
      tools: [{ type: "function", function: { name: "echo" } }],
    });
  });
});
