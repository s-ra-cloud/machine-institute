import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const openaiCreate = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({ default: class { chat = { completions: { create: openaiCreate } }; } }));
import { createManagedChatClient } from "../managed-adapter";
import { generateWithConfig, runToolLoop } from "../model-service";
import { ContextBudgetError, RequestContextBudget } from "../llm-context";
const configure = (prefix: string, models: string) => {
  vi.stubEnv(`AI_INTEGRATIONS_${prefix}_API_KEY`, "synthetic");
  vi.stubEnv(`AI_INTEGRATIONS_${prefix}_BASE_URL`, "https://managed.example.test");
  vi.stubEnv(`AI_INTEGRATIONS_${prefix}_MODELS`, models);
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => { openaiCreate.mockReset(); configure("OPENAI", "gpt-5-mini,gpt-4o"); configure("ANTHROPIC", "claude-sonnet-4-6"); configure("GEMINI", "gemini-2.5-flash"); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("managed native adapters", () => {
  it.each(["max_tokens", "model_context_window_exceeded", "refusal", "pause_turn", "unknown", undefined])(
    "never executes or publishes Anthropic stop_reason=%s", async stop_reason => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response({
        stop_reason, content: [
          { type: "text", text: "UNACCEPTED_PARTIAL_ANSWER" },
          { type: "tool_use", id: "rejected-call", name: "run_command", input: {} },
        ],
      })));
      const config = { providerMode: "platform" as const, provider: "anthropic", modelName: "claude-sonnet-4-6" };
      const execute = vi.fn(async () => "must not execute");
      const outcome = await runToolLoop(config, "rules", "read",
        [{ name: "run_command", description: "tool", parameters: { type: "object" } }],
        execute, { maxToolCalls: 3, deadlineMs: Date.now() + 10000 }).catch(error => error);
      expect(execute).not.toHaveBeenCalled();
      if (stop_reason === "refusal") expect(outcome).toMatchObject({ content: "", finishReason: "content_filter" });
      else if (stop_reason === "max_tokens" || stop_reason === "model_context_window_exceeded") {
        expect(outcome).toMatchObject({ content: "", finishReason: "length" });
      } else expect(outcome).toBeInstanceOf(Error);
      await expect(generateWithConfig(config, "rules", "question")).rejects.toThrow();
    },
  );
  it.each(["end_turn", "stop_sequence"])("accepts complete Anthropic stop_reason=%s", async stop_reason => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ stop_reason, content: [{ type: "text", text: "complete" }] })));
    expect((await generateWithConfig({ providerMode: "platform", provider: "anthropic", modelName: "claude-sonnet-4-6" }, "rules", "question")).content).toBe("complete");
  });
  it.each(["length", "content_filter", "tool_calls", "function_call", "unknown", undefined])(
    "rejects OpenAI partial text with finish_reason=%s", async finish_reason => {
      openaiCreate.mockResolvedValue({ choices: [{ finish_reason, message: { content: "UNACCEPTED_PARTIAL_ANSWER" } }] });
      await expect(generateWithConfig({ providerMode: "platform", provider: "openai", modelName: "gpt-4o" }, "rules", "question")).rejects.toThrow(/No result was accepted/);
    },
  );
  it("rejects OpenAI refusals even with stop and text, but accepts a genuine stop", async () => {
    const config = { providerMode: "platform" as const, provider: "openai", modelName: "gpt-4o" };
    openaiCreate.mockResolvedValueOnce({ choices: [{ finish_reason: "stop", message: { content: "partial", refusal: "private refusal details" } }] });
    await expect(generateWithConfig(config, "rules", "question")).rejects.toThrow(/No result was accepted/);
    openaiCreate.mockResolvedValueOnce({ choices: [{ finish_reason: "stop", message: { content: "complete" } }] });
    expect((await generateWithConfig(config, "rules", "question")).content).toBe("complete");
  });
  it("fails closed instead of partially evicting a parallel signed Gemini turn under contextProtection", async () => {
    const signedParts = [
      { functionCall: { name: "run_command", args: {} }, thoughtSignature: "parallel-turn-signature" },
      { functionCall: { name: "read_tool_result", args: {} } },
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ candidates: [{ finishReason: "STOP", content: { parts: signedParts } }] }))
      .mockResolvedValue(response({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "done" }] } }] }));
    vi.stubGlobal("fetch", fetchMock);
    // Freeze a real numeric token boundary immediately below the completed
    // parallel turn. Ordinary partial eviction would fit this exact boundary;
    // the newest retrieval sibling must protect the entire signed group.
    const originalFits = RequestContextBudget.prototype.fits;
    let pressureApplied = false;
    const observedGroups: number[] = [];
    vi.spyOn(RequestContextBudget.prototype, "fits").mockImplementation(function (this: RequestContextBudget, request: any) {
      const parallel = request.messages?.find((message: any) => message.providerParts?.length);
      if (parallel) {
        observedGroups.push(parallel.tool_calls.length);
        if (!pressureApplied) {
          this.inputLimit = this.estimate(request) - 1;
          pressureApplied = true;
        }
      }
      return originalFits.call(this, request);
    });
    const execute = vi.fn(async () => "x");
    await expect(runToolLoop(
      { providerMode: "platform", provider: "google", modelName: "gemini-2.5-flash" },
      "rules", "read",
      ["run_command", "read_tool_result"].map(name => ({ name, description: "tool", parameters: { type: "object" } })),
      execute, { maxToolCalls: 5, deadlineMs: Date.now() + 10000, contextProtection: { getState: () => "state" } },
    )).rejects.toBeInstanceOf(ContextBudgetError);
    expect(pressureApplied).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(observedGroups.length).toBeGreaterThan(1);
    expect(observedGroups.every(count => count === 2)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("evicts an unprotected signed parallel turn with all paired results atomically", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ candidates: [{ finishReason: "STOP", content: { parts: [
        { functionCall: { name: "run_a", args: {} }, thoughtSignature: "signed-parallel-group" },
        { functionCall: { name: "run_b", args: {} } },
      ] } }] }))
      .mockResolvedValue(response({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "done" }] } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const originalFits = RequestContextBudget.prototype.fits;
    let pressureApplied = false;
    vi.spyOn(RequestContextBudget.prototype, "fits").mockImplementation(function (this: RequestContextBudget, request: any) {
      if (!pressureApplied && request.messages?.some((m: any) => m.providerParts?.length)) {
        this.inputLimit = this.estimate(request) - 1;
        pressureApplied = true;
      }
      return originalFits.call(this, request);
    });
    const execute = vi.fn(async () => "x");
    const result = await runToolLoop(
      { providerMode: "platform", provider: "google", modelName: "gemini-2.5-flash" },
      "rules", "read", ["run_a", "run_b"].map(name => ({ name, description: "tool", parameters: { type: "object" } })),
      execute, { maxToolCalls: 5, deadlineMs: Date.now() + 10000, contextProtection: { getState: () => "state" } },
    );
    expect(result.content).toBe("done");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const replay = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(replay.contents.flatMap((m: any) => m.parts).some((p: any) => p.functionCall || p.functionResponse)).toBe(false);
    expect(JSON.stringify(replay)).not.toContain("signed-parallel-group");
  });

  it.each(["MAX_TOKENS", "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
    "MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "TOO_MANY_TOOL_CALLS",
    "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "NO_IMAGE",
    "OTHER", "FINISH_REASON_UNSPECIFIED", "FUTURE_UNKNOWN_STATUS", undefined])(
    "never executes or publishes Gemini output with finishReason=%s", async finishReason => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response({
        candidates: [{ finishReason, content: { parts: [
          { text: "UNACCEPTED_PARTIAL_ANSWER" }, { functionCall: { name: "run_command", args: {} } },
        ] } }],
      })));
      const config = { providerMode: "platform" as const, provider: "google", modelName: "gemini-2.5-flash" };
      const execute = vi.fn(async () => "must not execute");
      const outcome = await runToolLoop(config, "rules", "read",
        [{ name: "run_command", description: "tool", parameters: { type: "object" } }],
        execute, { maxToolCalls: 3, deadlineMs: Date.now() + 10000 }).catch(error => error);
      expect(execute).not.toHaveBeenCalled();
      if (finishReason === undefined || ["OTHER", "FINISH_REASON_UNSPECIFIED", "FUTURE_UNKNOWN_STATUS"].includes(finishReason)) {
        expect(outcome).toBeInstanceOf(Error);
      } else {
        expect(outcome.content).toBe("");
        expect(outcome.finishReason).toBe(
          ["MAX_TOKENS", "MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "TOO_MANY_TOOL_CALLS", "NO_IMAGE"].includes(finishReason)
            ? "length" : "content_filter",
        );
      }
      await expect(generateWithConfig(config, "rules", "question")).rejects.toThrow();
    },
  );
  it("blocks Gemini prompt-feedback refusals even without a candidate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ promptFeedback: { blockReason: "SAFETY" } })));
    const client = createManagedChatClient({ providerMode: "platform", provider: "google", modelName: "gemini-2.5-flash" });
    const result = await client.chat.completions.create({ messages: [], max_tokens: 100 });
    expect(result.choices[0]).toMatchObject({ finish_reason: "content_filter", message: { content: "", tool_calls: [] } });
  });
  it("normalizes GPT-5 token/temperature options without raising allowance", async () => {
    openaiCreate.mockResolvedValue({ choices: [{ message: { content: "answer" } }] });
    const client = createManagedChatClient({ providerMode: "platform", provider: "openai", modelName: "gpt-5-mini" });
    await client.chat.completions.create({ model: "gpt-5-mini", messages: [], max_tokens: 8000, temperature: .3 });
    expect(openaiCreate.mock.calls[0][0]).toMatchObject({ max_completion_tokens: 8000, reasoning_effort: "minimal" });
    expect(openaiCreate.mock.calls[0][0]).not.toHaveProperty("temperature");
    expect(openaiCreate.mock.calls[0][0]).not.toHaveProperty("max_tokens");
  });
  it("runs Anthropic tools through the same strict scientific tool loop", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "a1", name: "read", input: { path: "/work/paper.md" } }] }))
      .mockResolvedValueOnce(response({ stop_reason: "end_turn", content: [{ type: "text", text: "finished" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const execute = vi.fn().mockResolvedValue("source text");
    const result = await runToolLoop({ providerMode: "platform", provider: "anthropic", modelName: "claude-sonnet-4-6" }, "rules", "read source",
      [{ name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }], execute,
      { maxToolCalls: 3, deadlineMs: Date.now() + 10000 });
    expect(result.content).toBe("finished");
    expect(execute).toHaveBeenCalledWith("read", { path: "/work/paper.md" });
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.messages.at(-1).content[0]).toMatchObject({ type: "tool_result", tool_use_id: "a1", content: "source text" });
  });
  it("preserves Gemini signed function-call parts through subsequent rounds", async () => {
    const signedPart = { functionCall: { name: "read", args: {} }, thoughtSignature: "opaque-synthetic-signature" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ candidates: [{ finishReason: "STOP", content: { parts: [signedPart] } }] }))
      .mockResolvedValueOnce(response({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "done" }] } }] }));
    vi.stubGlobal("fetch", fetchMock);
    await runToolLoop({ providerMode: "platform", provider: "google", modelName: "gemini-2.5-flash" }, "rules", "read", [{ name: "read", description: "read", parameters: { type: "object" } }], async () => "evidence",
      { maxToolCalls: 3, deadlineMs: Date.now() + 10000 });
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.contents.find((c: any) => c.role === "model").parts).toEqual([signedPart]);
    expect(body.contents.at(-1).parts[0].functionResponse).toEqual({ name: "read", response: { result: "evidence" } });
  });
  it("normalizes native text generation and funding failures without raw body leaks", async () => {
    const config = { providerMode: "platform" as const, provider: "anthropic", modelName: "claude-sonnet-4-6" };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response({ stop_reason: "end_turn", content: [{ type: "text", text: "text answer" }] }))
      .mockResolvedValueOnce(response({ error: { message: "private payload insufficient credits" } }, 402)));
    expect((await generateWithConfig(config, "rules", "question")).content).toBe("text answer");
    const error = await generateWithConfig(config, "rules", "question").catch(e => e);
    expect(error.code).toBe("PROVIDER_PAYMENT_REQUIRED");
    expect(error.message).toMatch(/Replit/);
    expect(error.message).not.toMatch(/private payload/);
  });
  it("does not resurrect compacted Gemini prose or removed tool calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "done" }] } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createManagedChatClient({ providerMode: "platform", provider: "google", modelName: "gemini-2.5-flash" });
    await client.chat.completions.create({
      model: "gemini-2.5-flash", max_tokens: 1000, messages: [
        { role: "system", content: "rules" },
        { role: "assistant", content: "fitted prose", tool_calls: [{ id: "keep", function: { name: "read", arguments: "{}" } }],
          providerParts: [
            { _toolCallId: "removed", functionCall: { name: "old", args: {} }, thoughtSignature: "old-signature" },
            { _toolCallId: "keep", functionCall: { name: "read", args: {} }, thoughtSignature: "keep-signature" },
          ] },
        { role: "tool", tool_call_id: "keep", content: "evidence" },
      ],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.contents[0].parts).toEqual([{ text: "fitted prose" }, { functionCall: { name: "read", args: {} }, thoughtSignature: "keep-signature" }]);
    expect(JSON.stringify(body)).not.toContain("old-signature");
    expect(JSON.stringify(body)).not.toContain("_toolCallId");
  });
  it("classifies native context constraints separately from rate limits", async () => {
    const config = { providerMode: "platform" as const, provider: "google", modelName: "gemini-2.5-flash" };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response({ error: { message: "input token limit: 32768" } }, 400))
      .mockResolvedValueOnce(response({ error: { message: "Rate limit, private details" } }, 429)));
    const contextError = await generateWithConfig(config, "rules", "question", { contextRequest: true }).catch(e => e);
    expect(contextError.limit).toBe(32768);
    const rateError = await generateWithConfig(config, "rules", "question").catch(e => e);
    expect(rateError.message).toMatch(/rate limit/);
    expect(rateError.message).not.toMatch(/private details/);
  });
});