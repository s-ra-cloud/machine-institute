/** Public metadata only: managed credentials and endpoint configuration stay on the server. */
export type ManagedProvider = "openai" | "anthropic" | "google";
export type GenerationCostType = "editorial" | "literature-review" | "ethics-report" | "peer-review" | "reproduction" | "judge";
export interface ManagedModel {
  provider: ManagedProvider;
  model: string;
  label: string;
  contextWindow: number;
  maxOutputTokens: number;
  tools: boolean;
  default?: boolean;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  pricingSource: string;
}
export interface AvailableManagedModel extends ManagedModel {
  enabled: boolean;
  unavailableReason?: string;
  maxFullTextPapers?: number;
}
// Standard, uncached text-token rates in USD; not a quote for reasoning, cached
// input, long-context surcharges or future price changes. Review centrally.
export const MANAGED_MODELS: ManagedModel[] = [
  { provider: "openai", model: "gpt-4.1", label: "GPT-4.1", contextWindow: 1047576, maxOutputTokens: 32768, tools: true, inputPricePerMillion: 2, outputPricePerMillion: 8, pricingSource: "https://openai.com/api/pricing/" },
  { provider: "openai", model: "gpt-4.1-nano", label: "GPT-4.1 Nano", contextWindow: 1047576, maxOutputTokens: 32768, tools: true, inputPricePerMillion: .1, outputPricePerMillion: .4, pricingSource: "https://openai.com/api/pricing/" },
  { provider: "openai", model: "gpt-4o-mini", label: "GPT-4o Mini", contextWindow: 128000, maxOutputTokens: 16384, tools: true, inputPricePerMillion: .15, outputPricePerMillion: .6, pricingSource: "https://openai.com/api/pricing/" },
  { provider: "anthropic", model: "claude-opus-4-6", label: "Claude Opus 4.6", contextWindow: 200000, maxOutputTokens: 64000, tools: true, inputPricePerMillion: null, outputPricePerMillion: null, pricingSource: "https://platform.claude.com/docs/en/about-claude/pricing" },
  { provider: "google", model: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", contextWindow: 1048576, maxOutputTokens: 65536, tools: true, inputPricePerMillion: .1, outputPricePerMillion: .4, pricingSource: "https://ai.google.dev/gemini-api/docs/pricing" },
  { provider: "openai", model: "gpt-5-nano", label: "GPT-5 Nano", contextWindow: 400000, maxOutputTokens: 128000, tools: true, inputPricePerMillion: .05, outputPricePerMillion: .4, pricingSource: "https://openai.com/api/pricing/" },
  { provider: "openai", model: "gpt-5-mini", label: "GPT-5 Mini", contextWindow: 400000, maxOutputTokens: 128000, tools: true, default: true, inputPricePerMillion: .25, outputPricePerMillion: 2, pricingSource: "https://openai.com/api/pricing/" },
  { provider: "openai", model: "gpt-4.1-mini", label: "GPT-4.1 Mini", contextWindow: 1047576, maxOutputTokens: 32768, tools: true, inputPricePerMillion: .4, outputPricePerMillion: 1.6, pricingSource: "https://openai.com/api/pricing/" },
  { provider: "openai", model: "gpt-4o", label: "GPT-4o", contextWindow: 128000, maxOutputTokens: 16384, tools: true, inputPricePerMillion: 2.5, outputPricePerMillion: 10, pricingSource: "https://openai.com/api/pricing/" },
  { provider: "openai", model: "gpt-5", label: "GPT-5", contextWindow: 400000, maxOutputTokens: 128000, tools: true, inputPricePerMillion: 1.25, outputPricePerMillion: 10, pricingSource: "https://openai.com/api/pricing/" },
  { provider: "anthropic", model: "claude-haiku-4-5", label: "Claude Haiku 4.5", contextWindow: 200000, maxOutputTokens: 64000, tools: true, inputPricePerMillion: 1, outputPricePerMillion: 5, pricingSource: "https://platform.claude.com/docs/en/about-claude/pricing" },
  { provider: "anthropic", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", contextWindow: 200000, maxOutputTokens: 64000, tools: true, inputPricePerMillion: 3, outputPricePerMillion: 15, pricingSource: "https://platform.claude.com/docs/en/about-claude/pricing" },
  { provider: "anthropic", model: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", contextWindow: 200000, maxOutputTokens: 64000, tools: true, inputPricePerMillion: 3, outputPricePerMillion: 15, pricingSource: "https://platform.claude.com/docs/en/about-claude/pricing" },
  { provider: "google", model: "gemini-2.5-flash", label: "Gemini 2.5 Flash", contextWindow: 1048576, maxOutputTokens: 65536, tools: true, inputPricePerMillion: .3, outputPricePerMillion: 2.5, pricingSource: "https://ai.google.dev/gemini-api/docs/pricing" },
  { provider: "google", model: "gemini-2.5-pro", label: "Gemini 2.5 Pro", contextWindow: 1048576, maxOutputTokens: 65536, tools: true, inputPricePerMillion: 1.25, outputPricePerMillion: 10, pricingSource: "https://ai.google.dev/gemini-api/docs/pricing" },
];
export interface TaskCostOptions {
  batchCount?: number;
  includeEthics?: boolean;
  fullTextCount?: number;
  judgeModelName?: string;
  multiplier?: number;
}
export interface TaskCostEstimate {
  credits: number;
  usd: number;
  minCredits: number;
  maxCredits: number;
  minUsd: number;
  maxUsd: number;
  assumptions: string;
}
const profiles: Record<GenerationCostType, [number, number]> = {
  editorial: [6000, 3000], "literature-review": [15000, 6000],
  "ethics-report": [15000, 5000], "peer-review": [15000, 5000],
  reproduction: [900000, 60000], judge: [25000, 6000],
};
/** Application display credits (one = $0.01), NOT Replit credits or a billing ledger. */
export function estimateTaskCost(modelName: string, type: GenerationCostType, options: TaskCostOptions = {}): TaskCostEstimate | null {
  const model = MANAGED_MODELS.find(m => m.model === modelName);
  if (!model || !profiles[type] || model.inputPricePerMillion === null || model.outputPricePerMillion === null) return null;
  const positive = (v: number | undefined, fallback: number) => v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback;
  const price = (m: ManagedModel, input: number, output: number) => {
    // Pro's documented long-context tier starts above 200k input per request.
    // Aggregated reproduction tokens are many requests, not one long prompt.
    const longContext = m.model === "gemini-2.5-pro" && type === "literature-review" && input > 200000;
    return (input * (m.inputPricePerMillion ?? 0) * (longContext ? 2 : 1)
      + output * (m.outputPricePerMillion ?? 0) * (longContext ? 1.5 : 1)) / 1e6;
  };
  let [input, output] = profiles[type];
  if (type === "literature-review") input += 8000 * positive(options.fullTextCount, 1);
  let usd = price(model, input, output);
  if (type === "peer-review" && options.includeEthics) usd += price(model, ...profiles["ethics-report"]);
  let minUsd = usd * .5, maxUsd = usd * 2;
  if (type === "reproduction") {
    const judge = MANAGED_MODELS.find(m => m.model === (options.judgeModelName || modelName));
    if (!judge || judge.inputPricePerMillion === null || judge.outputPricePerMillion === null) return null;
    const judgeUsd = price(judge, ...profiles.judge);
    minUsd = price(model, 300000, 20000) + judgeUsd;
    maxUsd = price(model, 3000000, 200000) + judgeUsd * 2;
    usd += judgeUsd;
  }
  const scale = positive(options.batchCount, 1) * positive(options.multiplier, 1);
  usd *= scale; minUsd *= scale; maxUsd *= scale;
  const credits = (dollars: number) => Math.ceil(dollars * 10000) / 100;
  return {
    usd, minUsd, maxUsd, credits: credits(usd), minCredits: credits(minUsd), maxCredits: credits(maxUsd),
    assumptions: type === "reproduction"
      ? "Illustrative 10–100 model rounds plus judge; not a spending cap. Modal GPU costs excluded. Reasoning tokens, retries and actual context may exceed this range."
      : "Typical uncached text usage; not a spending cap. Actual input, output, reasoning, retries and long-context pricing can change the charge.",
  };
}