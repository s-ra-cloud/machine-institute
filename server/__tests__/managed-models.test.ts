import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BYOC_PROVIDERS, getManagedModels, resolveByocSelection, resolveManagedSelection, getManagedConnection } from "../managed-models";
import { estimateTaskCost, MANAGED_MODELS } from "../../shared/model-catalog";
beforeEach(() => {
  vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_API_KEY", "synthetic");
  vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", "https://managed.example.test");
  vi.stubEnv("LAB_ALLOWED_MODELS", undefined);
});
afterEach(() => vi.unstubAllEnvs());
describe("managed OpenRouter catalogue and selection", () => {
  it("permits all catalogue models when allowlist is unset", () => {
    expect(getManagedModels().every(model => model.enabled)).toBe(true);
    for (const model of MANAGED_MODELS) {
      expect(model.model.startsWith(`${model.provider}/`)).toBe(true);
      expect(resolveManagedSelection({ modelName: model.model }).provider).toBe(model.provider);
    }
    expect(MANAGED_MODELS.some(m => m.model === "anthropic/claude-sonnet-4.6")).toBe(true);
  });
  it("uses the optional exact-slug allowlist and rejects legacy or mismatched identities", () => {
    vi.stubEnv("LAB_ALLOWED_MODELS", "openai/gpt-4o");
    expect(getManagedModels().filter(m => m.enabled).map(m => m.model)).toEqual(["openai/gpt-4o"]);
    expect(() => resolveManagedSelection({ modelName: "gpt-4o" })).toThrow();
    expect(() => resolveManagedSelection({ modelName: "openai/gpt-4o", provider: "anthropic" })).toThrow();
    expect(() => resolveManagedSelection({ modelName: "openai/gpt-4o", providerMode: "byoc" })).toThrow();
    vi.stubEnv("LAB_ALLOWED_MODELS", "");
    expect(getManagedModels().some(m => m.enabled)).toBe(false);
  });
  it("never falls back to personal keys or separate provider connections", () => {
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "personal-must-not-be-used");
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "old-must-not-be-used");
    expect(getManagedModels().some(m => m.enabled)).toBe(false);
    expect(() => getManagedConnection("openai")).toThrow(/not connected/);
  });
  it("rejects direct endpoints and shares one provisioned connection", () => {
    for (const url of ["https://api.openai.com/v1", "https://openrouter.ai/api/v1", "http://example.com"]) {
      vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", url);
      expect(() => getManagedConnection("openai")).toThrow(/invalid/);
    }
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", "http://localhost:1106/openrouter");
    expect(getManagedConnection("anthropic")).toEqual(getManagedConnection("google"));
  });
});
describe("explicit BYOK selection", () => {
  it("accepts only a supported provider, model, and syntactically matching ephemeral key", () => {
    for (const provider of BYOC_PROVIDERS) {
      expect(resolveByocSelection({
        providerMode: "byoc",
        provider: provider.id,
        modelName: provider.defaultModel,
        apiKey: provider.id === "openai" ? "sk-proj-example-key-123456"
          : provider.id === "anthropic" ? "sk-ant-api03-example-key-123456"
          : "sk-or-v1-example-key-123456",
      })).toMatchObject({ providerMode: "byoc", provider: provider.id, modelName: provider.defaultModel });
    }
    expect(() => resolveByocSelection({
      providerMode: "platform", provider: "openai", modelName: "gpt-4o", apiKey: "sk-example-key-123456",
    })).toThrow();
    expect(() => resolveByocSelection({
      providerMode: "byoc", provider: "openai", modelName: "gpt-4o", apiKey: "sk-or-v1-wrong-provider-123456",
    })).toThrow(/key/i);
    expect(() => resolveByocSelection({
      providerMode: "byoc", provider: "openai", modelName: "https://example.invalid", apiKey: "sk-example-key-123456",
    })).toThrow(/model/i);
  });
});
describe("shared task estimates", () => {
  it("accounts for tasks, batches, ethics and separate judges using exact slugs", () => {
    for (const type of ["editorial", "literature-review", "ethics-report", "peer-review", "reproduction", "judge"] as const) {
      expect(estimateTaskCost("openai/gpt-4o", type)?.usd).toBeGreaterThan(0);
    }
    const base = estimateTaskCost("openai/gpt-4o", "peer-review")!;
    expect(estimateTaskCost("openai/gpt-4o", "peer-review", { batchCount: 3 })!.usd).toBeCloseTo(base.usd * 3);
    expect(estimateTaskCost("openai/gpt-4o", "peer-review", { includeEthics: true })!.usd).toBeGreaterThan(base.usd);
    expect(estimateTaskCost("openai/gpt-5-nano", "reproduction", { judgeModelName: "openai/gpt-4o" })!.usd).toBeGreaterThan(estimateTaskCost("openai/gpt-5-nano", "reproduction")!.usd);
    expect(estimateTaskCost("unknown", "editorial")).toBeNull();
  });
});