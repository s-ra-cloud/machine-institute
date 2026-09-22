import { afterEach, describe, expect, it, vi } from "vitest";
import { getManagedModels, resolveManagedSelection, getManagedConnection } from "../managed-models";
import { estimateTaskCost } from "../../shared/model-catalog";
afterEach(() => vi.unstubAllEnvs());
describe("managed model catalogue and selection", () => {
  it("requires verified availability, not just credentials", () => {
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "synthetic");
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_BASE_URL", "https://managed.example.test");
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_MODELS", "");
    expect(getManagedModels().find(m => m.model === "gpt-4o")?.enabled).toBe(false);
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_MODELS", "gpt-4o");
    expect(resolveManagedSelection({ modelName: "gpt-4o", provider: "openai" })).toEqual({ providerMode: "platform", provider: "openai", modelName: "gpt-4o" });
    expect(() => resolveManagedSelection({ modelName: "gpt-4o", provider: "anthropic" })).toThrow();
    expect(() => resolveManagedSelection({ modelName: "gpt-4o", providerMode: "byoc" })).toThrow();
  });
  it("rejects direct provider URLs and accepts a provisioned loopback gateway", () => {
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "synthetic");
    for (const url of ["https://api.openai.com/v1", "https://openrouter.ai/api/v1", "http://example.com"]) {
      vi.stubEnv("AI_INTEGRATIONS_OPENAI_BASE_URL", url);
      expect(() => getManagedConnection("openai")).toThrow(/invalid/);
    }
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_BASE_URL", "http://localhost:1106/openai");
    expect(getManagedConnection("openai").baseURL).toContain("localhost");
  });
});
describe("shared task estimates", () => {
  it("accounts for all task families, batch counts, optional ethics and separate judges", () => {
    for (const type of ["editorial", "literature-review", "ethics-report", "peer-review", "reproduction", "judge"] as const) {
      expect(estimateTaskCost("gpt-4o", type)?.usd).toBeGreaterThan(0);
    }
    const base = estimateTaskCost("gpt-4o", "peer-review")!;
    expect(estimateTaskCost("gpt-4o", "peer-review", { batchCount: 3 })!.usd).toBeCloseTo(base.usd * 3);
    expect(estimateTaskCost("gpt-4o", "peer-review", { includeEthics: true })!.usd).toBeGreaterThan(base.usd);
    expect(estimateTaskCost("gpt-5-nano", "reproduction", { judgeModelName: "gpt-4o" })!.usd).toBeGreaterThan(estimateTaskCost("gpt-5-nano", "reproduction")!.usd);
    expect(estimateTaskCost("gpt-4o", "literature-review", { fullTextCount: 20 })!.usd).toBeGreaterThan(estimateTaskCost("gpt-4o", "literature-review", { fullTextCount: 2 })!.usd);
    expect(estimateTaskCost("unknown", "editorial")).toBeNull();
    expect(estimateTaskCost("claude-opus-4-6", "editorial")).toBeNull();
  });
});