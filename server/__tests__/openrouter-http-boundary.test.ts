import { afterEach, describe, expect, it, vi } from "vitest";
import { createByocChatClient } from "../managed-adapter";
import { extractReproductionClaims } from "../reproduction-extraction";
import { completionStructure } from "../completion-structure";
import { runToolLoop } from "../model-service";

// Do not mock OpenAI: exercise its real HTTP JSON parser, then our adapter.
// Only fetch is replaced, so these tests cannot make billable requests.
const config = {
  providerMode: "byoc" as const, provider: "openrouter",
  modelName: "deepseek/deepseek-v4-pro-0813",
  apiKey: "sk-or-synthetic-offline-test-123456",
};
const quote = "The measured experimental score was exactly 0.91.";
const toolCall = { id: "call_1", type: "function", function: {
  name: "submit_claims",
  arguments: JSON.stringify({ claims: [{ source_quote: quote, copy_source_quote: true }], has_more: false }),
} };
const envelope = (finish_reason: string, message: Record<string, unknown>) => ({
  id: "synthetic-completion", object: "chat.completion", created: 1,
  model: config.modelName, choices: [{ index: 0, finish_reason, message: { role: "assistant", ...message } }],
  usage: { prompt_tokens: 100, completion_tokens: 900,
    completion_tokens_details: { reasoning_tokens: 20 } },
});
function intercept(responses: unknown[]) {
  const fetch = vi.fn(async () => {
    if (!responses.length) throw new Error("Unexpected extra HTTP request");
    return new Response(JSON.stringify(responses.shift()), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("OpenRouter HTTP → real SDK → BYOK adapter → extraction", () => {
  it.each([
    { reasoning: "PRIVATE_CONTINUATION" },
    { reasoning_content: "PRIVATE_CONTINUATION" },
    { reasoning_details: [{ type: "reasoning.text", text: "PRIVATE_CONTINUATION", index: 0 }] },
  ])("preserves opaque reasoning in continuation requests without logging it: %j", async reasoning => {
    const firstCall = { ...toolCall, function: { ...toolCall.function,
      arguments: JSON.stringify({ claims: [{ source_quote: quote, copy_source_quote: true }], has_more: true }) } };
    const lastCall = { ...toolCall, function: { ...toolCall.function,
      arguments: JSON.stringify({ claims: [], has_more: false }) } };
    const fetch = intercept([
      envelope("tool_calls", { content: null, ...reasoning, tool_calls: [firstCall] }),
      envelope("tool_calls", { content: null, tool_calls: [lastCall] }),
    ]);
    const events: any[] = [];
    const result = await extractReproductionClaims({
      paper: quote, instructions: "Extract", config, deadline: Date.now() + 60_000,
      onAccepted: async () => {}, onOutcome: event => { events.push(event); },
    });
    expect(result.coverage.termination).toBe("complete");
    const requests = fetch.mock.calls.map(call => JSON.parse((call as unknown as [unknown, RequestInit])[1].body as string));
    expect(requests.every(r => r.tool_choice === "auto")).toBe(true);
    expect(requests[1].messages.find((m: any) => m.role === "assistant")).toMatchObject(reasoning);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_CONTINUATION");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CONTINUATION");
  });

  it("does not dispatch a known but wrong tool when auto choice is used for a required stage", async () => {
    const call = (name: string) => envelope("tool_calls", { content: null, tool_calls: [{
      id: name, type: "function", function: { name, arguments: "{}" },
    }] });
    intercept([call("wrong"), call("required")]);
    let complete = false;
    const execute = vi.fn(async (_name: string, _args: Record<string, unknown>) => { complete = true; return "accepted"; });
    await runToolLoop(config, "rules", "task",
      ["wrong", "required"].map(name => ({ name, description: name, parameters: { type: "object" } })),
      execute, { maxToolCalls: 3, deadlineMs: Date.now() + 60_000,
        getRequiredTool: () => "required", isStageComplete: () => complete });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toBe("required");
  });
  it("keeps simultaneous request observations isolated on a reused client", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      const text = JSON.parse(init.body).messages[0].content;
      if (text === "one") await new Promise(resolve => setTimeout(resolve, 10));
      return new Response(JSON.stringify(envelope("stop", { content: text })), {
        headers: { "content-type": "application/json" },
      });
    }));
    const client = createByocChatClient(config);
    const results = await Promise.all(["one", "second response"].map(content =>
      client.chat.completions.create({ messages: [{ role: "user", content }] })));
    expect(results.map(r => completionStructure(r).httpResponse?.responseContentLength))
      .toEqual([3, 15]);
  });

  it("does not turn invalid HTTP JSON into a usable completion or an extra request", async () => {
    const fetch = vi.fn(async () => new Response("PRIVATE_INVALID_JSON", {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);
    await expect(createByocChatClient(config).chat.completions.create({ messages: [] }))
      .rejects.toThrow("BYOK provider request failed.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["tool_calls", { content: null, tool_calls: [toolCall], reasoning: "synthetic private text" }],
    ["stop", { content: null, reasoning: "synthetic private text" }],
    ["length", { content: null, reasoning: "synthetic private text" }],
    ["stop", { content: "ordinary text" }],
  ] as const)("preserves non-refusal HTTP message fields (%s)", async (finish, message) => {
    const raw = envelope(finish, message);
    const fetch = intercept([raw]);
    const result = await createByocChatClient(config).chat.completions.create({
      messages: [{ role: "user", content: "Extract" }],
      tools: [{ type: "function", function: { name: "submit_claims", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "submit_claims" } },
    });
    expect(result.choices).toEqual(raw.choices);
    const { httpResponse, ...postAdapter } = completionStructure(result);
    expect(httpResponse).toEqual(completionStructure(raw));
    expect(postAdapter).toEqual(httpResponse);
    expect(JSON.stringify(completionStructure(result))).not.toContain("synthetic private text");
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [unknown, RequestInit])[1].body as string);
    expect(body.model).toBe(config.modelName);
    expect(body.provider.require_parameters).toBe(true);
    expect(body.tool_choice.function.name).toBe("submit_claims");
  });

  it("intentionally removes calls on a provider refusal, rather than executing them", async () => {
    intercept([envelope("tool_calls", { content: "blocked", refusal: "blocked", tool_calls: [toolCall] })]);
    const result = await createByocChatClient(config).chat.completions.create({ messages: [] });
    expect(result.choices[0].finish_reason).toBe("content_filter");
    expect(result.choices[0].message.tool_calls).toEqual([]);
    const structure = completionStructure(result);
    expect(structure.httpResponse).toMatchObject({
      responseToolCallCount: 1, responseRefusalPresent: 1, responseFinishReason: "tool_calls",
    });
    expect(structure).toMatchObject({ responseToolCallCount: 0, responseFinishReason: "content_filter" });
  });

  it("recovers from a null HTTP response when the next response actually contains a valid call", async () => {
    const fetch = intercept([
      envelope("stop", { content: null, reasoning: "synthetic private text" }),
      envelope("tool_calls", { content: null, tool_calls: [toolCall] }),
    ]);
    const events: any[] = [], onAccepted = vi.fn(async () => {});
    const result = await extractReproductionClaims({
      paper: quote, instructions: "Extract", config, deadline: Date.now() + 60_000,
      onAccepted, onOutcome: event => { events.push(event); },
    });
    expect(result.coverage.termination).toBe("complete");
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    const secondRequest = JSON.parse((fetch.mock.calls[1] as unknown as [unknown, RequestInit])[1].body as string);
    expect(secondRequest.messages.find((m: any) => m.role === "assistant").reasoning).toBe("synthetic private text");
    expect(events.filter(e => e.kind === "completion").map(e => e.responseToolCallsType))
      .toEqual(["missing", "array"]);
    expect(events.filter(e => e.kind === "completion").map(e => e.httpResponse?.responseToolCallsType))
      .toEqual(["missing", "array"]);
    expect(JSON.stringify(events)).not.toContain("synthetic private text");
  });

  it("retains incomplete coverage when all three HTTP responses lack calls", async () => {
    const fetch = intercept(["length", "stop", "stop"].map(finish =>
      envelope(finish, { content: null, reasoning: "synthetic private text" })));
    const onAccepted = vi.fn(async () => {});
    await expect(extractReproductionClaims({
      paper: quote, instructions: "Extract", config, deadline: Date.now() + 60_000, onAccepted,
    })).rejects.toThrow("no grounded claims accepted from 1/1 packets. No GPU allocated.");
    expect(onAccepted).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
