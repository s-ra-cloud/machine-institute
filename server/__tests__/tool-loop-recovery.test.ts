import { beforeEach, describe, expect, it, vi } from "vitest";

const createCompletion = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createCompletion } };
  },
}));

import { runToolLoop, type ModelProviderConfig } from "../model-service";

const config: ModelProviderConfig = {
  providerMode: "platform",
  provider: "openrouter",
  modelName: "deepseek/deepseek-chat",
};

const completion = (content: string | null, toolCalls?: unknown[]) => ({
  choices: [{
    message: {
      content,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    },
  }],
});

describe("Tool loop — premature-stop recovery", () => {
  beforeEach(() => {
    createCompletion.mockReset();
    process.env.OPENROUTER_API_KEY = "test-key";
  });

  it("adds the continuation after a premature stop and re-enables tools", async () => {
    createCompletion
      .mockResolvedValueOnce(completion(null, [{
        id: "call-1",
        type: "function",
        function: {
          name: "record_result",
          arguments: JSON.stringify({ id: "R1", status: "pending" }),
        },
      }]))
      .mockResolvedValueOnce(completion(null))
      .mockResolvedValueOnce(completion("## Claims\nR1 finalized."));

    let stopChecks = 0;
    const result = await runToolLoop(
      config,
      "system",
      "user",
      [{
        name: "record_result",
        description: "Record a result",
        parameters: { type: "object" },
      }],
      async () => "recorded",
      {
        maxToolCalls: 10,
        deadlineMs: Date.now() + 60_000,
        onPrematureStop: () => {
          stopChecks++;
          return stopChecks === 1 ? "Continue the unfinished reproduction." : null;
        },
        maxPrematureStopRecoveries: 2,
      },
    );

    expect(result.content).toContain("R1 finalized");
    expect(createCompletion).toHaveBeenCalledTimes(3);
    const recoveryRequest = createCompletion.mock.calls[2][0];
    expect(recoveryRequest.tools).toBeDefined();
    expect(recoveryRequest.messages).toContainEqual({
      role: "user",
      content: "Continue the unfinished reproduction.",
    });
  });

  it("stops after the configured number of recovery attempts", async () => {
    createCompletion
      .mockResolvedValueOnce(completion(""))
      .mockResolvedValueOnce(completion(""))
      .mockResolvedValueOnce(completion(""));

    const result = await runToolLoop(
      config,
      "system",
      "user",
      [],
      async () => "",
      {
        maxToolCalls: 10,
        deadlineMs: Date.now() + 60_000,
        onPrematureStop: () => "Continue.",
        maxPrematureStopRecoveries: 2,
      },
    );

    expect(result.content).toBe("");
    expect(createCompletion).toHaveBeenCalledTimes(3);
  });

  it("does not recover after the deadline forces finalization", async () => {
    createCompletion.mockResolvedValueOnce(completion("Final logbook"));
    const onPrematureStop = vi.fn(() => "Continue.");

    const result = await runToolLoop(
      config,
      "system",
      "user",
      [],
      async () => "",
      {
        maxToolCalls: 10,
        deadlineMs: Date.now() - 1,
        onPrematureStop,
        maxPrematureStopRecoveries: 2,
      },
    );

    expect(result.stoppedBy).toBe("deadline");
    expect(onPrematureStop).not.toHaveBeenCalled();
    expect(createCompletion.mock.calls[0][0].tools).toBeUndefined();
  });

  it("can show stable numeric evidence IDs in tool results", async () => {
    createCompletion
      .mockResolvedValueOnce(completion(null, [{
        id: "call-1",
        type: "function",
        function: { name: "run_command", arguments: JSON.stringify({ command: "python test.py" }) },
      }]))
      .mockResolvedValueOnce(completion("Done."));

    await runToolLoop(
      config,
      "system",
      "user",
      [{ name: "run_command", description: "Run", parameters: { type: "object" } }],
      async () => "exit code 0",
      {
        maxToolCalls: 10,
        deadlineMs: Date.now() + 60_000,
        numberToolResults: true,
      },
    );

    expect(createCompletion.mock.calls[1][0].messages).toContainEqual({
      role: "tool",
      tool_call_id: "call-1",
      content: "[Tool call #1]\nexit code 0",
    });
  });

  it("preserves numeric evidence IDs when old tool output is compacted", async () => {
    let request = 0;
    createCompletion.mockImplementation(async () => {
      request++;
      if (request <= 10) {
        return completion(null, [{
          id: `call-${request}`,
          type: "function",
          function: { name: "run_command", arguments: JSON.stringify({ command: `python test-${request}.py` }) },
        }]);
      }
      return completion("Done.");
    });

    await runToolLoop(
      config,
      "system",
      "user",
      [{ name: "run_command", description: "Run", parameters: { type: "object" } }],
      async () => `exit code 0\n${"x".repeat(500)}`,
      {
        maxToolCalls: 20,
        deadlineMs: Date.now() + 60_000,
        numberToolResults: true,
        contextCharBudget: 1_200,
      },
    );

    const finalMessages = createCompletion.mock.calls.at(-1)?.[0].messages;
    expect(finalMessages).toContainEqual({
      role: "tool",
      tool_call_id: "call-1",
      content: "[Tool call #1]\n[earlier tool output elided to fit the context window — re-run the tool if you need it again]",
    });
  });
});