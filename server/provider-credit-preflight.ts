import type { ModelProviderConfig } from "./model-service";
import { resolveManagedSelection } from "./managed-models";
import { ProviderPaymentError } from "./llm-context";

// Retained exports for historical diagnostics/API compatibility only.
export class ProviderCreditPreflightError extends ProviderPaymentError {
  readonly preflightKind = "credits_exhausted";
}
export class ProviderCredentialPreflightError extends Error {
  readonly code = "PROVIDER_CREDENTIAL_INVALID";
  readonly preflightKind = "invalid_credentials";
}
export type ProviderCreditPreflightOutcome = "unknown";

/** Managed setup verification is not a balance API and makes no funding promise. */
export async function assertReproductionProviderCredit(
  config: ModelProviderConfig,
  onWarning?: (message: string) => void,
): Promise<ProviderCreditPreflightOutcome> {
  resolveManagedSelection(config);
  try { onWarning?.("Managed model setup is verified; Replit credit availability is checked when the provider request executes."); } catch { /* observability only */ }
  return "unknown";
}
export async function assertReproductionRuntimeProviderCredits(
  configs: readonly ModelProviderConfig[],
  onWarning?: (message: string) => void,
): Promise<void> {
  for (const config of configs) await assertReproductionProviderCredit(config, onWarning);
}