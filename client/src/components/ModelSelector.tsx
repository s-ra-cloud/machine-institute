import { useState, useEffect } from "react";
import { Loader2, Check, AlertCircle, Key, Cpu } from "lucide-react";

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
  rateLimitInfo?: { remaining: number; resetAt: number | null; count: number } | null;
  limitLabel?: string;
}

export function ModelSelector({ value, onChange, rateLimitInfo, limitLabel }: Props) {
  const [tab, setTab] = useState<"platform" | "byoc">(value.providerMode);
  const [apiKey, setApiKey] = useState("");
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{ valid: boolean; error?: string } | null>(null);

  const { data: configData } = useGenerationConfig();

  const platformModels = configData?.platformModels || [];
  const byocProviders = configData?.byocProviders || [];

  useEffect(() => {
    if (tab === "platform" && platformModels.length > 0 && !value.modelName) {
      const defaultModel = platformModels.find(m => m.default) || platformModels[0];
      onChange({
        providerMode: "platform",
        provider: defaultModel.provider,
        modelName: defaultModel.model,
      });
    }
  }, [tab, platformModels]);

  const handleTabChange = (newTab: "platform" | "byoc") => {
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
          className={`flex-1 px-4 py-3 text-xs font-mono uppercase tracking-widest transition-colors flex items-center justify-center gap-2 ${
            tab === "platform" ? "bg-primary/10 text-primary border-b-2 border-primary" : "text-muted-foreground/50 hover:text-muted-foreground"
          }`}
          data-testid="tab-platform"
        >
          <Cpu className="w-3.5 h-3.5" />
          Platform Models
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
                    {m.default && <span className="ml-2 text-[10px] font-mono text-primary/60">(default)</span>}
                  </div>
                  {value.modelName === m.model && <Check className="w-4 h-4 text-primary" />}
                </button>
              ))}
            </div>

            {rateLimitInfo && (
              <div className="border border-border/20 bg-muted/5 px-4 py-3" data-testid="rate-limit-info">
                <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground/60">
                  <span>{rateLimitInfo.remaining} {limitLabel || "generations"} remaining (24h)</span>
                  {rateLimitInfo.resetAt && (
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
                onChange={(e) => onChange({ ...value, modelName: e.target.value })}
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
                    onChange({ ...value, apiKey: e.target.value });
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
