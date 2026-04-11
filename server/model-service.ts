import OpenAI from "openai";

export interface ModelProviderConfig {
  providerMode: "platform" | "byoc";
  provider: string;
  modelName: string;
  apiKey?: string;
}

export const PLATFORM_MODELS = [
  { provider: "openrouter", model: "deepseek/deepseek-chat", label: "DeepSeek Chat (via OpenRouter)", default: true },
  { provider: "openrouter", model: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4 (via OpenRouter)" },
  { provider: "openrouter", model: "openai/gpt-4o", label: "GPT-4o (via OpenRouter)" },
];

export const BYOC_PROVIDERS = [
  { id: "openai", label: "OpenAI", baseURL: "https://api.openai.com/v1", defaultModel: "gpt-4o" },
  { id: "anthropic", label: "Anthropic (via OpenRouter)", baseURL: "https://openrouter.ai/api/v1", defaultModel: "anthropic/claude-sonnet-4", note: "Anthropic models routed through OpenRouter for OpenAI-compatible API" },
  { id: "openrouter", label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", defaultModel: "deepseek/deepseek-chat" },
];

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://openrouter.ai/api/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

export function createLLMClient(config: ModelProviderConfig): OpenAI {
  if (config.providerMode === "platform") {
    const platformKey = process.env.OPENROUTER_API_KEY;
    if (!platformKey) {
      throw new Error("Platform model generation is not configured. OPENROUTER_API_KEY is missing.");
    }
    return new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: platformKey,
    });
  }

  if (!config.apiKey) {
    throw new Error("BYOC mode requires an API key.");
  }

  const baseURL = PROVIDER_BASE_URLS[config.provider] || PROVIDER_BASE_URLS.openrouter;
  return new OpenAI({
    baseURL,
    apiKey: config.apiKey,
  });
}

export function resolveModelName(config: ModelProviderConfig): string {
  if (config.modelName) return config.modelName;

  if (config.providerMode === "platform") {
    const defaultPlatform = PLATFORM_MODELS.find(m => m.default);
    return defaultPlatform?.model || "deepseek/deepseek-chat";
  }

  const byocProvider = BYOC_PROVIDERS.find(p => p.id === config.provider);
  return byocProvider?.defaultModel || "deepseek/deepseek-chat";
}

export async function validateApiKey(provider: string, apiKey: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const baseURL = PROVIDER_BASE_URLS[provider];
    if (!baseURL) {
      return { valid: false, error: `Unknown provider: ${provider}` };
    }

    const client = new OpenAI({ baseURL, apiKey });
    await client.models.list();
    return { valid: true };
  } catch (err: any) {
    if (err.status === 401 || err.status === 403) {
      return { valid: false, error: "Invalid API key. Please check your credentials." };
    }
    if (err.status === 404 || err.status === 405) {
      return { valid: true };
    }
    return { valid: false, error: "Could not validate API key. Please check your credentials and try again." };
  }
}

export const PER_USER_PLATFORM_LIMITS: Record<string, { max: number; windowMs: number }> = {
  editorial: { max: 5, windowMs: 24 * 60 * 60 * 1000 },
  "literature-review": { max: 10, windowMs: 24 * 60 * 60 * 1000 },
};
