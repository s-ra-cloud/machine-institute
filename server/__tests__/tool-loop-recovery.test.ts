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
  provider: "openai",
  modelName: "openai/gpt-4o",
};

const completion = (content: string | null, toolCalls?: unknown[]) => ({
  choices: [{
    finish_reason: toolCalls?.length ? "tool_calls" : "stop",
    message: {
      content,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    },
  }],
});

describe("Tool loop — premature-stop recovery", () => {
  beforeEach(() => {
    createCompletion.mockReset();
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", "https://managed.example.test");
    vi.stubEnv("LAB_ALLOWED_MODELS", "openai/gpt-4o");
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

  it("resets consecutive recovery attempts when progress advances", async () => {
    createCompletion
      .mockResolvedValueOnce(completion(null, [{
        id: "call-1",
        type: "function",
        function: { name: "record_result", arguments: JSON.stringify({ id: "R1" }) },
      }]))
      .mockResolvedValueOnce(completion(""))
      .mockResolvedValueOnce(completion(null, [{
        id: "call-2",
        type: "function",
        function: { name: "record_result", arguments: JSON.stringify({ id: "R2" }) },
      }]))
      .mockResolvedValueOnce(completion(""))
      .mockResolvedValueOnce(completion(null, [{
        id: "call-3",
        type: "function",
        function: { name: "record_result", arguments: JSON.stringify({ id: "R3" }) },
      }]))
      .mockResolvedValueOnce(completion(""))
      .mockResolvedValueOnce(completion("Finished after making progress."));

    let progress = 0;
    let stopChecks = 0;
    const result = await runToolLoop(
      config,
      "system",
      "user",
      [{ name: "record_result", description: "Record", parameters: { type: "object" } }],
      async () => "recorded",
      {
        maxToolCalls: 10,
        deadlineMs: Date.now() + 60_000,
        onPrematureStop: () => {
          stopChecks++;
          return stopChecks <= 3 ? "Continue." : null;
        },
        getRecoveryProgress: () => progress,
        onToolCall: () => {
          progress++;
        },
        maxPrematureStopRecoveries: 2,
      },
    );

    expect(result.content).toContain("Finished after making progress.");
    expect(result.stoppedBy).toBe("model");
    expect(progress).toBe(3);
    expect(createCompletion).toHaveBeenCalledTimes(7);
  });

  it("bounds repeated no-progress recovery and reports no-progress", async () => {
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
        getRecoveryProgress: () => 7,
        maxPrematureStopRecoveries: 2,
      },
    );

    expect(result.stoppedBy).toBe("no-progress");
    expect(createCompletion).toHaveBeenCalledTimes(3);
  });

  it("does not reset recovery attempts when progress repeats the same value", async () => {
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
        getRecoveryProgress: () => 3,
        maxPrematureStopRecoveries: 2,
      },
    );

    expect(result.stoppedBy).toBe("no-progress");
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

  it("does not dispatch the next tool when a batch crosses the deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    createCompletion
      .mockResolvedValueOnce(completion(null, [
        {
          id: "call-1",
          type: "function",
          function: { name: "run_command", arguments: JSON.stringify({ command: "one" }) },
        },
        {
          id: "call-2",
          type: "function",
          function: { name: "run_command", arguments: JSON.stringify({ command: "two" }) },
        },
      ]))
      .mockResolvedValueOnce(completion("Finished."));

    const execute = vi.fn(async () => {
      now.mockReturnValue(200);
      return "exit code 0";
    });
    const result = await runToolLoop(
      config,
      "system",
      "user",
      [{ name: "run_command", description: "Run", parameters: { type: "object" } }],
      execute,
      {
        maxToolCalls: 10,
        deadlineMs: 150,
      },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.stoppedBy).toBe("deadline");
    expect(result.toolCalls).toHaveLength(1);
    const finalRequestMessages = createCompletion.mock.calls[1][0].messages;
    expect(finalRequestMessages).toContainEqual({
      role: "tool",
      tool_call_id: "call-2",
      content: "Deadline exhausted — this call was not executed. Write your final logbook.",
    });
    now.mockRestore();
  });

  it("refuses every excess call in a tool batch without counting or publishing it", async () => {
    createCompletion
      .mockResolvedValueOnce(completion(null, [1, 2, 3, 4].map(index => ({
        id: `call-${index}`,
        type: "function",
        function: { name: "run_command", arguments: JSON.stringify({ command: `command-${index}` }) },
      }))))
      .mockResolvedValueOnce(completion("Finished."));

    const execute = vi.fn(async () => "exit code 0");
    const published: unknown[] = [];
    const result = await runToolLoop(
      config,
      "system",
      "user",
      [{ name: "run_command", description: "Run", parameters: { type: "object" } }],
      execute,
      {
        maxToolCalls: 2,
        deadlineMs: Date.now() + 60_000,
        numberToolResults: true,
        onToolCall: record => published.push(record),
      },
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(published).toHaveLength(2);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.every(record => record.index <= 2)).toBe(true);
    const finalRequestMessages = createCompletion.mock.calls[1][0].messages;
    expect(finalRequestMessages).toContainEqual({
      role: "tool",
      tool_call_id: "call-3",
      content: "Tool budget exhausted — this call was not executed. Write your final logbook.",
    });
    expect(finalRequestMessages).toContainEqual({
      role: "tool",
      tool_call_id: "call-4",
      content: "Tool budget exhausted — this call was not executed. Write your final logbook.",
    });
    expect(finalRequestMessages).not.toContainEqual({
      role: "tool",
      tool_call_id: "call-3",
      content: expect.stringContaining("[Tool call #"),
    });
  });

  it("does not execute tool calls returned despite forced finalization", async () => {
    createCompletion
      .mockResolvedValueOnce(completion(null, [{
        id: "late-call",
        type: "function",
        function: { name: "run_command", arguments: JSON.stringify({ command: "too-late" }) },
      }]))
      .mockResolvedValueOnce(completion("Final logbook"));

    const execute = vi.fn(async () => "must not run");
    const result = await runToolLoop(
      config,
      "system",
      "user",
      [{ name: "run_command", description: "Run", parameters: { type: "object" } }],
      execute,
      {
        maxToolCalls: 10,
        deadlineMs: Date.now() - 1,
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.stoppedBy).toBe("deadline");
    expect(result.toolCalls).toHaveLength(0);
  });

  it("bounds repeated tool replies during forced finalization to one request", async () => {
    createCompletion.mockResolvedValue(completion(null, [{
      id: "repeated-call",
      type: "function",
      function: { name: "run_command", arguments: JSON.stringify({ command: "too-late" }) },
    }]));

    const execute = vi.fn(async () => "must not run");
    const result = await runToolLoop(
      config,
      "system",
      "user",
      [{ name: "run_command", description: "Run", parameters: { type: "object" } }],
      execute,
      {
        maxToolCalls: 10,
        deadlineMs: Date.now() - 1,
      },
    );

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(result.stoppedBy).toBe("deadline");
    expect(result.toolCalls).toHaveLength(0);
  });

  it("returns an empty deadline result when forced-final request throws", async () => {
    createCompletion.mockRejectedValueOnce(new Error("timeout"));

    const result = await runToolLoop(
      config,
      "system",
      "user",
      [],
      async () => "",
      {
        maxToolCalls: 10,
        deadlineMs: Date.now() - 1,
        allowResourceStopFallback: true,
      },
    );

    expect(result.content).toBe("");
    expect(result.toolCalls).toEqual([]);
    expect(result.stoppedBy).toBe("deadline");
  });

  it("returns an empty deadline result for a forced-final API body error", async () => {
    createCompletion.mockResolvedValueOnce({ error: { message: "upstream failed" } });

    const result = await runToolLoop(
      config,
      "system",
      "user",
      [],
      async () => "",
      {
        maxToolCalls: 10,
        deadlineMs: Date.now() - 1,
        allowResourceStopFallback: true,
      },
    );

    expect(result.content).toBe("");
    expect(result.stoppedBy).toBe("deadline");
  });

  it("returns an empty deadline result for a forced-final response without a message", async () => {
    createCompletion.mockResolvedValueOnce({ choices: [] });

    const result = await runToolLoop(
      config,
      "system",
      "user",
      [],
      async () => "",
      {
        maxToolCalls: 10,
        deadlineMs: Date.now() - 1,
        allowResourceStopFallback: true,
      },
    );

    expect(result.content).toBe("");
    expect(result.stoppedBy).toBe("deadline");
  });

  it("returns an empty tool-budget result when its forced-final request fails", async () => {
    createCompletion
      .mockResolvedValueOnce(completion(null, [{
        id: "budgeted-call",
        type: "function",
        function: { name: "run_command", arguments: JSON.stringify({ command: "one" }) },
      }]))
      .mockRejectedValueOnce(new Error("timeout"));

    const result = await runToolLoop(
      config,
      "system",
      "user",
      [{ name: "run_command", description: "Run", parameters: { type: "object" } }],
      async () => "exit code 0",
      {
        maxToolCalls: 1,
        deadlineMs: Date.now() + 60_000,
        allowResourceStopFallback: true,
      },
    );

    expect(result.content).toBe("");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.stoppedBy).toBe("tool-budget");
  });

  it("still throws a normal request failure before resource exhaustion", async () => {
    createCompletion.mockRejectedValueOnce(new Error("timeout"));

    await expect(runToolLoop(
      config,
      "system",
      "user",
      [],
      async () => "",
      {
        maxToolCalls: 10,
        deadlineMs: Date.now() + 60_000,
        allowResourceStopFallback: true,
      },
    )).rejects.toThrow("LLM request failed");
  });

  it("falls back when a request crosses the deadline before failing", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    createCompletion.mockImplementation(async () => {
      now.mockReturnValue(200);
      throw new Error("timeout");
    });

    const result = await runToolLoop(
      config,
      "system",
      "user",
      [],
      async () => "",
      {
        maxToolCalls: 10,
        deadlineMs: 150,
        allowResourceStopFallback: true,
      },
    );

    expect(result.content).toBe("");
    expect(result.stoppedBy).toBe("deadline");
    now.mockRestore();
  });

  it("recognizes a deadline that elapses before a tool-free response arrives", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    createCompletion.mockImplementation(async () => {
      now.mockReturnValue(200);
      return completion("Late final logbook");
    });
    const onPrematureStop = vi.fn(() => "Continue.");

    const result = await runToolLoop(
      config,
      "system",
      "user",
      [],
      async () => "",
      {
        maxToolCalls: 10,
        deadlineMs: 150,
        onPrematureStop,
        maxPrematureStopRecoveries: 2,
      },
    );

    expect(result.content).toBe("Late final logbook");
    expect(result.stoppedBy).toBe("deadline");
    expect(onPrematureStop).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it("refuses null and primitive tool arguments without executing", async () => {
    createCompletion
      .mockResolvedValueOnce(completion(null, [
        {
          id: "null-args",
          type: "function",
          function: { name: "run_command", arguments: "null" },
        },
        {
          id: "primitive-args",
          type: "function",
          function: { name: "run_command", arguments: "42" },
        },
      ]))
      .mockResolvedValueOnce(completion("Done."));

    const execute = vi.fn(async () => "exit code 0");
    const records: Array<{ args: Record<string, unknown>; error: boolean; result: string }> = [];
    await runToolLoop(
      config,
      "system",
      "user",
      [{ name: "run_command", description: "Run", parameters: { type: "object" } }],
      execute,
      {
        maxToolCalls: 10,
        deadlineMs: Date.now() + 60_000,
        onToolCall: record => { records.push(record); },
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(records.every(record => record.error && record.result.startsWith("Refused:"))).toBe(true);
    expect(records.map(record => record.args)).toEqual([{}, {}]);
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

  it("uses a custom message when old tool output is compacted", async () => {
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
        contextCharBudget: 1_200,
        elidedToolOutputMessage: "[read_tool_result for the full output]",
      },
    );

    const finalMessages = createCompletion.mock.calls.at(-1)?.[0].messages;
    expect(finalMessages).toContainEqual({
      role: "tool",
      tool_call_id: "call-1",
      content: "[read_tool_result for the full output]",
    });
  });
});