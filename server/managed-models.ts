import { MANAGED_MODELS, type AvailableManagedModel, type ManagedProvider } from "../shared/model-catalog";
import type { ModelProviderConfig } from "./model-service";

const prefixes: Record<ManagedProvider, string> = {
  openai: "OPENAI", anthropic: "ANTHROPIC", google: "GEMINI",
};
export class ManagedModelError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "ManagedModelError"; }
}
/**
 * Endpoints/credentials must be provisioned by Replit AI Integrations.
 * The explicit model allowlist records models verified by the deployment admin;
 * an API key's existence alone is not proof a documented model is available.
 */
export function getManagedModels(): AvailableManagedModel[] {
  return MANAGED_MODELS.map(model => {
    const prefix = prefixes[model.provider];
    let configured = false;
    try { getManagedConnection(model.provider); configured = true; } catch { /* missing or invalid managed setup */ }
    const verified = (process.env[`AI_INTEGRATIONS_${prefix}_MODELS`] || "").split(",").map(s => s.trim()).includes(model.model);
    return { ...model, enabled: configured && verified,
      ...(!configured ? { unavailableReason: `Replit-managed ${model.provider} integration is not connected.` }
        : !verified ? { unavailableReason: "Model availability has not been verified for this deployment." } : {}),
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
  const prefix = prefixes[provider as ManagedProvider];
  if (!prefix) throw new ManagedModelError("Unsupported managed model provider.");
  const baseURL = process.env[`AI_INTEGRATIONS_${prefix}_BASE_URL`];
  const apiKey = process.env[`AI_INTEGRATIONS_${prefix}_API_KEY`];
  if (!baseURL || !apiKey) throw new ManagedModelError(`Replit-managed ${provider} integration is not connected.`, 503);
  let url: URL;
  try { url = new URL(baseURL); } catch { throw new ManagedModelError("Managed integration endpoint configuration is invalid.", 503); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const direct = ["api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com", "openrouter.ai"];
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || direct.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new ManagedModelError("Managed integration endpoint configuration is invalid.", 503);
  }
  return { baseURL, apiKey };
}