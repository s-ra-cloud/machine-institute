import OpenAI from "openai";
import { getManagedConnection, resolveByocSelection, resolveManagedSelection } from "./managed-models";
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

/**
 * Direct BYOK transport. User credentials only enter this in-memory client;
 * callers must not serialize the supplied config or retain it beyond the run.
 */
export function createByocChatClient(config: ModelProviderConfig, options: { maxRetries?: number } = {}): ManagedChatClient {
  const selected = resolveByocSelection(config);
  const endpoint = selected.provider === "openai" ? "https://api.openai.com/v1"
    : selected.provider === "anthropic" ? "https://api.anthropic.com/v1"
    : "https://openrouter.ai/api/v1";
  const client = new OpenAI({
    baseURL: endpoint,
    apiKey: selected.apiKey!,
    maxRetries: options.maxRetries ?? 0,
  });
  return { chat: { completions: { create: async (request, requestOptions) => {
    try {
      const result = await client.chat.completions.create(
        { ...request, model: selected.modelName },
        requestOptions,
      ) as any;
      if (result?.error) return result;
      if (!result?.choices?.length) throw Object.assign(new Error("BYOK provider returned no completion."), { status: 502 });
      for (const choice of result.choices) {
        const message = choice.message;
        if (!message) throw Object.assign(new Error("BYOK provider returned no message."), { status: 502 });
        if (message.refusal != null || ["content_filter", "refusal"].includes(choice.finish_reason)) {
          choice.finish_reason = "content_filter";
          message.content = "";
          message.tool_calls = [];
        } else if (["length", "max_tokens", "model_context_window_exceeded"].includes(choice.finish_reason)) {
          choice.finish_reason = "length";
        } else if (!["stop", "tool_calls"].includes(choice.finish_reason)) {
          throw Object.assign(new Error("BYOK provider returned an unsupported completion status."), { status: 502 });
        }
      }
      return result;
    } catch (error: any) {
      // Provider SDK exceptions can contain request headers and credential data.
      // Preserve only coarse status/code metadata for safe retry classification.
      throw Object.assign(new Error("BYOK provider request failed."), {
        status: Number.isSafeInteger(error?.status) ? error.status : undefined,
        statusCode: Number.isSafeInteger(error?.statusCode) ? error.statusCode : undefined,
        code: typeof error?.code === "string" && /^[A-Z0-9_-]{1,80}$/i.test(error.code) ? error.code : undefined,
      });
    }
  } } } };
}