import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareProviderContext, verifiedProviderContext } from "../provider-context";
import { RequestContextBudget } from "../llm-context";
const config = (modelName: string) => ({ providerMode: "byoc" as const, provider: "openrouter", modelName });
afterEach(() => vi.unstubAllGlobals());

describe("verified routed context (offline)", () => {
  it("uses exact model metadata while retaining provider-rejection tightening", async () => {
    const c = config("deepseek/exact-metadata-test");
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{
      id: c.modelName, context_length: 1048576, top_provider: { context_length: 1048576 },
    }] })));
    vi.stubGlobal("fetch", fetcher);
    await prepareProviderContext(c, () => {});
    expect(verifiedProviderContext(c)).toBe(1048576);
    const budget = new RequestContextBudget(c, 8000, "test", 1048576);
    expect(budget.limit).toBe(1048576);
    expect(budget.inputLimit).toBe(1048576 - 8000 - 1024);
    expect(budget.reduce(
      { error: { message: "This model's maximum context length is 32768 tokens." } },
      { messages: [{ role: "user", content: "source ".repeat(10000) }] },
    )).toBe(true);
    expect(budget.limit).toBe(32768);
    expect(budget.inputLimit).toBeLessThanOrEqual(32768 - 8000 - 1024);
    // Metadata is not accepted merely because an incoming config says so.
    expect(new RequestContextBudget({ ...c }, 8000, "test", 1048576).limit).toBe(32768);
    await prepareProviderContext(c, () => {});
    expect(fetcher).toHaveBeenCalledOnce();
    c.modelName = "different-model";
    expect(verifiedProviderContext(c)).toBeUndefined();
  });
  it("takes the smaller published serving limit", async () => {
    const c = config("smaller-serving-test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{
      id: c.modelName, context_length: 1048576, top_provider: { context_length: 65536 },
    }] }))));
    await prepareProviderContext(c, () => {});
    expect(verifiedProviderContext(c)).toBe(65536);
  });
  it("never applies another model's metadata", async () => {
    const c = config("not-in-catalogue-test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{
      id: "another-model", context_length: 1048576, top_provider: { context_length: 1048576 },
    }] }))));
    const notice = vi.fn();
    await prepareProviderContext(c, notice);
    expect(verifiedProviderContext(c)).toBeUndefined();
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("could not be verified"));
  });
  it("explicitly reports unavailable metadata and leaves managed billing untouched", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const notice = vi.fn();
    const c = config("unavailable-metadata-test");
    await prepareProviderContext(c, notice);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("conservative"));
    expect(new RequestContextBudget(c, 8000, "test", 1048576).limit).toBe(32768);
    await prepareProviderContext({ ...c, providerMode: "platform" }, notice);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
