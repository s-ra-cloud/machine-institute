import { MANAGED_MODELS, type AvailableManagedModel } from "../shared/model-catalog";
import type { ModelProviderConfig } from "./model-service";

export class ManagedModelError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "ManagedModelError"; }
}

/** BYOK connects directly to these providers and never uses the managed gateway. */
export const BYOC_PROVIDERS = [
  { id: "openai", label: "OpenAI", baseURL: "https://api.openai.com/v1", defaultModel: "gpt-4o", defaultContextWindow: 128_000 },
  { id: "anthropic", label: "Anthropic", baseURL: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-4-20250514", defaultContextWindow: 200_000 },
  { id: "openrouter", label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", defaultModel: "deepseek/deepseek-chat", defaultContextWindow: 64_000 },
] as const;

export function resolveByocSelection(config: Partial<ModelProviderConfig>): ModelProviderConfig {
  if (config.providerMode !== "byoc") throw new ManagedModelError("Select BYOK mode explicitly.");
  const selected = BYOC_PROVIDERS.find(provider => provider.id === config.provider);
  if (!selected) throw new ManagedModelError("Select a supported BYOK provider (OpenAI, Anthropic, or OpenRouter).");
  if (typeof config.modelName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(config.modelName)) {
    throw new ManagedModelError("Select a valid model name for the chosen BYOK provider.");
  }
  if (typeof config.apiKey !== "string" || !isSyntacticallyValidApiKey(selected.id, config.apiKey)) {
    throw new ManagedModelError("Enter a valid-looking API key for the selected BYOK provider.");
  }
  return {
    providerMode: "byoc",
    provider: selected.id,
    modelName: config.modelName,
    apiKey: config.apiKey,
  };
}

export function isSyntacticallyValidApiKey(provider: string, apiKey: string): boolean {
  if (typeof apiKey !== "string" || apiKey.length < 16 || apiKey.length > 512 || apiKey.trim() !== apiKey || /\s/.test(apiKey)) return false;
  if (provider === "openai") return /^sk-(?!or-|ant-)[A-Za-z0-9_-]+$/.test(apiKey);
  if (provider === "anthropic") return /^sk-ant-[A-Za-z0-9_-]+$/.test(apiKey);
  if (provider === "openrouter") return /^sk-or-[A-Za-z0-9_-]+$/.test(apiKey);
  return false;
}
/**
 * Endpoints/credentials must be provisioned by Replit AI Integrations.
 * LAB_ALLOWED_MODELS optionally restricts catalogue selections, not upstream availability.
 */
export function getManagedModels(): AvailableManagedModel[] {
  return MANAGED_MODELS.map(model => {
    let configured = false;
    try { getManagedConnection(model.provider); configured = true; } catch { /* missing or invalid managed setup */ }
    const allowlist = process.env.LAB_ALLOWED_MODELS;
    const verified = allowlist === undefined || allowlist.split(",").map(s => s.trim()).includes(model.model);
    return { ...model, enabled: configured && verified,
      ...(!configured ? { unavailableReason: "Replit-managed OpenRouter is not connected." }
        : !verified ? { unavailableReason: "Model is not allowed by LAB_ALLOWED_MODELS." } : {}),
    };
  });
}
export function resolveManagedSelection(config: { providerMode?: string; provider?: string; modelName?: string }, task?: string): ModelProviderConfig {
  if (config.providerMode && config.providerMode !== "platform") throw new ManagedModelError("New runs require a Replit-managed model. Select a replacement model.");
  const model = getManagedModels().find(m => m.model === config.modelName);
  if (!model || (config.provider && config.provider !== model.provider)) throw new ManagedModelError("Select a supported Replit-managed model explicitly. Legacy model selections are not automatically replaced.");
  if (task === "reproduction" && !model.tools) throw new ManagedModelError("This model does not support reproduction tool calls.");
  if (!model.enabled) throw new ManagedModelError(model.unavailableReason!, 503);
  return { providerMode: "platform", provider: model.provider, modelName: model.model };
}
export function getManagedConnection(provider: string): { baseURL: string; apiKey: string } {
  if (!MANAGED_MODELS.some(model => model.provider === provider)) throw new ManagedModelError("Unsupported managed model provider.");
  const baseURL = process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY;
  if (!baseURL || !apiKey) throw new ManagedModelError("Replit-managed OpenRouter is not connected.", 503);
  let url: URL;
  try { url = new URL(baseURL); } catch { throw new ManagedModelError("Managed integration endpoint configuration is invalid.", 503); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const direct = ["api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com", "openrouter.ai"];
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || direct.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new ManagedModelError("Managed integration endpoint configuration is invalid.", 503);
  }
  return { baseURL, apiKey };
}