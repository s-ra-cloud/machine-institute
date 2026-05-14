import OpenAI from "openai";

export interface ModelProviderConfig {
  providerMode: "platform" | "byoc";
  provider: string;
  modelName: string;
  apiKey?: string;
}

export interface GenerationResult {
  content: string;
  model: string;
  provider: string;
}

export const PLATFORM_MODELS = [
  { provider: "openrouter", model: "deepseek/deepseek-chat", label: "DeepSeek Chat (via OpenRouter)", credits: 1, default: true },
  { provider: "openrouter", model: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4 (via OpenRouter)", credits: 5 },
  { provider: "openrouter", model: "openai/gpt-4o", label: "GPT-4o (via OpenRouter)", credits: 5 },
  { provider: "openrouter", model: "openai/gpt-5", label: "GPT-5 (via OpenRouter)", credits: 10 },
  { provider: "openrouter", model: "anthropic/claude-opus-4", label: "Claude Opus 4 (via OpenRouter)", credits: 15 },
];

export const BYOC_PROVIDERS = [
  { id: "openai", label: "OpenAI", baseURL: "https://api.openai.com/v1", defaultModel: "gpt-4o" },
  { id: "anthropic", label: "Anthropic", baseURL: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-20250514" },
  { id: "openrouter", label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", defaultModel: "deepseek/deepseek-chat" },
];

const OPENAI_COMPAT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

export function createLLMClient(config: ModelProviderConfig): OpenAI | null {
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

  if (config.provider === "anthropic") {
    return null;
  }

  const baseURL = OPENAI_COMPAT_BASE_URLS[config.provider] || OPENAI_COMPAT_BASE_URLS.openrouter;
  return new OpenAI({
    baseURL,
    apiKey: config.apiKey,
  });
}

export async function generateWithConfig(
  config: ModelProviderConfig,
  systemPrompt: string,
  userMessage: string,
  options: { maxTokens?: number; temperature?: number } = {},
): Promise<GenerationResult> {
  const model = resolveModelName(config);
  const maxTokens = options.maxTokens || 12000;
  const temperature = options.temperature || 0.3;

  if (config.provider === "anthropic" && config.providerMode === "byoc") {
    if (!config.apiKey) {
      throw new Error("BYOC Anthropic mode requires an API key.");
    }
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
    }

    const result: AnthropicMessagesResponse = await response.json() as AnthropicMessagesResponse;
    const textBlock = result.content?.find((block) => block.type === "text");
    const content = textBlock?.text || "";

    return { content, model, provider: "anthropic" };
  }

  const client = createLLMClient(config);
  if (!client) {
    throw new Error(`Could not create LLM client for provider: ${config.provider}`);
  }

  let completion: any;
  try {
    completion = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_tokens: maxTokens,
        temperature,
      },
      { timeout: 600_000 },
    );
  } catch (err: any) {
    const status = err?.status ?? err?.statusCode ?? "unknown";
    const body = err?.error ?? err?.message ?? String(err);
    console.error(`[LLM] API request failed — model=${model} provider=${config.provider} status=${status}:`, JSON.stringify(body));
    throw new Error(`LLM request failed (${status}): ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }

  if (completion?.error) {
    console.error(`[LLM] API returned error body — model=${model} provider=${config.provider}:`, JSON.stringify(completion.error));
    throw new Error(`LLM API error: ${completion.error.message || JSON.stringify(completion.error)}`);
  }

  const content = completion.choices?.[0]?.message?.content || "";
  if (!content) {
    console.error(`[LLM] Empty content returned — model=${model} choices:`, JSON.stringify(completion.choices));
    throw new Error(`LLM returned empty response (choices: ${JSON.stringify(completion.choices)})`);
  }
  return { content, model, provider: config.provider };
}

interface AnthropicMessagesResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{ type: string; text: string }>;
  model: string;
  stop_reason: string | null;
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
    if (provider === "anthropic") {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1,
          messages: [{ role: "user", content: "test" }],
        }),
      });

      if (response.status === 401 || response.status === 403) {
        return { valid: false, error: "Invalid Anthropic API key. Please check your credentials." };
      }
      return { valid: true };
    }

    const baseURL = OPENAI_COMPAT_BASE_URLS[provider];
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
  "ethics-report": { max: 5, windowMs: 24 * 60 * 60 * 1000 },
  "peer-review": { max: 5, windowMs: 24 * 60 * 60 * 1000 },
};
