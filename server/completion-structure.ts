/** Structural metadata only: never retain content, arguments, refusal or reasoning text. */
export interface CompletionStructure {
  responseContentType?: string;
  responseContentLength?: number;
  responseToolCallsType?: string;
  responseToolCallCount?: number;
  responseRecognizedToolCallCount?: number;
  responseReasoningPresent?: number;
  responseRefusalPresent?: number;
  responsePromptTokens?: number;
  responseCompletionTokens?: number;
  responseReasoningTokens?: number;
}
const counts = ["responseContentLength", "responseToolCallCount", "responseRecognizedToolCallCount",
  "responsePromptTokens", "responseCompletionTokens", "responseReasoningTokens"] as const;
const flags = ["responseReasoningPresent", "responseRefusalPresent"] as const;
const types = ["missing", "null", "string", "array", "object", "number", "boolean", "unknown"];
const valueType = (value: unknown) => value === undefined ? "missing" : value === null ? "null"
  : Array.isArray(value) ? "array" : types.includes(typeof value) ? typeof value : "unknown";

export function sanitizeCompletionStructure(value: CompletionStructure = {}): CompletionStructure {
  const result: CompletionStructure = {};
  for (const key of ["responseContentType", "responseToolCallsType"] as const)
    if (types.includes(value[key] ?? "")) result[key] = value[key];
  for (const key of counts)
    if (Number.isSafeInteger(value[key]) && value[key]! >= 0) result[key] = value[key];
  for (const key of flags)
    if (value[key] === 0 || value[key] === 1) result[key] = value[key];
  return result;
}

export function completionStructure(completion: any): CompletionStructure {
  const msg = completion?.choices?.[0]?.message;
  const calls = msg?.tool_calls;
  return sanitizeCompletionStructure({
    responseContentType: valueType(msg?.content),
    responseContentLength: typeof msg?.content === "string" ? msg.content.length : undefined,
    responseToolCallsType: valueType(calls),
    responseToolCallCount: Array.isArray(calls) ? calls.length : undefined,
    responseRecognizedToolCallCount: Array.isArray(calls)
      ? calls.filter((c: any) => c?.type === "function" && c.function?.name).length : undefined,
    responseReasoningPresent: Number(msg?.reasoning != null || msg?.reasoning_content != null || msg?.reasoning_details != null),
    responseRefusalPresent: Number(msg?.refusal != null),
    responsePromptTokens: completion?.usage?.prompt_tokens,
    responseCompletionTokens: completion?.usage?.completion_tokens,
    responseReasoningTokens: completion?.usage?.completion_tokens_details?.reasoning_tokens,
  });
}
