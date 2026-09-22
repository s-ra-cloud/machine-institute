import OpenAI from "openai";
import { getManagedConnection, resolveManagedSelection } from "./managed-models";
import { MANAGED_MODELS } from "../shared/model-catalog";
import type { ModelProviderConfig } from "./model-service";

type ChatRequest = Record<string, any>;
export interface ManagedChatClient {
  chat: { completions: { create(request: any, options?: { timeout?: number; maxRetries?: number }): Promise<any> } };
}

/** A narrow normalized transport: scientific tool execution stays in runToolLoop. */
export function createManagedChatClient(config: ModelProviderConfig, options: { maxRetries?: number } = {}): ManagedChatClient {
  const selected = resolveManagedSelection(config);
  const connection = getManagedConnection(selected.provider);
  const metadata = MANAGED_MODELS.find(m => m.model === selected.modelName)!;
  if (selected.provider === "openai") {
    const client = new OpenAI({ ...connection, maxRetries: options.maxRetries ?? 0 });
    return { chat: { completions: { create: async (request: ChatRequest, requestOptions) => {
      const body = { ...request };
      body.max_tokens = Math.min(body.max_tokens ?? 12000, metadata.maxOutputTokens);
      if (/^gpt-5(?:-|$)/.test(selected.modelName)) {
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
        delete body.temperature;
        // Keep a usable answer allowance without increasing the caller's token budget.
        body.reasoning_effort = "minimal";
      }
      return client.chat.completions.create(body as any, requestOptions);
    } } } };
  }
  let sequence = 0;
  return { chat: { completions: { create: async (request: ChatRequest, requestOptions) => {
    const anthropic = selected.provider === "anthropic";
    const body = anthropic ? anthropicRequest(request) : googleRequest(request);
    const root = connection.baseURL.replace(/\/$/, "");
    const endpoint = anthropic
      ? `${root.replace(/\/v1$/, "")}/v1/messages`
      : `${root.replace(/\/v1beta$/, "")}/v1beta/models/${encodeURIComponent(selected.modelName)}:generateContent`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: anthropic
        ? { "Content-Type": "application/json", "x-api-key": connection.apiKey, "anthropic-version": "2023-06-01" }
        : { "Content-Type": "application/json", "x-goog-api-key": connection.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(requestOptions?.timeout ?? 600000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.error) {
      // Raw provider data is used only transiently by the common sanitizer.
      // Do not include endpoint URLs, request bodies, or credentials.
      const error = new Error("Managed model request failed.");
      Object.assign(error, { status: response.status, error: result?.error, headers: response.headers });
      throw error;
    }
    if (anthropic) {
      const stopReason = result?.stop_reason;
      if (["refusal", "max_tokens", "model_context_window_exceeded"].includes(stopReason)) {
        return { choices: [{ finish_reason: stopReason === "refusal" ? "content_filter" : "length",
          message: { role: "assistant", content: "", tool_calls: [] } }] };
      }
      if (!["end_turn", "stop_sequence", "tool_use"].includes(stopReason)) {
        // pause_turn needs a provider-specific continuation protocol, which is
        // not implemented here. Missing/unknown reasons also fail closed.
        throw Object.assign(new Error("Managed model returned an unsupported completion status."), { status: 502 });
      }
      const blocks = Array.isArray(result?.content) ? result.content : [];
      const tools = blocks.filter((b: any) => b.type === "tool_use").map((b: any) => ({
        id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) },
      }));
      return { choices: [{ finish_reason: stopReason === "tool_use" ? "tool_calls" : "stop",
      message: { role: "assistant", content: blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"), tool_calls: tools } }] };
    }
    const candidate = result?.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const blocked = Boolean(result?.promptFeedback?.blockReason)
      || ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
        "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION"].includes(finishReason);
    const incomplete = ["MAX_TOKENS", "MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL",
      "TOO_MANY_TOOL_CALLS", "NO_IMAGE"].includes(finishReason);
    if (!blocked && !incomplete && finishReason !== "STOP") {
      // Unknown/unspecified finish reasons are not proof of a complete answer.
      // Never pass their prose or function calls to execution/publication.
      throw Object.assign(new Error("Managed model returned an unsupported completion status."), { status: 502 });
    }
    if (blocked || incomplete) {
      return { choices: [{ finish_reason: blocked ? "content_filter" : "length",
        message: { role: "assistant", content: "", tool_calls: [] } }] };
    }
    const parts = candidate?.content?.parts ?? [];
    const callParts = parts.filter((p: any) => p.functionCall);
    const tools = callParts.map((p: any) => ({
      id: p.functionCall.id || `gemini-${++sequence}`, type: "function",
      function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
    }));
    return { choices: [{ finish_reason: tools.length ? "tool_calls" : "stop",
    message: { role: "assistant", content: parts.filter((p: any) => typeof p.text === "string" && !p.thought).map((p: any) => p.text).join("\n"),
      tool_calls: tools, providerParts: callParts.map((part: any, index: number) => ({ ...part, _toolCallId: tools[index].id })) } }] };
  } } } };
}

function anthropicRequest(request: ChatRequest) {
  const messages: any[] = [];
  const append = (role: string, content: any[]) => {
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...content);
    else messages.push({ role, content });
  };
  for (const message of request.messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      append("user", [{ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content || "(empty tool result)" }]);
    } else {
      const content: any[] = message.content ? [{ type: "text", text: message.content }] : [];
      for (const call of message.tool_calls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) });
      }
      append(message.role === "assistant" ? "assistant" : "user", content.length ? content : [{ type: "text", text: "(empty)" }]);
    }
  }
  return {
    model: request.model, system: request.messages.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n\n"),
    messages, max_tokens: request.max_tokens, temperature: request.temperature,
    ...(request.tools?.length ? { tools: request.tools.map((t: any) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })), tool_choice: { type: "auto" } } : {}),
  };
}

function googleRequest(request: ChatRequest) {
  const names = new Map<string, string>();
  const contents: any[] = [];
  for (const message of request.messages) {
    if (message.role === "system") continue;
    let parts: any[];
    if (message.role === "tool") {
      parts = [{ functionResponse: { name: names.get(message.tool_call_id), response: { result: message.content } } }];
    } else if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
      // Gemini thought signatures are opaque continuation data, not reasoning
      // text to publish. Retain their exact part structure across tool rounds.
      parts = [
        ...(message.content ? [{ text: message.content }] : []),
        ...(message.tool_calls ?? []).map((call: any) => {
          const original = message.providerParts?.find((part: any) => part._toolCallId === call.id);
          if (!original) return { functionCall: { name: call.function.name, args: JSON.parse(call.function.arguments) } };
          const { _toolCallId, ...signedPart } = original;
          return signedPart;
        }),
      ];
    } else parts = [{ text: message.content || "(empty)" }];
    const role = message.role === "assistant" ? "model" : "user";
    if (contents.at(-1)?.role === role) contents.at(-1).parts.push(...parts);
    else contents.push({ role, parts });
  }
  return {
    systemInstruction: { parts: [{ text: request.messages.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n\n") }] },
    contents, generationConfig: { maxOutputTokens: request.max_tokens, temperature: request.temperature },
    ...(request.tools?.length ? { tools: [{ functionDeclarations: request.tools.map((t: any) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })) }] } : {}),
  };
}