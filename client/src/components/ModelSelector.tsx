import { useState, useEffect } from "react";
import { Loader2, Check, AlertCircle, Key, Cpu, Lock } from "lucide-react";

export interface ModelConfig {
  providerMode: "platform" | "byoc";
  provider: string;
  modelName: string;
  apiKey?: string;
  keyValidated?: boolean;
}

interface PlatformModel {
  provider: string;
  model: string;
  label: string;
  credits?: number;
  default?: boolean;
}

interface BYOCProvider {
  id: string;
  label: string;
  defaultModel: string;
}

interface GenerationConfig {
  platformModels: PlatformModel[];
  byocProviders: BYOCProvider[];
  defaultModel: { provider: string; model: string };
}

interface Props {
  value: ModelConfig;
  onChange: (config: ModelConfig) => void;
  rateLimitInfo?: { remaining: number | null; resetAt: number | null; count?: number } | null;
  limitLabel?: string;
  hasPlatformAccess?: boolean;
  activeType?: GenerationCostType;
  costMultiplier?: number;
}

export type GenerationCostType = "editorial" | "literature-review" | "ethics-report" | "peer-review" | "reproduction";

// Per-generation credit cost estimates (1 credit ≈ $0.01 USD).
// Derived from observed token usage on this stack:
//   - Editorial:        ~6k input + ~3k output tokens (1 LLM call, op-ed length)
//   - Literature Rev.:  ~15k input + ~6k output tokens (corpus + synthesis)
//   - Ethics Report:    ~15k input + ~5k output tokens (full paper + verifier blocks)
//   - Peer Review:      ~15k input + ~5k output tokens (3 chunks, similar profile)
//   - Reproduction:     agentic loop, up to 100 tool rounds × ~30k input tokens
//                       + judge pass (LLM only — GPU sandbox time is billed separately)
// Combined with OpenRouter pass-through pricing per 1M tokens
// (DeepSeek Chat $0.27/$1.10, Claude Sonnet 4 $3/$15, GPT-4o $2.50/$10,
//  GPT-5 $1.25/$10, Claude Opus 4 $15/$75).
const MODEL_AGENT_CREDITS: Record<string, Partial<Record<GenerationCostType, number>>> = {
  "deepseek/deepseek-chat":      { editorial: 1,  "literature-review": 1,  "ethics-report": 1,  "peer-review": 1,  reproduction: 15  },
  "anthropic/claude-sonnet-4":   { editorial: 6,  "literature-review": 14, "ethics-report": 12, "peer-review": 12, reproduction: 150 },
  "anthropic/claude-sonnet-5":   { editorial: 9,  "literature-review": 20, "ethics-report": 17, "peer-review": 17, reproduction: 210 },
  "openai/gpt-4o":               { editorial: 5,  "literature-review": 10, "ethics-report": 9,  "peer-review": 9,  reproduction: 110 },
  "openai/gpt-5":                { editorial: 4,  "literature-review": 8,  "ethics-report": 7,  "peer-review": 7,  reproduction: 90  },
  "openai/gpt-5.6-luna":         { editorial: 5,  "literature-review": 10, "ethics-report": 9,  "peer-review": 9,  reproduction: 110 },
  "anthropic/claude-opus-4":     { editorial: 32, "literature-review": 68, "ethics-report": 60, "peer-review": 60, reproduction: 700 },
};

function formatCostBadge(modelKey: string, activeType?: Props["activeType"], multiplier: number = 1): string | null {
  if (!activeType) return null;
  const map = MODEL_AGENT_CREDITS[modelKey];
  if (!map) return null;
  const base = map[activeType];
  if (!base) return null;
  const cost = Math.max(1, Math.round(base * multiplier));
  return `~${cost} credit${cost === 1 ? "" : "s"} / run`;
}

// Per-run credit estimate for a given model + generation type, used by the
// batch runner to show a total (per-run × count) next to the run button.
// Returns null for models/types with no known weight (e.g. BYOC-typed models).
export function estimatePerRunCredits(
  modelKey: string,
  activeType: NonNullable<Props["activeType"]>,
  multiplier: number = 1,
): number | null {
  const base = MODEL_AGENT_CREDITS[modelKey]?.[activeType];
  if (!base) return null;
  return Math.max(1, Math.round(base * multiplier));
}

export function ModelSelector({ value, onChange, rateLimitInfo, limitLabel, hasPlatformAccess = true, activeType, costMultiplier = 1 }: Props) {
  const [tab, setTab] = useState<"platform" | "byoc">(
    hasPlatformAccess ? value.providerMode : "byoc"
  );
  const [apiKey, setApiKey] = useState("");
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{ valid: boolean; error?: string } | null>(null);

  const { data: configData } = useGenerationConfig();

  const platformModels = configData?.platformModels || [];
  const byocProviders = configData?.byocProviders || [];

  useEffect(() => {
    if (!hasPlatformAccess && value.providerMode === "platform") {
      const defaultProvider = byocProviders[0];
      onChange({
        providerMode: "byoc",
        provider: defaultProvider?.id || "openai",
        modelName: defaultProvider?.defaultModel || "gpt-4o",
        apiKey: "",
        keyValidated: false,
      });
      setTab("byoc");
    }
  }, [hasPlatformAccess, byocProviders.length]);

  useEffect(() => {
    if (tab === "platform" && hasPlatformAccess && platformModels.length > 0 && !value.modelName) {
      const defaultModel = platformModels.find(m => m.default) || platformModels[0];
      onChange({
        providerMode: "platform",
        provider: defaultModel.provider,
        modelName: defaultModel.model,
      });
    }
  }, [tab, platformModels]);

  const handleTabChange = (newTab: "platform" | "byoc") => {
    if (newTab === "platform" && !hasPlatformAccess) return;
    setTab(newTab);
    if (newTab === "platform") {
      const defaultModel = platformModels.find(m => m.default) || platformModels[0];
      onChange({
        providerMode: "platform",
        provider: defaultModel?.provider || "openrouter",
        modelName: defaultModel?.model || "deepseek/deepseek-chat",
      });
    } else {
      const defaultProvider = byocProviders[0];
      onChange({
        providerMode: "byoc",
        provider: defaultProvider?.id || "openai",
        modelName: defaultProvider?.defaultModel || "gpt-4o",
        apiKey: "",
        keyValidated: false,
      });
    }
    setApiKey("");
    setValidationResult(null);
  };

  const handleValidateKey = async () => {
    if (!apiKey.trim()) return;
    setValidating(true);
    setValidationResult(null);
    try {
      const res = await fetch("/api/generation/validate-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: value.provider, apiKey }),
      });
      const result = await res.json();
      setValidationResult(result);
      if (result.valid) {
        onChange({ ...value, apiKey, keyValidated: true });
      }
    } catch {
      setValidationResult({ valid: false, error: "Network error during validation" });
    } finally {
      setValidating(false);
    }
  };

  return (
    <div className="border border-border/50 bg-muted/5" data-testid="model-selector">
      <div className="flex border-b border-border/30">
        <button
          onClick={() => handleTabChange("platform")}
          disabled={!hasPlatformAccess}
          className={`flex-1 px-4 py-3 text-xs font-mono uppercase tracking-widest transition-colors flex items-center justify-center gap-2 ${
            !hasPlatformAccess
              ? "text-muted-foreground/25 cursor-not-allowed"
              : tab === "platform"
              ? "bg-primary/10 text-primary border-b-2 border-primary"
              : "text-muted-foreground/50 hover:text-muted-foreground"
          }`}
          data-testid="tab-platform"
        >
          {hasPlatformAccess ? <Cpu className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
          Platform Models
          {!hasPlatformAccess && (
            <span className="ml-1 text-[9px] font-mono bg-muted/30 px-1.5 py-0.5 rounded-sm text-muted-foreground/40 normal-case tracking-normal">
              Restricted
            </span>
          )}
        </button>
        <button
          onClick={() => handleTabChange("byoc")}
          className={`flex-1 px-4 py-3 text-xs font-mono uppercase tracking-widest transition-colors flex items-center justify-center gap-2 ${
            tab === "byoc" ? "bg-primary/10 text-primary border-b-2 border-primary" : "text-muted-foreground/50 hover:text-muted-foreground"
          }`}
          data-testid="tab-byoc"
        >
          <Key className="w-3.5 h-3.5" />
          Bring Your Own Key
        </button>
      </div>

      {!hasPlatformAccess && tab === "byoc" && (
        <div className="px-5 pt-4 pb-0">
          <div className="flex items-start gap-2 text-[10px] font-mono text-muted-foreground/50 border border-border/20 bg-muted/5 px-3 py-2.5" data-testid="platform-locked-notice">
            <Lock className="w-3 h-3 mt-0.5 shrink-0 text-muted-foreground/30" />
            <span>Platform models are restricted to institute members. Bring your own API key to generate content.</span>
          </div>
        </div>
      )}

      <div className="p-5 space-y-4">
        {tab === "platform" ? (
          <>
            <div className="space-y-2">
              {platformModels.map((m) => (
                <button
                  key={m.model}
                  onClick={() => onChange({ providerMode: "platform", provider: m.provider, modelName: m.model })}
                  className={`w-full px-4 py-3 border text-left transition-all flex items-center justify-between ${
                    value.modelName === m.model
                      ? "border-primary bg-primary/5"
                      : "border-border/30 hover:border-border/60"
                  }`}
                  data-testid={`button-model-${m.model}`}
                >
                  <div>
                    <span className="text-sm font-mono">{m.label}</span>
                    {(() => {
                      const badge = formatCostBadge(m.model, activeType, costMultiplier);
                      return badge ? (
                        <span className="ml-2 text-[10px] font-mono text-muted-foreground/60" data-testid={`cost-${m.model}`}>
                          {badge}
                        </span>
                      ) : null;
                    })()}
                    {m.default && <span className="ml-2 text-[10px] font-mono text-primary/60">(default)</span>}
                  </div>
                  {value.modelName === m.model && <Check className="w-4 h-4 text-primary" />}
                </button>
              ))}
            </div>

            {rateLimitInfo && (
              <div className="border border-border/20 bg-muted/5 px-4 py-3" data-testid="rate-limit-info">
                <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground/60">
                  <span>{rateLimitInfo.remaining === null ? "Unlimited" : rateLimitInfo.remaining} {limitLabel || "generations"} remaining (24h)</span>
                  {rateLimitInfo.remaining !== null && rateLimitInfo.resetAt && (
                    <span>Resets {new Date(rateLimitInfo.resetAt).toLocaleTimeString()}</span>
                  )}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div>
              <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2 block">
                Provider
              </label>
              <select
                value={value.provider}
                onChange={(e) => {
                  const provider = byocProviders.find(p => p.id === e.target.value);
                  onChange({
                    providerMode: "byoc",
                    provider: e.target.value,
                    modelName: provider?.defaultModel || "",
                    apiKey: "",
                    keyValidated: false,
                  });
                  setApiKey("");
                  setValidationResult(null);
                }}
                className="w-full bg-background border border-border/50 px-3 py-2.5 text-sm font-mono focus:outline-none focus:border-primary/50"
                data-testid="select-provider"
              >
                {byocProviders.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2 block">
                Model Name
              </label>
              <input
                type="text"
                value={value.modelName}
                onChange={(e) => {
                  onChange({ ...value, modelName: e.target.value, keyValidated: false });
                  setValidationResult(null);
                }}
                className="w-full bg-background border border-border/50 px-3 py-2.5 text-sm font-mono focus:outline-none focus:border-primary/50"
                placeholder="e.g. gpt-4o, claude-sonnet-4-20250514"
                data-testid="input-model-name"
              />
            </div>

            <div>
              <label className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-2 block">
                API Key
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setValidationResult(null);
                    onChange({ ...value, apiKey: e.target.value, keyValidated: false });
                  }}
                  className="flex-1 bg-background border border-border/50 px-3 py-2.5 text-sm font-mono focus:outline-none focus:border-primary/50"
                  placeholder="sk-..."
                  data-testid="input-api-key"
                />
                <button
                  onClick={handleValidateKey}
                  disabled={!apiKey.trim() || validating}
                  className="px-4 py-2.5 bg-muted/20 border border-border/50 text-xs font-mono hover:bg-muted/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  data-testid="button-validate-key"
                >
                  {validating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Validate"}
                </button>
              </div>
              {validationResult && (
                <div className={`flex items-center gap-1.5 mt-2 text-[10px] font-mono ${validationResult.valid ? "text-green-400" : "text-red-400"}`} data-testid="validation-result">
                  {validationResult.valid ? <Check className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                  {validationResult.valid ? "API key is valid" : (validationResult.error || "Invalid API key")}
                </div>
              )}
            </div>

            <p className="text-[10px] font-mono text-muted-foreground/40">
              BYOC keys are session-only and never stored permanently.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function useGenerationConfig() {
  const [data, setData] = useState<GenerationConfig | null>(null);
  useEffect(() => {
    fetch("/api/generation/config")
      .then(r => r.json())
      .then(setData)
      .catch(() => {});
  }, []);
  return { data };
}
