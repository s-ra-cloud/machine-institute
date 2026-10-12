import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const { openaiCreate, constructorOptions } = vi.hoisted(() => ({
  openaiCreate: vi.fn(), constructorOptions: vi.fn(),
}));
vi.mock("openai", () => ({ default: class {
  constructor(options: unknown) { constructorOptions(options); }
  chat = { completions: { create: openaiCreate } };
} }));
import { createByocChatClient, createManagedChatClient } from "../managed-adapter";
import { generateWithConfig, runToolLoop, validateApiKey } from "../model-service";
const configs = [
  { providerMode: "platform" as const, provider: "openai", modelName: "openai/gpt-4o" },
  { providerMode: "platform" as const, provider: "anthropic", modelName: "anthropic/claude-sonnet-4.6" },
  { providerMode: "platform" as const, provider: "google", modelName: "google/gemini-2.5-flash" },
];
const completion = (finish_reason: unknown, message: any = { content: "complete" }) => ({ choices: [{ finish_reason, message: { role: "assistant", ...message } }] });
beforeEach(() => {
  openaiCreate.mockReset(); constructorOptions.mockReset();
  vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_API_KEY", "synthetic");
  vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", "https://managed.example.test");
  vi.stubEnv("LAB_ALLOWED_MODELS", undefined);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network permitted"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe.each(configs)("managed OpenRouter transport $provider", config => {
  it("uses one gateway and exact slug while retaining native provider identity", async () => {
    openaiCreate.mockResolvedValue(completion("stop"));
    const result = await generateWithConfig(config, "rules", "question");
    expect(result.provider).toBe(config.provider);
    expect(result.model).toBe(config.modelName);
    expect(constructorOptions).toHaveBeenCalledWith(expect.objectContaining({ baseURL: "https://managed.example.test", apiKey: "synthetic" }));
    expect(openaiCreate.mock.calls[0][0].model).toBe(config.modelName);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["length", "content_filter", "refusal", "max_tokens", "model_context_window_exceeded", "unknown", undefined])(
    "never executes or publishes incomplete/refused status %s", async reason => {
      openaiCreate.mockResolvedValue(completion(reason, {
        content: "UNACCEPTED",
        tool_calls: [{ id: "bad", type: "function", function: { name: "run_command", arguments: "{}" } }],
      }));
      const execute = vi.fn(async () => "must not execute");
      const result = await runToolLoop(config, "rules", "question",
        [{ name: "run_command", description: "tool", parameters: { type: "object" } }],
        execute, { maxToolCalls: 2, deadlineMs: Date.now() + 10000 }).catch(error => error);
      expect(execute).not.toHaveBeenCalled();
      if (!(result instanceof Error)) expect(result.content).not.toContain("UNACCEPTED");
      await expect(generateWithConfig(config, "rules", "question")).rejects.toThrow();
    },
  );
  it("blocks explicit refusals even with a successful status", async () => {
    openaiCreate.mockResolvedValue(completion("stop", { content: "unsafe", refusal: "refused" }));
    const result = await createManagedChatClient(config).chat.completions.create({ messages: [] });
    expect(result.choices[0]).toMatchObject({ finish_reason: "content_filter", message: { content: "", tool_calls: [] } });
  });
  it("uses the protected tool loop and preserves tool-result IDs", async () => {
    openaiCreate.mockResolvedValueOnce(completion("tool_calls", { content: null, tool_calls: [
      { id: "call-1", type: "function", function: { name: "read", arguments: "{}" } },
    ] })).mockResolvedValueOnce(completion("stop"));
    const execute = vi.fn(async () => "evidence");
    const result = await runToolLoop(config, "rules", "read",
      [{ name: "read", description: "read", parameters: { type: "object" } }], execute,
      { maxToolCalls: 3, deadlineMs: Date.now() + 10000 });
    expect(result.content).toBe("complete");
    expect(execute).toHaveBeenCalledWith("read", {});
    expect(openaiCreate.mock.calls[1][0].messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "call-1", content: "evidence" }));
  });
  it("sanitizes funding failures", async () => {
    openaiCreate.mockRejectedValue(Object.assign(new Error("private payload insufficient credits"), { status: 402 }));
    const error = await generateWithConfig(config, "rules", "question").catch(error => error);
    expect(error.code).toBe("PROVIDER_PAYMENT_REQUIRED");
    expect(error.message).toMatch(/Replit/);
    expect(error.message).not.toMatch(/private payload/);
  });
});
it("caps output and applies GPT-5 options at the managed gateway", async () => {
  openaiCreate.mockResolvedValue(completion("stop"));
  const client = createManagedChatClient({ providerMode: "platform", provider: "openai", modelName: "openai/gpt-5-mini" });
  await client.chat.completions.create({ model: "wrong", messages: [], max_tokens: 8000, temperature: .3 }, { maxRetries: 0 });
  expect(openaiCreate.mock.calls[0][0]).toMatchObject({ model: "openai/gpt-5-mini", max_tokens: 8000, reasoning_effort: "minimal" });
  expect(openaiCreate.mock.calls[0][0]).not.toHaveProperty("temperature");
  expect(openaiCreate.mock.calls[0][1]).toEqual({ maxRetries: 0 });
});

describe("BYOK provider transport and key handling", () => {
  it.each(["openrouter", "openai"])("restricts tool-parameter routing only on OpenRouter (%s)", async provider => {
    openaiCreate.mockResolvedValue(completion("stop"));
    const request = { messages: [], tools: [{ type: "function", function: { name: "submit_claims" } }],
      tool_choice: { type: "function", function: { name: "submit_claims" } },
      provider: { order: ["example"], require_parameters: false } };
    const modelName = provider === "openrouter" ? "deepseek/deepseek-v4-pro-0813" : "gpt-4o";
    await createByocChatClient({ providerMode: "byoc", provider, modelName,
      apiKey: provider === "openrouter" ? "sk-or-offline-test-key-123456" : "sk-offline-test-key-123456" }).chat.completions.create(request);
    expect(openaiCreate.mock.calls[0][0]).toMatchObject({
      model: modelName, tool_choice: request.tool_choice,
      provider: { order: ["example"], require_parameters: provider === "openrouter" },
    });
    expect(request.provider.require_parameters).toBe(false);
  });
  it("does not add routing restrictions to ordinary OpenRouter text requests", async () => {
    openaiCreate.mockResolvedValue(completion("stop"));
    await createByocChatClient({ providerMode: "byoc", provider: "openrouter",
      modelName: "deepseek/deepseek-v4-pro-0813", apiKey: "sk-or-offline-test-key-123456" })
      .chat.completions.create({ messages: [] });
    expect(openaiCreate.mock.calls[0][0]).not.toHaveProperty("provider");
  });
  const config = {
    providerMode: "byoc" as const,
    provider: "openai",
    modelName: "gpt-4o",
    apiKey: "sk-project-test-key-123456789",
  };
  it("uses the explicitly selected direct provider, model, and transient key", async () => {
    openaiCreate.mockResolvedValue(completion("stop"));
    const result = await generateWithConfig(config, "rules", "question");
    expect(result).toMatchObject({ provider: "openai", model: "gpt-4o", content: "complete" });
    expect(constructorOptions).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: "https://api.openai.com/v1",
      apiKey: config.apiKey,
    }));
    expect(openaiCreate.mock.calls[0][0].model).toBe(config.modelName);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a missing key, unsupported provider, or URL-shaped model before a request", async () => {
    expect(() => createByocChatClient({ ...config, apiKey: undefined })).toThrow(/API key/i);
    expect(() => createByocChatClient({ ...config, provider: "google" })).toThrow(/provider/i);
    expect(() => createByocChatClient({ ...config, modelName: "https://attacker.invalid" })).toThrow(/model/i);
    expect(openaiCreate).not.toHaveBeenCalled();
  });
  it("validates key syntax without making a provider call or returning a key", async () => {
    const result = await validateApiKey("openai", config.apiKey);
    expect(result).toEqual({ valid: true });
    expect(JSON.stringify(result)).not.toContain(config.apiKey);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps provider payment errors distinct from Replit-managed billing", async () => {
    openaiCreate.mockRejectedValue(Object.assign(new Error(`authorization failed with ${config.apiKey}`), { status: 402 }));
    const error = await generateWithConfig(config, "rules", "question").catch(error => error);
    expect(error.message).toMatch(/provider account/i);
    expect(error.message).not.toMatch(/Replit/i);
    expect(error.message).not.toContain(config.apiKey);
  });
});