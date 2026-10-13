import { describe, expect, it } from "vitest";
import {
  ContextBudgetError, ProviderPaymentError, RequestContextBudget, estimateRequestTokens,
  isContextOverflow, isProviderPaymentError, isProviderPaymentFailure,
  isTransientProviderPaymentFailure, providerContextConstraint, providerPaymentMetadata,
  providerPaymentReason, providerRetryAfterMs, reportedContextLimit,
} from "../llm-context";

const config = { providerMode: "platform" as const, provider: "openrouter", modelName: "deepseek/deepseek-chat" };
const error = { error: { message: "Upstream error from DeepInfra: The sum of prompt length (35175.0), query length (0) should not exceed max_num_tokens (32768)" } };

describe("Complete request budgets", () => {
  it("uses the routed cap independently of advertised capabilities and reserves output", () => {
    const budget = new RequestContextBudget(config, 8000, "reproduction", 64000);
    expect(budget.limit).toBe(32768);
    expect(budget.inputLimit).toBe(32768 - 8000 - 1024);
  });

  it("counts dense JSON, unicode, assistant arguments and tool schemas", () => {
    const base = { messages: [{ role: "system", content: "instruction" }] };
    const expanded = { messages: [...base.messages, { role: "assistant", content: null, tool_calls: [{ function: { arguments: JSON.stringify({ code: "λ变量{}:".repeat(2000) }) } }] }], tools: [{ name: "test", parameters: { description: "123[]".repeat(5000) } }] };
    expect(estimateRequestTokens(expanded)).toBeGreaterThan(Buffer.byteLength(JSON.stringify(expanded)));
    expect(new RequestContextBudget(config, 8000, "reproduction").fits(expanded)).toBe(false);
    expect(estimateRequestTokens(expanded)).toBeGreaterThan(estimateRequestTokens(base) + 25000);
  });

  it("moves input room to the output reserve only while the current request still fits", () => {
    const budget = new RequestContextBudget(config, 6000, "judge", 64000);
    const small = { messages: [{ role: "user", content: "x".repeat(4000) }] };
    expect(budget.raiseOutputReserve(12000, small)).toBe(true);
    expect(budget.maxOutputTokens).toBe(12000);
    expect(budget.inputLimit).toBe(32768 - 12000 - 1024);
    // Not enough room left for a request this large: the reserve is left unchanged.
    const large = { messages: [{ role: "user", content: "x".repeat(60000) }] };
    expect(budget.raiseOutputReserve(24000, large)).toBe(false);
    expect(budget.maxOutputTokens).toBe(12000);
    expect(budget.raiseOutputReserve(12000, small)).toBe(false);
  });

  it("uses conservative unknown-model limits rather than BYOC provider defaults", () => {
    const unknown = { ...config, providerMode: "byoc" as const, provider: "openai", modelName: "unknown-new-model" };
    expect(new RequestContextBudget(unknown, 6000, "judge", 128000).limit).toBe(32768);
    expect(new RequestContextBudget({ ...unknown, modelName: "gpt-4o" }, 6000, "judge", 128000).limit).toBe(128000);
  });

  it("recognizes DeepInfra's input-only cap and does not blindly shrink twice", () => {
    const budget = new RequestContextBudget(config, 8000, "reproduction", 64000);
    const request = { messages: [{ role: "user", content: "x".repeat(18000) }] };
    expect(reportedContextLimit(error)).toBe(32768);
    expect(budget.reduce(error, request)).toBe(true);
    expect(budget.inputLimit).toBeLessThan(budget.estimate(request));
    const previous = budget.inputLimit;
    expect(budget.reduce(error, request)).toBe(false);
    expect(budget.inputLimit).toBe(previous);
    expect(providerContextConstraint(error)).toMatchObject({
      kind: "input", limit: 32768, requestedInputTokens: 35175,
    });
    expect(providerContextConstraint({
      message: "prompt length (32000), query length (1200) should not exceed max_num_tokens (32768)",
    })).toMatchObject({
      kind: "input", limit: 32768, requestedInputTokens: 33200,
    });
  });

  it("distinguishes a total OpenAI context window from input and output counts", () => {
    const rejection = new Error(
      "This model's maximum context length is 32768 tokens. However, you requested 35175 tokens (27175 in the messages, 8000 in the completion).",
    );
    expect(providerContextConstraint(rejection)).toEqual({
      kind: "total", limit: 32768, requestedTotalTokens: 35175,
      requestedInputTokens: 27175, requestedOutputTokens: 8000,
    });
    const budget = new RequestContextBudget(config, 8000, "reproduction");
    const request = { messages: [{ role: "user", content: "x".repeat(18_000) }] };
    const before = budget.estimate(request);
    expect(budget.reduce(rejection, request)).toBe(true);
    expect(budget.inputLimit).toBe(Math.floor(before * (32768 - 8000 - 1024) / 27175));
  });

  it("does not mistake a standalone max_num_tokens output cap for an input limit", () => {
    const outputCap = {
      status: 400,
      error: {
        type: "invalid_request_error",
        message: "max_num_tokens (8192) exceeds the maximum output allowance",
      },
    };
    expect(providerContextConstraint(outputCap)).toBeUndefined();
    expect(reportedContextLimit(outputCap)).toBeUndefined();
    expect(isContextOverflow(outputCap)).toBe(true);
  });

  it("permits one bounded unknown-limit retry and refuses an impossible protected floor", () => {
    const request = { messages: [{ role: "user", content: "x".repeat(18_000) }] };
    const unknown = new Error("prompt too long");
    const budget = new RequestContextBudget(config, 8000, "reproduction");
    expect(budget.reduce(unknown, request)).toBe(true);
    expect(budget.reduce(unknown, request)).toBe(false);

    const floor = new RequestContextBudget(config, 8000, "reproduction", 32768, 20_000);
    const protectedRequest = { messages: [{ role: "user", content: "x".repeat(18_000) }] };
    expect(floor.reduce(error, protectedRequest)).toBe(false);
    expect(floor.inputLimit).toBe(32768 - 8000 - 1024);
  });

  it("does not retry unrelated errors or leak input into diagnostics", () => {
    const budget = new RequestContextBudget(config, 8000, "reproduction");
    expect(isContextOverflow(new Error("401 invalid key"))).toBe(false);
    expect(isContextOverflow(new Error("503 service unavailable"))).toBe(false);
    expect(budget.reduce(new Error("429 rate limit"), {})).toBe(false);
    const request = { messages: [{ role: "system", content: "PRIVATE_INSTRUCTION".repeat(5000) }] };
    expect(() => budget.assertFits(request)).toThrow(ContextBudgetError);
    expect(budget.diagnostic(request)).not.toContain("PRIVATE_INSTRUCTION");
    expect(isContextOverflow(new ContextBudgetError("input too large"))).toBe(false);
  });

  it("gives HTTP payment failures precedence over context-like billing text", () => {
    const billing = {
      status: 402,
      error: {
        message: "This request requires more credits, or fewer max_tokens. You can only afford 120 tokens.",
      },
    };
    expect(providerPaymentReason(billing)).toBe("payment_required");
    expect(isProviderPaymentFailure(billing)).toBe(true);
    expect(isContextOverflow(billing)).toBe(false);
    expect(providerContextConstraint(billing)).toBeUndefined();
    expect(new RequestContextBudget(config, 8000, "reproduction").reduce(billing, {})).toBe(false);
  });

  it("recognizes status-less nested 402 codes and explicit credit wording safely", () => {
    expect(isProviderPaymentFailure({ error: { code: 402, message: "provider rejected request" } })).toBe(true);
    expect(providerPaymentReason({ message: "This request requires more credits." })).toBe("provider_credit");
    expect(isProviderPaymentError(new ProviderPaymentError(402))).toBe(true);
  });

  it("keeps an explicit non-payment HTTP status authoritative", () => {
    const context400 = {
      status: 400,
      error: {
        code: 402,
        message: "maximum context length is 32768 tokens; request exceeds the limit",
      },
    };
    expect(isProviderPaymentFailure(context400)).toBe(false);
    expect(isContextOverflow(context400)).toBe(true);
  });

  it("allowlists only documented transient metadata and bounds numeric retry-after", () => {
    const transient = {
      status: 402,
      headers: { "retry-after": "99" },
      error: {
        metadata: {
          limit_source: "openrouter_in_flight_budget",
          reason: "in_flight_budget_exhausted",
          remedy_hint: "PRIVATE",
        },
      },
    };
    expect(providerPaymentMetadata(transient)).toEqual({
      limitSource: "openrouter_in_flight_budget",
      reason: "in_flight_budget_exhausted",
    });
    expect(isTransientProviderPaymentFailure(transient)).toBe(true);
    expect(providerRetryAfterMs(transient)).toBe(99_000);
    expect(providerPaymentMetadata({
      metadata: { limit_source: "PRIVATE", reason: "PRIVATE", remedy_hint: "PRIVATE" },
    })).toEqual({});
    expect(providerRetryAfterMs({ headers: { "retry-after": "tomorrow" } })).toBe(0);
  });
});