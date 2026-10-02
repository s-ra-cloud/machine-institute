import React, { useEffect, useState } from "react";
import { ModelSelector, type ModelConfig } from "./ModelSelector";

export function judgeNeedsSeparateKey(reproducer: ModelConfig, judge: ModelConfig): boolean {
  return judge.providerMode === "byok"
    && (reproducer.providerMode !== "byok" || reproducer.provider !== judge.provider);
}

/** Linking is derived, never copied into the independently editable selection. */
export function useReproductionJudge(reproducer: ModelConfig, reproducerKey: string) {
  const [linked, setLinked] = useState(true);
  const [independent, setIndependent] = useState<ModelConfig>({
    providerMode: "platform", provider: "", modelName: "",
  });
  const [independentKey, setIndependentKey] = useState("");
  useEffect(() => { setIndependentKey(""); }, [reproducer.provider, reproducer.providerMode]);
  const config = linked ? reproducer : independent;
  const needsSeparateKey = judgeNeedsSeparateKey(reproducer, config);
  return {
    linked, config, needsSeparateKey,
    apiKey: needsSeparateKey ? independentKey : reproducerKey,
    setApiKey: setIndependentKey,
    setConfig: (next: ModelConfig) => {
      if (next.provider !== independent.provider || next.providerMode !== independent.providerMode) setIndependentKey("");
      setIndependent(next);
    },
    setLinked: (next: boolean) => {
      // A hidden judge credential must not survive relinking/unlinking.
      setIndependentKey("");
      setLinked(next);
    },
    clearKey: () => setIndependentKey(""),
  };
}

export function reproductionModelPayload(
  reproducer: ModelConfig, judge: ModelConfig, reproducerKey: string, judgeKey: string,
) {
  return {
    providerMode: reproducer.providerMode,
    modelProvider: reproducer.provider,
    modelName: reproducer.modelName,
    judgeProviderMode: judge.providerMode,
    judgeModelProvider: judge.provider,
    judgeModelName: judge.modelName,
    ...(reproducer.providerMode === "byok" && reproducerKey ? { byocApiKey: reproducerKey } : {}),
    ...(judgeNeedsSeparateKey(reproducer, judge) && judgeKey ? { judgeByocApiKey: judgeKey } : {}),
  };
}

/** Redact transport failures as well as server-returned errors. */
export async function postReproduction(url: string, payload: Record<string, unknown>) {
  try {
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(String(body?.error || "Could not start reproduction"));
    return body;
  } catch (error) {
    let message = error instanceof Error ? error.message : "Could not start reproduction";
    for (const key of [payload.byocApiKey, payload.judgeByocApiKey]) {
      if (typeof key === "string" && key) message = message.replaceAll(key, "[redacted]");
    }
    throw new Error(message);
  }
}

type Props = Omit<Parameters<typeof ModelSelector>[0], "value" | "onChange" | "apiKey" | "onApiKeyChange"> & {
  selection: ReturnType<typeof useReproductionJudge>;
};

export function ReproductionJudgeSelector({ selection, ...props }: Props) {
  const { config, linked } = selection;
  return <div className="space-y-3">
    <button type="button" aria-pressed={linked} onClick={() => selection.setLinked(!linked)}
      className={`border px-3 py-2 text-xs font-mono ${linked ? "border-primary text-primary bg-primary/5" : "border-border text-muted-foreground"}`}
      data-testid="button-link-judge">
      Use reproducer model for judge
    </button>
    {linked ? <div className="border border-border/50 bg-muted/5 p-3 text-xs font-mono" role="status" data-testid="linked-judge-summary">
      Judge: {config.modelName || "Select a reproducer model"}{config.modelName && ` · ${config.provider} · ${config.providerMode === "byok" ? "BYOK" : "Replit-managed"}`}
      <p className="mt-2 text-[10px] text-muted-foreground">The judge uses the same model in a separate grading role with its own prompt.{config.providerMode === "byok" && " Both stages use the reproducer’s temporary key."}</p>
    </div> : <ModelSelector {...props} value={config} onChange={selection.setConfig}
      apiKey={selection.apiKey} onApiKeyChange={selection.setApiKey} hideApiKey={!selection.needsSeparateKey} />}
  </div>;
}