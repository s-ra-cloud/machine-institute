import { MANAGED_MODELS, type AvailableManagedModel } from "../shared/model-catalog";
import type { ModelProviderConfig } from "./model-service";

export class ManagedModelError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "ManagedModelError"; }
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