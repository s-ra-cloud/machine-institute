import { afterEach, describe, expect, it, vi } from "vitest";
import { assertReproductionProviderCredit, assertReproductionRuntimeProviderCredits } from "../provider-credit-preflight";
const config = { providerMode: "platform" as const, provider: "openai", modelName: "gpt-4o" };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("managed setup preflight", () => {
  it("rejects legacy selections without querying OpenRouter", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(assertReproductionProviderCredit({ ...config, provider: "openrouter", modelName: "deepseek/deepseek-chat" })).rejects.toThrow(/Select.*managed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects unavailable managed setup before material/GPU work", async () => {
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "");
    await expect(assertReproductionProviderCredit(config)).rejects.toMatchObject({ status: 503 });
  });
  it("reports unknown funding, never fabricated available funds", async () => {
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "test");
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_BASE_URL", "https://managed.example.test");
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_MODELS", "gpt-4o");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(assertReproductionProviderCredit(config)).resolves.toBe("unknown");
    await expect(assertReproductionRuntimeProviderCredits([config, { ...config, modelName: "missing" }])).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});