import type { ModelProviderConfig } from "./model-service";

// Server-verified metadata stays out of caller-supplied config fields.
const verified = new WeakMap<ModelProviderConfig, { model: string; window: number }>();
const cache = new Map<string, { expires: number; value: Promise<number> }>();
export function verifiedProviderContext(config: ModelProviderConfig): number | undefined {
  const entry = verified.get(config);
  return config.providerMode === "byoc" && config.provider === "openrouter"
    && entry?.model === config.modelName ? entry.window : undefined;
}

export async function prepareProviderContext(
  config: ModelProviderConfig,
  notify: (message: string) => void | Promise<void>,
): Promise<void> {
  if (config.providerMode !== "byoc" || config.provider !== "openrouter") return;
  const model = config.modelName;
  let entry = cache.get(model);
  if (!entry || entry.expires <= Date.now()) {
    if (cache.size >= 128) cache.clear();
    const value = (async () => {
      const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error("Catalogue unavailable");
      const body = await response.json();
      const item = Array.isArray(body?.data) ? body.data.find((m: any) => m.id === model) : undefined;
      const limits = [item?.context_length, item?.top_provider?.context_length];
      if (!limits.every(n => Number.isSafeInteger(n) && n > 1024)) throw new Error("Context metadata unavailable");
      return Math.min(...limits);
    })();
    entry = { expires: Date.now() + 300_000, value };
    cache.set(model, entry);
  }
  let window: number;
  try {
    window = await entry.value;
  } catch {
    if (cache.get(model) === entry) cache.delete(model);
    verified.delete(config);
    await notify("OpenRouter context metadata could not be verified; retaining the conservative context limit.");
    return;
  }
  verified.set(config, { model, window });
  await notify(`OpenRouter publishes ${window} context tokens for ${model}; any smaller provider-reported limit will still tighten the request budget.`);
}
