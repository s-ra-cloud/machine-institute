import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../shared/model-catalog", async importOriginal => {
  const actual = await importOriginal<typeof import("../../shared/model-catalog")>();
  return { ...actual, MANAGED_MODELS: actual.MANAGED_MODELS.map(m => ({ ...m, contextWindow: 32768 })) };
});

const createMock = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
    constructor(_options: unknown) {}
  },
}));

import {
  generateWithConfig, runToolLoop, safeProviderErrorDiagnostic,
  sanitizeContextRequestError,
} from "../model-service";
import { ProviderPaymentError, isContextOverflow } from "../llm-context";
import { ReproductionSession } from "../reproduction-session";

const config = {
  providerMode: "platform" as const,
  provider: "openai",
  modelName: "openai/gpt-4o",
};
const call = {
  id: "call-1",
  type: "function",
  function: { name: "run_command", arguments: JSON.stringify({ command: "python reproduce.py" }) },
};

describe("tool-loop context protection", () => {
  beforeEach(() => {
    createMock.mockReset();
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", "https://managed.example.test");
    vi.stubEnv("LAB_ALLOWED_MODELS", "openai/gpt-4o,anthropic/claude-sonnet-4.6");
  });

  it("retries a context rejection in place without rerunning the tool", async () => {
    createMock
      .mockRejectedValueOnce(new Error("maximum context length is 32768 tokens"))
      .mockResolvedValueOnce({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [call] } }] })
      .mockResolvedValueOnce({ choices: [{ finish_reason: "stop", message: { content: "done", tool_calls: [] } }] });
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
    expect((thrown as Error).message).toBe("LLM request failed (503). Retry later or ask an administrator to check the managed integration.");
    expect((thrown as Error).message).not.toContain("service unavailable");
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("preserves forced-final STOP after archiving long drafts and repair instructions", async () => {
    const session = new ReproductionSession(() => []);
    const draft = "UNFINISHED_DRAFT ".repeat(4000);
    const repair = "Continue repair of the pending claims. ".repeat(1500);
    createMock
      .mockResolvedValueOnce({ choices: [{ finish_reason: "stop", message: { content: draft } }] })
      .mockResolvedValueOnce({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [call] } }] })
      .mockResolvedValueOnce({ choices: [{ finish_reason: "stop", message: { content: "Honest resource-stop logbook." } }] });
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
    createMock.mockResolvedValueOnce({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [call] } }] });
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
    createMock.mockResolvedValueOnce({
      error: { type: "invalid_request_error", message: "prompt is too long PRIVATE_PROMPT_MARKER max_num_tokens (32768)" },
    });
    let thrown: unknown;
    try {
      await generateWithConfig(
        { providerMode: "platform", provider: "anthropic", modelName: "anthropic/claude-sonnet-4.6" },
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

  it("preserves successful tool progress and does not retry a later HTTP 402", async () => {
    const billing = Object.assign(
      new Error("This request requires more credits, or fewer max_tokens; can only afford 12"),
      { status: 402 },
    );
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: null, tool_calls: [call] }, finish_reason: "tool_calls" }] })
      .mockRejectedValueOnce(billing);
    const accepted: string[] = [];
    const outcomes: any[] = [];
    const execute = vi.fn(async () => {
      accepted.push("R1=verified");
      return "Registered R1 as verified.";
    });

    let thrown: unknown;
    try {
      await runToolLoop(config, "system", "paper", [
        { name: "run_command", description: "run", parameters: { type: "object" } },
      ], execute, {
        maxToolCalls: 3,
        deadlineMs: Date.now() + 60_000,
        allowResourceStopFallback: true,
        contextProtection: { getState: () => accepted.join("\n") },
        onOutcome: event => outcomes.push(event),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderPaymentError);
    expect(thrown).toMatchObject({
      code: "PROVIDER_PAYMENT_REQUIRED", status: 402, providerCode: "payment_required",
    });
    expect((thrown as Error).message).not.toContain("max_tokens");
    expect(accepted).toEqual(["R1=verified"]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(outcomes.at(-1)).toMatchObject({
      kind: "provider-error", providerStatus: 402,
      providerCode: "payment_required", providerReason: "payment",
    });
  });

  it("does not swallow a completion billing error during forced-final fallback", async () => {
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: null, tool_calls: [call] }, finish_reason: "tool_calls" }] })
      .mockResolvedValueOnce({
        error: {
          code: 402,
          message: "This request requires more credits, or fewer max_tokens; can only afford 1",
        },
      });

    await expect(runToolLoop(config, "system", "paper", [
      { name: "run_command", description: "run", parameters: { type: "object" } },
    ], async () => "Registered R1 as verified.", {
      maxToolCalls: 1,
      deadlineMs: Date.now() + 60_000,
      allowResourceStopFallback: true,
      contextProtection: { getState: () => "R1=verified" },
    })).rejects.toMatchObject({
      code: "PROVIDER_PAYMENT_REQUIRED", status: 402,
    });
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("keeps actual HTTP 400 context recovery bounded", async () => {
    createMock
      .mockRejectedValueOnce(Object.assign(new Error("maximum context length is 32768 tokens"), { status: 400 }))
      .mockResolvedValueOnce({ choices: [{ message: { content: "done", tool_calls: [] }, finish_reason: "stop" }] });

    await expect(runToolLoop(
      config, "system", "paper ".repeat(1000), [], async () => "must not execute", {
        maxToolCalls: 1,
        deadlineMs: Date.now() + 60_000,
        contextProtection: { getState: () => "state", compactUserMessage: "Continue." },
      },
    )).resolves.toMatchObject({ content: "done" });
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("sanitizes status-less nested 402 completion errors into the typed API", () => {
    const sanitized = sanitizeContextRequestError({
      error: { code: 402, message: "PRIVATE billing body with max_tokens" },
    }, "model", { providerMode: "platform" });
    expect(sanitized).toBeInstanceOf(ProviderPaymentError);
    expect(sanitized).toMatchObject({
      code: "PROVIDER_PAYMENT_REQUIRED", status: 402, statusCode: 402,
      providerCode: "payment_required", model: "model",
    });
    expect(sanitized.message).not.toContain("PRIVATE");
    expect(sanitized.message).toContain("Replit-managed model request");
    expect(sanitizeContextRequestError(
      { status: 402 }, "model", { providerMode: "byoc" },
    ).message).toContain("Your model provider account");
    expect(safeProviderErrorDiagnostic({
      message: "requires more credits PRIVATE", apiKey: "PRIVATE",
    })).toEqual({
      providerStatus: undefined,
      providerCode: "provider_credit",
      providerReason: "provider-credit",
      providerLimitSource: undefined,
      providerPaymentReason: undefined,
      providerRetryAfterMs: undefined,
      contextLimit: undefined,
      requestedInputTokens: undefined,
      requestedOutputTokens: undefined,
      requestedTotalTokens: undefined,
    });
  });

  it("retries documented transient in-flight 402s in place without rerunning tools", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const transient = {
      status: 402,
      headers: { "retry-after": "0.01" },
      error: {
        message: "PRIVATE transient provider body",
        metadata: {
          limit_source: "openrouter_in_flight_budget",
          reason: "in_flight_budget_exhausted",
          remedy_hint: "PRIVATE remedy",
        },
      },
    };
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: null, tool_calls: [call] }, finish_reason: "tool_calls" }] })
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({ choices: [{ message: { content: "done", tool_calls: [] }, finish_reason: "stop" }] });
    const execute = vi.fn(async () => "Registered R1 as verified.");
    const outcomes: any[] = [];

    const pending = runToolLoop(config, "system", "paper", [
      { name: "run_command", description: "run", parameters: { type: "object" } },
    ], execute, {
      maxToolCalls: 4,
      deadlineMs: 60_000,
      contextProtection: { getState: () => "R1=verified" },
      onOutcome: event => outcomes.push(event),
    });
    await vi.advanceTimersByTimeAsync(30);
    await expect(pending).resolves.toMatchObject({ content: "done" });
    expect(createMock).toHaveBeenCalledTimes(4);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(outcomes.filter(event => event.providerPaymentReason === "in_flight_budget_exhausted"))
      .toHaveLength(2);
    expect(JSON.stringify(outcomes)).not.toMatch(/PRIVATE|remedy/);
    vi.useRealTimers();
  });

  it("does not wait or retry a transient in-flight 402 past the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    createMock.mockRejectedValueOnce({
      status: 402,
      headers: { "retry-after": "30" },
      error: {
        metadata: {
          limit_source: "openrouter_in_flight_budget",
          reason: "in_flight_budget_exhausted",
        },
      },
    });

    const pending = runToolLoop(config, "system", "paper", [], async () => "must not execute", {
      maxToolCalls: 1,
      deadlineMs: 1_100,
      allowResourceStopFallback: true,
      contextProtection: { getState: () => "state" },
    });
    await expect(pending).rejects.toMatchObject({
      code: "PROVIDER_PAYMENT_REQUIRED",
      limitSource: "openrouter_in_flight_budget",
      paymentReason: "in_flight_budget_exhausted",
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not retry earlier than a Retry-After above the bounded wait", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    createMock.mockRejectedValueOnce({
      status: 402,
      headers: { "retry-after": "31" },
      error: {
        metadata: {
          limit_source: "openrouter_in_flight_budget",
          reason: "in_flight_budget_exhausted",
        },
      },
    });

    const pending = runToolLoop(config, "system", "paper", [], async () => "must not execute", {
      maxToolCalls: 1,
      deadlineMs: 100_000,
      contextProtection: { getState: () => "state" },
    });
    await expect(pending).rejects.toMatchObject({
      code: "PROVIDER_PAYMENT_REQUIRED",
      retryAfterMs: 31_000,
    });
    await expect(pending).rejects.toThrow(/longer retry delay; retry later/);
    expect(createMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("retries a thrown 429 twice at most on the same model request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    createMock
      .mockRejectedValueOnce({ status: 429, headers: { "retry-after": "0.01" }, message: "PRIVATE provider body" })
      .mockResolvedValueOnce({ choices: [{ message: { content: "done", tool_calls: [] }, finish_reason: "stop" }] });
    const execute = vi.fn(async () => "must not execute");
    const outcomes: any[] = [];
    const pending = runToolLoop(config, "system", "paper", [], execute, {
      maxToolCalls: 1, deadlineMs: 60_000, onOutcome: event => outcomes.push(event),
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toMatchObject({ content: "done" });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0][0]).toEqual(createMock.mock.calls[1][0]);
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(outcomes)).not.toContain("PRIVATE");
    vi.useRealTimers();
  });

  it("stops after two additional 429 attempts with sanitized rate-limit diagnostics", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    createMock.mockRejectedValue({ status: 429, message: "PRIVATE provider body" });
    const outcomes: any[] = [];
    const pending = runToolLoop(config, "system", "paper", [], async () => "must not execute", {
      maxToolCalls: 1, deadlineMs: 60_000, onOutcome: event => outcomes.push(event),
    });
    const rejected = expect(pending).rejects.toThrow("Managed model rate limit reached");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(outcomes.at(-1)).toMatchObject({
      stopReason: "rate-limit", providerStatus: 429, providerReason: "rate-limit",
    });
    expect(JSON.stringify(outcomes)).not.toContain("PRIVATE");
    vi.useRealTimers();
  });

  it("does not retry a 429 when Retry-After would cross the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    createMock.mockRejectedValueOnce({
      status: 429, headers: { "retry-after": "0.05" }, message: "PRIVATE provider body",
    });
    const outcomes: any[] = [];
    const pending = runToolLoop(config, "system", "paper", [], async () => "must not execute", {
      maxToolCalls: 1, deadlineMs: 1_020, onOutcome: event => outcomes.push(event),
    });
    await expect(pending).rejects.toThrow("Managed model rate limit reached");
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(outcomes.at(-1)).toMatchObject({ stopReason: "rate-limit", providerStatus: 429 });
    vi.useRealTimers();
  });

  it("does not retry non-429 provider errors", async () => {
    createMock.mockRejectedValueOnce({ status: 503, message: "PRIVATE provider body" });
    const outcomes: any[] = [];
    await expect(runToolLoop(config, "system", "paper", [], async () => "must not execute", {
      maxToolCalls: 1, deadlineMs: Date.now() + 60_000, onOutcome: event => outcomes.push(event),
    })).rejects.toThrow(/LLM request failed \(503\)/);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(outcomes.at(-1)).not.toMatchObject({ stopReason: "rate-limit" });
  });

  it("does not retry HTTP 429 insufficient-quota payment failures", async () => {
    createMock.mockRejectedValueOnce({
      status: 429, code: "insufficient_quota", message: "PRIVATE payment detail",
    });
    await expect(runToolLoop(config, "system", "paper", [], async () => "must not execute", {
      maxToolCalls: 1, deadlineMs: Date.now() + 60_000,
    })).rejects.toMatchObject({ code: "PROVIDER_PAYMENT_REQUIRED", providerCode: "provider_credit" });
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("retries completion.error 429 in the forced-final request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    createMock
      .mockResolvedValueOnce({
        error: { status: 429, headers: { "retry-after": "0.01" }, message: "PRIVATE provider body" },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: "final answer", tool_calls: [] }, finish_reason: "stop" }],
      });
    const pending = runToolLoop(config, "system", "paper", [], async () => "must not execute", {
      maxToolCalls: 0, deadlineMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toMatchObject({ content: "final answer", stoppedBy: "tool-budget" });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0][0]).toEqual(createMock.mock.calls[1][0]);
    expect(createMock.mock.calls[0][0]).not.toHaveProperty("tools");
    vi.useRealTimers();
  });
});
