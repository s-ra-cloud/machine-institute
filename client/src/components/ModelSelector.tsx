import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, Cpu, Loader2, Lock } from "lucide-react";
import {
  estimateTaskCost,
  type AvailableManagedModel,
  type GenerationCostType as SharedGenerationCostType,
  type TaskCostEstimate,
  type TaskCostOptions,
} from "@shared/model-catalog";

export interface ModelConfig {
  providerMode: "platform";
  provider: string;
  modelName: string;
}

export type GenerationCostType = SharedGenerationCostType;
export type ManagedModel = AvailableManagedModel;
export type ModelCostEstimate = TaskCostEstimate;

export interface GenerationConfig {
  platformModels: ManagedModel[];
  defaultModel?: { provider: string; model: string } | null;
  managedModelsConfigured?: boolean;
  setupRequired?: boolean;
  setupMessage?: string;
  reproduction?: {
    gpuOptions: string[];
    defaultGpu: string;
    sandboxConfigured: boolean;
    hfTokenConfigured: boolean;
  };
}

interface Props {
  value: ModelConfig;
  onChange: (config: ModelConfig) => void;
  hasPlatformAccess?: boolean;
  activeType?: GenerationCostType;
  costMultiplier?: number;
  quantity?: number;
  costOptions?: TaskCostOptions;
  label?: string;
  models?: ManagedModel[];
  configLoading?: boolean;
  configError?: boolean;
  setupMessage?: string;
  compact?: boolean;
  requireExplicitSelection?: boolean;
}

const taskSupported = (model: ManagedModel, type?: GenerationCostType): boolean =>
  type !== "reproduction" || model.tools;

/** Automatic defaults are only for a genuinely empty form. A saved or current
 * selection that later becomes unavailable must remain visible for explicit
 * replacement rather than silently changing the model used by the request. */
export function chooseInitialManagedModel(
  models: ManagedModel[],
  currentModelName: string,
  type?: GenerationCostType,
): ManagedModel | null {
  if (currentModelName) return null;
  return models.find(model => model.enabled !== false && taskSupported(model, type) && model.default)
    ?? models.find(model => model.enabled !== false && taskSupported(model, type))
    ?? null;
}

export function getModelEstimate(
  model: ManagedModel | undefined,
  type: GenerationCostType | undefined,
  multiplier = 1,
  quantity = 1,
  options: TaskCostOptions = {},
): ModelCostEstimate | null {
  if (!model || !type) return null;
  return estimateTaskCost(model.model, type, {
    ...options,
    multiplier,
    batchCount: quantity,
  });
}

function money(value: number): string {
  return value < 0.01 ? "<$0.01" : `$${value.toFixed(value < 1 ? 2 : 2)}`;
}

export function formatModelEstimate(estimate: ModelCostEstimate | null): string | null {
  if (!estimate) return null;
  const credits = `~${estimate.minCredits.toFixed(2)}–${estimate.maxCredits.toFixed(2)} app credits`;
  const usd = `est. ${money(estimate.minUsd)}–${money(estimate.maxUsd)} Replit usage`;
  return [credits, usd].filter(Boolean).join(" · ") || null;
}

export function useGenerationConfig(enabled = true) {
  const [data, setData] = useState<GenerationConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    fetch("/api/generation/config", { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Could not load managed model configuration");
        return response.json();
      })
      .then(value => {
        setData(value);
        setError(false);
      })
      .catch(err => {
        if (err?.name !== "AbortError") setError(true);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [enabled]);

  return { data, loading, error };
}

export function ModelSelector({
  value,
  onChange,
  hasPlatformAccess = true,
  activeType,
  costMultiplier = 1,
  quantity = 1,
  costOptions = {},
  label = "Replit managed model",
  models,
  configLoading,
  configError,
  setupMessage,
  compact = false,
  requireExplicitSelection = false,
}: Props) {
  const ownConfig = useGenerationConfig(models === undefined);
  const availableModels = models ?? ownConfig.data?.platformModels ?? [];
  const loading = configLoading ?? (models ? false : ownConfig.loading);
  const error = configError ?? (models ? false : ownConfig.error);
  const compatible = useMemo(
    () => availableModels,
    [availableModels],
  );
  const selected = compatible.find(model => model.model === value.modelName);
  const configured = ownConfig.data?.managedModelsConfigured !== false
    && ownConfig.data?.setupRequired !== true;
  const selectedReady = Boolean(
    hasPlatformAccess && configured && selected && selected.enabled !== false && taskSupported(selected, activeType),
  );
  const selectionProblem = value.modelName && (
    !selected || selected.enabled === false || !taskSupported(selected, activeType)
  );

  useEffect(() => {
    if (requireExplicitSelection || !hasPlatformAccess || loading || compatible.length === 0) return;
    const next = chooseInitialManagedModel(compatible, value.modelName, activeType);
    if (next) {
      onChange({
        providerMode: "platform",
        provider: next.provider,
        modelName: next.model,
      });
    }
  }, [activeType, compatible, hasPlatformAccess, loading, onChange, requireExplicitSelection, value.modelName]);

  const selectModel = (model: ManagedModel) => {
    if (!hasPlatformAccess || model.enabled === false) return;
    onChange({
      providerMode: "platform",
      provider: model.provider,
      modelName: model.model,
    });
  };

  return (
    <div
      className="border border-border/50 bg-muted/5"
      data-testid="model-selector"
      data-model-ready={selectedReady ? "true" : "false"}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/30 px-4 py-3">
        <div className="flex items-center gap-2">
          {hasPlatformAccess ? <Cpu className="w-3.5 h-3.5 text-primary" /> : <Lock className="w-3.5 h-3.5" />}
          <span className="text-xs font-mono uppercase tracking-widest">{label}</span>
        </div>
        <span className="text-[9px] font-mono text-muted-foreground/50">Managed by Replit</span>
      </div>

      <div className={compact ? "p-3" : "p-5"}>
        {!hasPlatformAccess ? (
          <div className="flex items-start gap-2 text-[10px] font-mono text-muted-foreground/60 border border-border/20 bg-muted/5 px-3 py-2.5" data-testid="platform-locked-notice">
            <Lock className="w-3 h-3 mt-0.5 shrink-0" />
            <span>Managed model generation is restricted to institute members.</span>
          </div>
        ) : loading ? (
          <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground" data-testid="models-loading">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading managed models…
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 text-xs font-mono text-red-300" role="alert" data-testid="models-error">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            Managed model configuration could not be loaded. Refresh to retry.
          </div>
        ) : compatible.length === 0 ? (
          <div className="flex items-start gap-2 text-xs font-mono text-amber-200" role="status" data-testid="models-setup-required">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            {value.modelName
              ? `The selected model “${value.modelName}” is no longer available. It has not been changed automatically; generation remains disabled until an enabled replacement can be selected.`
              : setupMessage ?? ownConfig.data?.setupMessage ?? "No Replit-managed models are configured for this task yet. Generation is disabled until an administrator connects one."}
          </div>
        ) : (
          <>
            {selectionProblem && (
              <div className="mb-3 flex items-start gap-2 border border-amber-400/30 bg-amber-400/5 px-3 py-2.5 text-[10px] font-mono text-amber-200" role="alert" data-testid="model-selection-unavailable">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  The selected model “{value.modelName}” is no longer available for this task. It has not been changed automatically; choose an enabled replacement before continuing.
                </span>
              </div>
            )}
            <div className="space-y-2" role="radiogroup" aria-label={label}>
              {compatible.map(model => {
                const estimate = getModelEstimate(model, activeType, costMultiplier, quantity, costOptions);
                const estimateText = formatModelEstimate(estimate);
                const supportsTask = taskSupported(model, activeType);
                const disabled = model.enabled === false || !configured || !supportsTask;
                const checked = value.modelName === model.model;
                return (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-disabled={disabled}
                    key={`${model.provider}:${model.model}`}
                    onClick={() => selectModel(model)}
                    disabled={disabled}
                    className={`w-full px-4 py-3 border text-left transition-all flex items-center justify-between gap-3 ${
                      checked ? "border-primary bg-primary/5" : "border-border/30 hover:border-border/60"
                    } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                    data-testid={`button-model-${model.model}`}
                  >
                    <span className="min-w-0">
                      <span className="text-sm font-mono block">{model.label}</span>
                      <span className="text-[10px] font-mono text-muted-foreground/60 block mt-1">
                        {disabled
                          ? !supportsTask
                            ? "This model does not support the tools required for this task"
                            : model.unavailableReason ?? ownConfig.data?.setupMessage ?? "Managed provider is not connected"
                          : estimateText ?? "Pricing estimate unavailable"}
                      </span>
                    </span>
                    {checked && !disabled && <Check className="w-4 h-4 text-primary shrink-0" />}
                  </button>
                );
              })}
            </div>
            <p className="mt-3 text-[10px] font-mono text-muted-foreground/50">
              Estimates are approximate, based on task token assumptions and public provider rates. One app credit represents about $0.01 in this display and is not a Replit credit; Replit bills actual model usage separately.
              {activeType === "reproduction" ? " Modal GPU sandbox usage is additional and is not included." : ""}
            </p>
            {selected && getModelEstimate(selected, activeType, costMultiplier, quantity, costOptions)?.assumptions && (
              <p className="mt-1 text-[10px] font-mono text-muted-foreground/40" data-testid="model-cost-assumptions">
                {getModelEstimate(selected, activeType, costMultiplier, quantity, costOptions)?.assumptions}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}