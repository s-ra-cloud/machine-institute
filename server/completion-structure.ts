/** Structural metadata only: never retain content, arguments, refusal or reasoning text. */
export interface CompletionStructure {
  httpResponse?: CompletionStructure;
  responseFinishReason?: string;
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
const finishes = ["stop", "length", "tool_calls", "content_filter", "refusal", "function_call",
  "max_tokens", "model_context_window_exceeded"];
const types = ["missing", "null", "string", "array", "object", "number", "boolean", "unknown"];
const valueType = (value: unknown) => value === undefined ? "missing" : value === null ? "null"
  : Array.isArray(value) ? "array" : types.includes(typeof value) ? typeof value : "unknown";

const httpStructures = new WeakMap<object, CompletionStructure>();
export function retainHttpStructure(completion: object, structure: CompletionStructure) {
  httpStructures.set(completion, sanitizeCompletionStructure(structure, false));
}

/** Observe only the SDK's normal JSON read; no extra body copy or network request. */
export function observingFetch(observe: (structure: CompletionStructure) => void): typeof fetch {
  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    const readJson = response.json.bind(response);
    response.json = async () => {
      const body = await readJson();
      try { observe(completionStructure(body)); } catch { /* Diagnostics never block parsing. */ }
      return body;
    };
    return response;
  };
}

export function sanitizeCompletionStructure(value: CompletionStructure = {}, includeHttp = true): CompletionStructure {
  const result: CompletionStructure = {};
  if (finishes.includes(value.responseFinishReason ?? ""))
    result.responseFinishReason = value.responseFinishReason;
  if (includeHttp && value.httpResponse && typeof value.httpResponse === "object")
    result.httpResponse = sanitizeCompletionStructure(value.httpResponse, false);
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
    httpResponse: completion && typeof completion === "object" ? httpStructures.get(completion) : undefined,
    responseFinishReason: completion?.choices?.[0]?.finish_reason,
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
