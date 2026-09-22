import type { ModelProviderConfig } from "./model-service";
import { ProviderPaymentError } from "./llm-context";

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const PREFLIGHT_TIMEOUT_MS = 5_000;

export type ProviderCreditPreflightOutcome =
  | "bypassed"
  | "available"
  | "free-model"
  | "unknown";

export class ProviderCreditPreflightError extends ProviderPaymentError {
  readonly preflightKind = "credits_exhausted";

  constructor(providerMode: ModelProviderConfig["providerMode"], status?: number) {
    super(status, "provider_credit", { limitSource: "openrouter_key_limit" }, providerMode);
    this.name = "ProviderCreditPreflightError";
    const owner = providerMode === "byoc"
      ? "your OpenRouter API key"
      : "the OpenRouter key configured for this deployment";
    this.message = `OpenRouter reports that ${owner} has reached its key spending limit for this paid model. Raise or reset the key's OpenRouter spending cap before retrying. OpenRouter key limits are separate from a Replit subscription.`;
  }
}

export class ProviderCredentialPreflightError extends Error {
  readonly code = "PROVIDER_CREDENTIAL_INVALID";
  readonly preflightKind = "invalid_credentials";
  readonly status?: number;

  constructor(providerMode: ModelProviderConfig["providerMode"], status?: number) {
    const owner = providerMode === "byoc"
      ? "your OpenRouter API key"
      : "the OpenRouter key configured for this deployment";
    super(`OpenRouter rejected ${owner}. Check or replace the OpenRouter API key, then retry. OpenRouter credentials and key limits are separate from a Replit subscription.`);
    this.name = "ProviderCredentialPreflightError";
    this.status = status;
  }
}

function warnUnknown(onWarning: ((message: string) => void) | undefined, detail: string): "unknown" {
  try {
    onWarning?.(`OpenRouter key-limit preflight could not confirm key status (${detail}); proceeding without a funding guarantee.`);
  } catch {
    // Observability callbacks must never turn an unknown provider status into a hard failure.
  }
  return "unknown";
}

/**
 * Checks an OpenRouter generation key without making a generation request.
 * Unknown balances and transient failures deliberately do not claim that funds
 * are available and do not prevent runtime entry.
 */
export async function assertReproductionProviderCredit(
  config: ModelProviderConfig,
  onWarning?: (message: string) => void,
): Promise<ProviderCreditPreflightOutcome> {
  // Platform generation is always routed through OpenRouter, regardless of
  // the upstream model vendor recorded in config.provider.
  if (config.providerMode === "byoc" && config.provider !== "openrouter") return "bypassed";

  const apiKey = config.providerMode === "byoc"
    ? config.apiKey
    : process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new ProviderCredentialPreflightError(config.providerMode);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(OPENROUTER_KEY_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
  } catch {
    return warnUnknown(onWarning, "network error or timeout");
    if (response.status === 402) {
      throw new ProviderCreditPreflightError(config.providerMode, 402);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ProviderCredentialPreflightError(config.providerMode, response.status);
    }
    if (!response.ok) {
      return warnUnknown(onWarning, `HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return warnUnknown(onWarning, "malformed response");
    }
    const remaining = (body as any)?.data?.limit_remaining;
    if (remaining === null) return warnUnknown(onWarning, "key spending cap is unlimited; wallet balance is unknown");
    if (typeof remaining !== "number" || !Number.isFinite(remaining)) {
      return warnUnknown(onWarning, "missing or invalid remaining key-limit value");
    }
    if (remaining <= 0) {
      // OpenRouter free models can remain usable at a zero key spending cap.
      // Explicit provider denials (402/401/403) above are never bypassed.
      if (config.modelName?.endsWith(":free")) return "free-model";
      throw new ProviderCreditPreflightError(config.providerMode);
    }
    return "available";
  } finally {
    clearTimeout(timeout);
  }
}

/** Checks each distinct runtime configuration once before material or GPU work. */
export async function assertReproductionRuntimeProviderCredits(
  configs: readonly ModelProviderConfig[],
  onWarning?: (message: string) => void,
): Promise<void> {
  const checked: ModelProviderConfig[] = [];
  for (const config of configs) {
    if (checked.some(previous =>
      previous.providerMode === config.providerMode
      && previous.provider === config.provider
      && previous.modelName === config.modelName
      && previous.apiKey === config.apiKey)) continue;
    checked.push(config);
    await assertReproductionProviderCredit(config, onWarning);
  }
}