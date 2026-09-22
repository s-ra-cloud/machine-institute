import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertReproductionProviderCredit,
  assertReproductionRuntimeProviderCredits,
  ProviderCredentialPreflightError,
  ProviderCreditPreflightError,
} from "../provider-credit-preflight";
import type { ModelProviderConfig } from "../model-service";

const byoc = (modelName = "openai/gpt-4o"): ModelProviderConfig => ({
  providerMode: "byoc",
  provider: "openrouter",
  modelName,
  apiKey: "test-key-never-sent-to-a-real-service",
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OpenRouter provider credit preflight", () => {
  it("uses the key metadata endpoint and accepts an explicit positive remainder", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: { limit_remaining: 1.25 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(assertReproductionProviderCredit(byoc())).resolves.toBe("available");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/key",
      expect.objectContaining({ method: "GET", headers: { Authorization: expect.stringMatching(/^Bearer /) } }),
    );
  });

  it("hard-blocks explicit zero credit for paid models with an actionable BYOC message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: { limit_remaining: 0 } }),
      { status: 200 },
    )));

    const error = await assertReproductionProviderCredit(byoc()).catch(value => value);
    expect(error).toBeInstanceOf(ProviderCreditPreflightError);
    expect(error.preflightKind).toBe("credits_exhausted");
    expect(error.message).toMatch(/OpenRouter API key.*spending cap.*Replit subscription/i);
  });

  it("allows a free model at zero, while still blocking an explicit HTTP 402", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { limit_remaining: 0 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 402 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(assertReproductionProviderCredit(byoc("meta-llama/model:free"))).resolves.toBe("free-model");
    await expect(assertReproductionProviderCredit(byoc("meta-llama/model:free"))).rejects.toMatchObject({
      preflightKind: "credits_exhausted",
      status: 402,
    });
  });

  it.each([401, 403])("blocks HTTP %s as invalid credentials", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status })));
    const error = await assertReproductionProviderCredit(byoc()).catch(value => value);
    expect(error).toBeInstanceOf(ProviderCredentialPreflightError);
    expect(error).not.toBeInstanceOf(ProviderCreditPreflightError);
    expect(error).toMatchObject({
      preflightKind: "invalid_credentials",
      status,
    });
  });

  it.each([
    ["null remaining balance", new Response(JSON.stringify({ data: { limit_remaining: null } }), { status: 200 })],
    ["malformed payload", new Response("{", { status: 200 })],
    ["provider 5xx", new Response("", { status: 503 })],
  ])("warns and proceeds for %s without promising available funds", async (_label, response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const warning = vi.fn();
    await expect(assertReproductionProviderCredit(byoc(), warning)).resolves.toBe("unknown");
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/without a funding guarantee/));
  });

  it("warns and proceeds on network failure, and bypasses other providers", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const warning = vi.fn();
    await expect(assertReproductionProviderCredit(byoc(), warning)).resolves.toBe("unknown");
    expect(warning).toHaveBeenCalledOnce();

    await expect(assertReproductionProviderCredit({
      ...byoc(),
      provider: "openai",
    })).resolves.toBe("bypassed");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the platform environment key and identifies platform ownership in errors", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "platform-test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: { limit_remaining: -0.01 } }),
      { status: 200 },
    )));
    const error = await assertReproductionProviderCredit({
      providerMode: "platform",
      provider: "openrouter",
      modelName: "openai/gpt-4o",
    }).catch(value => value);
    expect(error.message).toMatch(/configured for this deployment.*spending cap.*Replit subscription/i);
  });

  it("checks platform OpenRouter even for an upstream-vendor provider and deduplicates identical configs", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "platform-test-key");
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ data: { limit_remaining: 2 } }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const config: ModelProviderConfig = {
      providerMode: "platform",
      provider: "openai",
      modelName: "openai/gpt-4o",
    };
    await assertReproductionRuntimeProviderCredits([config, { ...config }]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not let a warning callback failure block unknown status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(assertReproductionProviderCredit(byoc(), () => {
      throw new Error("warning sink unavailable");
    })).resolves.toBe("unknown");
  });
});