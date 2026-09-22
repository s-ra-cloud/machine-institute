import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
    constructor(_options: unknown) {}
  },
}));

import { generateWithConfig, runToolLoop } from "../model-service";
import { isContextOverflow } from "../llm-context";
import { ReproductionSession } from "../reproduction-session";

const config = {
  providerMode: "platform" as const,
  provider: "openrouter",
  modelName: "deepinfra/meta-llama/Llama-3.1-8B-Instruct",
};
const call = {
  id: "call-1",
  type: "function",
  function: { name: "run_command", arguments: JSON.stringify({ command: "python reproduce.py" }) },
};

describe("tool-loop context protection", () => {
  beforeEach(() => {
    createMock.mockReset();
    process.env.OPENROUTER_API_KEY = "test-key";
  });

  it("retries a context rejection in place without rerunning the tool", async () => {
    createMock
      .mockRejectedValueOnce(new Error("maximum context length is 32768 tokens"))
      .mockResolvedValueOnce({ choices: [{ message: { content: null, tool_calls: [call] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: "done", tool_calls: [] } }] });
    const execute = vi.fn(async () => "exit code 0");

    const result = await runToolLoop(
      config,
      "system",
      "initial " + "paper ".repeat(1_000),
      [{ name: "run_command", description: "run", parameters: { type: "object" } }],
      execute,
      {
        maxToolCalls: 2,
        deadlineMs: Date.now() + 60_000,
        contextProtection: {
          getState: () => "exact state",
          compactUserMessage: "Continue from the existing ledger.",
        },
      },
    );

    expect(result.content).toBe("done");
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[1][0].messages.at(-1)).toEqual({ role: "user", content: "exact state" });
  });

  it("bounds persistent context rejection retries", async () => {
    createMock.mockRejectedValue(new Error("prompt is too long for this model"));
    let thrown: unknown;
    try {
      await runToolLoop(
        config,
        "system",
        "initial " + "paper ".repeat(1_000),
        [],
        async () => "must not execute",
        {
          maxToolCalls: 1,
          deadlineMs: Date.now() + 60_000,
          contextProtection: {
            getState: () => "state",
            compactUserMessage: "Continue.",
          },
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(String((thrown as Error).message)).not.toContain("prompt is too long");
    expect(createMock.mock.calls.length).toBe(2);
  });

  it("does not retry below a protected floor", async () => {
    createMock.mockRejectedValue(new Error(
      "The sum of prompt length (35175.0), query length (0) should not exceed max_num_tokens (32768)",
    ));
    await expect(runToolLoop(
      config, "system", "paper ".repeat(1000), [], async () => "must not execute",
      {
        maxToolCalls: 1,
        deadlineMs: Date.now() + 60_000,
        protectedInputFloor: 20_000,
        contextProtection: { getState: () => "state", compactUserMessage: "Continue." },
      },
    )).rejects.toThrow(/remained too large/);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("sanitizes an unrelated provider exception without exposing its body", async () => {
    const original = Object.assign(new Error("service unavailable"), { status: 503 });
    createMock.mockRejectedValueOnce(original);
    let thrown: unknown;
    try {
      await runToolLoop(
        config, "system", "paper", [], async () => "must not execute",
        {
          maxToolCalls: 1,
          deadlineMs: Date.now() + 60_000,
          contextProtection: { getState: () => "state" },
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBe(original);
    expect((thrown as Error).message).toBe("LLM context request failed (503)");
    expect((thrown as Error).message).not.toContain("service unavailable");
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("preserves forced-final STOP after archiving long drafts and repair instructions", async () => {
    const session = new ReproductionSession(() => []);
    const draft = "UNFINISHED_DRAFT ".repeat(4000);
    const repair = "Continue repair of the pending claims. ".repeat(1500);
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: draft } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: null, tool_calls: [call] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: "Honest resource-stop logbook." } }] });
    const execute = vi.fn(async () => "exit code 0\nMEASURED=1");
    const result = await runToolLoop(config, "IMMUTABLE CUSTOM SCIENTIFIC INSTRUCTIONS", "paper", [
      { name: "run_command", description: "run", parameters: { type: "object" } },
    ], execute, {
      maxToolCalls: 1,
      deadlineMs: Date.now() + 60000,
      maxPrematureStopRecoveries: 2,
      onPrematureStop: () => repair,
      contextProtection: {
        getState: maxBytes => session.contextState(maxBytes),
        archiveContext: (key, text) => session.archiveContext(key, text),
      },
    });
    expect(result.stoppedBy).toBe("tool-budget");
    expect(result.content).toBe("Honest resource-stop logbook.");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(3);
    const forced = createMock.mock.calls[2][0];
    expect(forced.tools).toBeUndefined();
    expect(forced.messages[0].content).toBe("IMMUTABLE CUSTOM SCIENTIFIC INSTRUCTIONS");
    expect(forced.messages.some((message: any) =>
      message.role === "user" && message.content.startsWith("STOP:") && message.content.includes("Do not call any more tools"))).toBe(true);
    expect(JSON.stringify(forced)).not.toContain(draft);
    const indexPage = JSON.parse(session.readContext({}));
    expect(indexPage.text).toContain("assistant-2");
    expect(indexPage.text).toContain("user-3");
  });

  it("keeps resource-stop fallback when local fitting fails and reports only sizes", async () => {
    let state = "small initial state";
    const diagnostic = vi.fn();
    createMock.mockResolvedValueOnce({ choices: [{ message: { content: null, tool_calls: [call] } }] });
    const execute = vi.fn(async () => {
      state = "PRIVATE_GENERATED_STATE ".repeat(4000);
      return "exit code 0";
    });
    const result = await runToolLoop(config, "system", "paper", [
      { name: "run_command", description: "run", parameters: { type: "object" } },
    ], execute, {
      maxToolCalls: 1,
      deadlineMs: Date.now() + 60000,
      allowResourceStopFallback: true,
      contextProtection: { getState: () => state, onDiagnostic: diagnostic },
    });
    expect(result).toMatchObject({ content: "", stoppedBy: "tool-budget" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(diagnostic.mock.calls[0][0]).toContain("generated-state");
    expect(diagnostic.mock.calls[0][0]).toMatch(/state=\d+/);
    expect(diagnostic.mock.calls[0][0]).not.toContain("PRIVATE_GENERATED_STATE");
    expect(diagnostic.mock.calls[0][0]).not.toContain("Shorten custom instructions");
  });

  it("does not issue a context retry after diagnostics consume the deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    createMock.mockRejectedValueOnce(new Error("maximum context length is 32768 tokens"));
    const result = await runToolLoop(
      config,
      "system",
      "initial " + "paper ".repeat(1_000),
      [],
      async () => "must not execute",
      {
        maxToolCalls: 1,
        deadlineMs: 150,
        contextProtection: {
          getState: () => "state",
          compactUserMessage: "Continue.",
          onDiagnostic: () => now.mockReturnValue(200),
        },
      },
    );
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.stoppedBy).toBe("deadline");
    now.mockRestore();
  });

  it("recognizes an Anthropic 200 error body without exposing its prompt", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        type: "error",
        error: { type: "invalid_request_error", message: "prompt is too long PRIVATE_PROMPT_MARKER max_num_tokens (32768)" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    let thrown: unknown;
    try {
      await generateWithConfig(
        { providerMode: "byoc", provider: "anthropic", modelName: "claude-sonnet-4-20250514", apiKey: "test" },
        "system",
        "PRIVATE_USER_PROMPT",
        { contextRequest: true, timeoutMs: 50 },
      );
    } catch (error) {
      thrown = error;
    }
    expect(isContextOverflow(thrown)).toBe(true);
    expect(String((thrown as Error).message)).not.toContain("PRIVATE_PROMPT_MARKER");
    vi.unstubAllGlobals();
  });
});