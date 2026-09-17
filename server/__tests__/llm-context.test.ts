import { describe, expect, it } from "vitest";
import { ContextBudgetError, RequestContextBudget, estimateRequestTokens, isContextOverflow, reportedContextLimit } from "../llm-context";

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

  it("uses conservative unknown-model limits rather than BYOC provider defaults", () => {
    const unknown = { ...config, providerMode: "byoc" as const, provider: "openai", modelName: "unknown-new-model" };
    expect(new RequestContextBudget(unknown, 6000, "judge", 128000).limit).toBe(32768);
    expect(new RequestContextBudget({ ...unknown, modelName: "gpt-4o" }, 6000, "judge", 128000).limit).toBe(128000);
  });

  it("recognizes the observed error and always reduces the actual request target", () => {
    const budget = new RequestContextBudget(config, 8000, "reproduction", 64000);
    const request = { messages: [{ role: "user", content: "x".repeat(18000) }] };
    expect(reportedContextLimit(error)).toBe(32768);
    expect(budget.reduce(error, request)).toBe(true);
    expect(budget.inputLimit).toBeLessThan(budget.estimate(request));
    const previous = budget.inputLimit;
    budget.reduce(error, request);
    expect(budget.inputLimit).toBeLessThan(previous);
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
});