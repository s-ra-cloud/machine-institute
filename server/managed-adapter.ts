import OpenAI from "openai";
import { getManagedConnection, resolveManagedSelection } from "./managed-models";
import { MANAGED_MODELS } from "../shared/model-catalog";
import type { ModelProviderConfig } from "./model-service";

export interface ManagedChatClient {
  chat: { completions: { create(request: any, options?: { timeout?: number; maxRetries?: number }): Promise<any> } };
}

/** Native model identity is independent of the single managed OpenRouter transport. */
export function createManagedChatClient(config: ModelProviderConfig, options: { maxRetries?: number } = {}): ManagedChatClient {
  const selected = resolveManagedSelection(config);
  const metadata = MANAGED_MODELS.find(m => m.model === selected.modelName)!;
  const client = new OpenAI({ ...getManagedConnection(selected.provider), maxRetries: options.maxRetries ?? 0 });
  return { chat: { completions: { create: async (request, requestOptions) => {
    const body = { ...request, model: selected.modelName };
    body.max_tokens = Math.min(body.max_tokens ?? body.max_completion_tokens ?? 12000, metadata.maxOutputTokens);
    delete body.max_completion_tokens;
    if (selected.modelName.startsWith("openai/gpt-5")) {
      delete body.temperature;
      body.reasoning_effort = "minimal";
    }
    const result = await client.chat.completions.create(body, requestOptions) as any;
    // The common service classifies envelope errors (funding/context/retries)
    // before accepting any message, without leaking raw provider payloads.
    if (result?.error) return result;
    if (!result?.choices?.length) throw Object.assign(new Error("Managed model returned no completion."), { status: 502 });
    for (const choice of result.choices) {
      const message = choice.message;
      if (!message) throw Object.assign(new Error("Managed model returned no message."), { status: 502 });
      if (message.refusal != null || ["content_filter", "refusal"].includes(choice.finish_reason)) {
        choice.finish_reason = "content_filter";
        message.content = "";
        message.tool_calls = [];
      } else if (["length", "max_tokens", "model_context_window_exceeded"].includes(choice.finish_reason)) {
        choice.finish_reason = "length";
        // Preserve rejected calls for bounded repair and evidence numbering.
        // runToolLoop rejects the ENTIRE incomplete turn before executing calls.
      } else if (!["stop", "tool_calls"].includes(choice.finish_reason)) {
        // Unknown and missing completion status never authorize tool execution or publication.
        throw Object.assign(new Error("Managed model returned an unsupported completion status."), { status: 502 });
      }
    }
    return result;
  } } } };
}