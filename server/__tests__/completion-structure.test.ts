import { expect, it } from "vitest";
import { completionStructure, sanitizeCompletionStructure } from "../completion-structure";
import { ReproductionDiagnostics } from "../reproduction-diagnostics";

it("persists only allowlisted structure, never reasoning, refusal, arguments or arbitrary fields", () => {
  const structure = completionStructure({
    choices: [{ message: { content: null, reasoning: "PRIVATE_REASONING", refusal: "PRIVATE_REFUSAL",
      tool_calls: [{ type: "function", function: { name: "submit_claims", arguments: "PRIVATE_ARGUMENTS" } },
        { type: "unknown", payload: "PRIVATE_PAYLOAD" }] } }],
    usage: { prompt_tokens: 100, completion_tokens: 80, completion_tokens_details: { reasoning_tokens: 70 },
      secret: "PRIVATE_USAGE" },
  });
  const diagnostics = new ReproductionDiagnostics();
  diagnostics.observe({ kind: "completion", round: 1, callCount: 0, ...structure });
  expect(diagnostics.snapshot().events[0]).toMatchObject({
    responseContentType: "null", responseToolCallsType: "array", responseToolCallCount: 2,
    responseRecognizedToolCallCount: 1, responseReasoningPresent: 1, responseRefusalPresent: 1,
    responsePromptTokens: 100, responseCompletionTokens: 80, responseReasoningTokens: 70,
  });
  expect(JSON.stringify(diagnostics.snapshot())).not.toContain("PRIVATE_");
});

it("does not turn missing or malformed usage into zero tokens or persist untrusted diagnostic values", () => {
  expect(completionStructure({ choices: [{ message: { content: "" } }] })).toMatchObject({
    responseContentType: "string", responseContentLength: 0, responseToolCallsType: "missing",
    responseReasoningPresent: 0,
  });
  expect(sanitizeCompletionStructure({
    responseContentType: "PRIVATE_VALUE", responseToolCallsType: "PRIVATE_VALUE",
    responsePromptTokens: -1, responseCompletionTokens: Infinity, responseReasoningTokens: 0.5,
    responseReasoningPresent: 7, responseToolCallCount: "PRIVATE_VALUE", extra: "PRIVATE_VALUE",
  } as any)).toEqual({});
  expect(completionStructure({})).not.toHaveProperty("responseCompletionTokens");
});
