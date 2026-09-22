import type { ModelProviderConfig } from "./model-service";

// Routed endpoints may expose a smaller serving window than the advertised
// model. Keep this separate from literature-review/model capability metadata.
export const CONSERVATIVE_CONTEXT_LIMIT = 32_768;
export const CONTEXT_SAFETY_TOKENS = 1_024;
export const MAX_CONTEXT_RETRIES = 2;
export const MAX_PROVIDER_PAYMENT_RETRIES = 2;
export const MAX_PROVIDER_RETRY_DELAY_MS = 30_000;

export type ProviderLimitSource =
  | "openrouter_in_flight_budget"
  | "openrouter_key_limit"
  | "openrouter_credits";
export type ProviderPaymentReason =
  | "in_flight_budget_exhausted"
  | "weight_exceeds_budget";

export interface ProviderPaymentMetadata {
  limitSource?: ProviderLimitSource;
  reason?: ProviderPaymentReason;
}

export interface ProviderContextConstraint {
  /** A total context window includes both input and requested completion. */
  kind: "total" | "input";
  limit: number;
  requestedInputTokens?: number;
  requestedOutputTokens?: number;
  requestedTotalTokens?: number;
}

export class ContextBudgetError extends Error {
  readonly code = "REQUEST_CONTEXT_BUDGET";
  constructor(message: string) {
    super(message);
    this.name = "ContextBudgetError";
  }
}

export class ProviderPaymentError extends Error {
  readonly code = "PROVIDER_PAYMENT_REQUIRED";
  readonly status?: number;
  readonly providerCode: "payment_required" | "provider_credit";
  readonly limitSource?: ProviderLimitSource;
  readonly paymentReason?: ProviderPaymentReason;
  readonly retryAfterMs?: number;
  constructor(
    status?: number,
    reason: "payment_required" | "provider_credit" = "payment_required",
    metadata: ProviderPaymentMetadata = {},
    providerMode?: "platform" | "byoc",
    retryAfterMs?: number,
  ) {
    const transient = metadata.limitSource === "openrouter_in_flight_budget"
      && metadata.reason === "in_flight_budget_exhausted";
    const delayed = retryAfterMs !== undefined && retryAfterMs > MAX_PROVIDER_RETRY_DELAY_MS;
    super(providerMode === "platform"
      ? transient
        ? delayed
          ? "The application OpenRouter account is temporarily at its in-flight spending limit. OpenRouter requested a longer retry delay; retry later."
          : "The application OpenRouter account is temporarily at its in-flight spending limit. Retry shortly."
        : "The application OpenRouter account cannot cover this request. An administrator must check OpenRouter credits or API key spending caps, then retry."
      : transient
        ? delayed
          ? "The model provider account is temporarily at its in-flight spending limit. The provider requested a longer retry delay; retry later."
          : "The model provider account is temporarily at its in-flight spending limit. Retry shortly."
        : `${providerMode === "byoc" ? "Your model provider account" : "The model provider account"} could not authorize this paid request${status === 402 ? " (HTTP 402)" : ""}. Check the account's credits and key limits, then retry.`);
    this.name = "ProviderPaymentError";
    this.status = status;
    this.providerCode = reason;
    this.limitSource = metadata.limitSource;
    this.paymentReason = metadata.reason;
    this.retryAfterMs = retryAfterMs;
  }
}

function errorText(error: unknown, depth = 0): string {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object" || depth > 4) return "";
  const object = error as Record<string, unknown>;
  return ["message", "code", "type", "error", "body", "data", "metadata", "raw", "cause"]
    .map(key => errorText(object[key], depth + 1)).filter(Boolean).join(" ");
}

function explicitHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as Record<string, unknown>;
  const candidate = Number(value.status ?? value.statusCode);
  return Number.isSafeInteger(candidate) && candidate >= 100 && candidate <= 599
    ? candidate : undefined;
}

function nestedPaymentCode(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  const value = error as Record<string, unknown>;
  if (Number(value.code) === 402) return true;
  return ["error", "body", "data", "metadata", "cause"].some(key =>
    nestedPaymentCode(value[key], depth + 1));
}

/**
 * Provider payment detection deliberately precedes context-message matching.
 * An explicit non-402 HTTP status remains authoritative; only status-less
 * payloads may use a nested numeric code or unambiguous credit wording.
 */
export function providerPaymentReason(error: unknown): "payment_required" | "provider_credit" | undefined {
  if (error instanceof ProviderPaymentError) return error.providerCode;
  const status = explicitHttpStatus(error);
  if (status === 402) return "payment_required";
  if (status !== undefined) return undefined;
  if (nestedPaymentCode(error)) return "payment_required";
  return /\b(?:insufficient|not enough|more)\s+(?:provider\s+)?credits?\b|\bcan only afford\b|\brequires? more credits?\b/i.test(errorText(error))
    ? "provider_credit" : undefined;
}

export function isProviderPaymentError(error: unknown): error is ProviderPaymentError {
  return error instanceof ProviderPaymentError;
}

export function isProviderPaymentFailure(error: unknown): boolean {
  return providerPaymentReason(error) !== undefined;
}

const LIMIT_SOURCES = new Set<ProviderLimitSource>([
  "openrouter_in_flight_budget", "openrouter_key_limit", "openrouter_credits",
]);
const PAYMENT_REASONS = new Set<ProviderPaymentReason>([
  "in_flight_budget_exhausted", "weight_exceeds_budget",
]);

/** Extract only documented enum values; provider remedy text is never retained. */
export function providerPaymentMetadata(error: unknown, depth = 0): ProviderPaymentMetadata {
  if (error instanceof ProviderPaymentError) {
    return { limitSource: error.limitSource, reason: error.paymentReason };
  }
  if (!error || typeof error !== "object" || depth > 4) return {};
  const value = error as Record<string, unknown>;
  const metadata = value.metadata && typeof value.metadata === "object"
    ? value.metadata as Record<string, unknown> : undefined;
  const rawSource = String(metadata?.limit_source ?? value.limit_source ?? "");
  const rawReason = String(metadata?.reason ?? value.reason ?? "");
  const own: ProviderPaymentMetadata = {
    limitSource: LIMIT_SOURCES.has(rawSource as ProviderLimitSource)
      ? rawSource as ProviderLimitSource : undefined,
    reason: PAYMENT_REASONS.has(rawReason as ProviderPaymentReason)
      ? rawReason as ProviderPaymentReason : undefined,
  };
  if (own.limitSource || own.reason) return own;
  for (const key of ["error", "body", "data", "cause"]) {
    const nested = providerPaymentMetadata(value[key], depth + 1);
    if (nested.limitSource || nested.reason) return nested;
  }
  return {};
}

export function isTransientProviderPaymentFailure(error: unknown): boolean {
  if (!isProviderPaymentFailure(error)) return false;
  const metadata = providerPaymentMetadata(error);
  return metadata.limitSource === "openrouter_in_flight_budget"
    && metadata.reason === "in_flight_budget_exhausted";
}

/** Numeric Retry-After seconds only; HTTP dates and arbitrary provider text are ignored. */
export function providerRetryAfterMs(error: unknown, depth = 0): number {
  if (!error || typeof error !== "object" || depth > 4) return 0;
  const value = error as Record<string, any>;
  const headerValue = typeof value.headers?.get === "function"
    ? value.headers.get("retry-after")
    : value.headers?.["retry-after"] ?? value.headers?.["Retry-After"];
  const raw = value.retryAfter ?? value.retry_after ?? headerValue;
  if ((typeof raw === "number" || (typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw.trim())))) {
    const milliseconds = Math.ceil(Number(raw) * 1000);
    if (Number.isFinite(milliseconds) && milliseconds >= 0) {
      return milliseconds;
    }
  }
  for (const key of ["error", "body", "data", "cause"]) {
    const nested = providerRetryAfterMs(value[key], depth + 1);
    if (nested) return nested;
  }
  return 0;
}

export function isContextOverflow(error: unknown): boolean {
  if (error instanceof ContextBudgetError) return false;
  if (isProviderPaymentFailure(error)) return false;
  return /context_length_exceeded|prompt_too_long|(?:prompt|input|context|request)[\s\S]{0,100}(?:too long|too large|exceed)|maximum context length|max_num_tokens|too many (?:input )?tokens/i.test(errorText(error));
}

export function reportedContextLimit(error: unknown): number | undefined {
  return providerContextConstraint(error)?.limit;
}

const validTokenCount = (value: unknown): number | undefined => {
  const number = typeof value === "string"
    ? Number(value.replace(/,/g, ""))
    : Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= 10_000_000
    ? number : undefined;
};

/**
 * Parse only numeric context facts. In particular, callers must not retain the
 * provider body used to derive them. A max_num_tokens attached to prompt/query
 * length is an input cap; a "maximum context length" is a total window.
 */
export function providerContextConstraint(error: unknown): ProviderContextConstraint | undefined {
  if (isProviderPaymentFailure(error)) return undefined;
  const root = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const structuredLimit = validTokenCount(root?.limit);
  const structuredKind = root?.contextLimitKind;
  if (structuredLimit && structuredLimit >= 1_024
    && (structuredKind === "total" || structuredKind === "input")) {
    return {
      kind: structuredKind,
      limit: structuredLimit,
      requestedInputTokens: validTokenCount(root?.requestedInputTokens),
      requestedOutputTokens: validTokenCount(root?.requestedOutputTokens),
      requestedTotalTokens: validTokenCount(root?.requestedTotalTokens),
    };
  }
  const text = errorText(error);
  const deepInfra = text.match(
    /(?:sum of )?prompt length\s*\(?([\d,]+)(?:\.0+)?\)?(?:[\s\S]{0,80}?query length\s*\(?([\d,]+)(?:\.0+)?\)?)?[\s\S]{0,120}?max_num_tokens\s*\(?([\d,]+)\)?/i,
  );
  if (deepInfra) {
    const prompt = validTokenCount(deepInfra[1]);
    const query = validTokenCount(deepInfra[2]) ?? 0;
    const limit = validTokenCount(deepInfra[3]);
    if (limit && limit >= 1_024 && prompt !== undefined) {
      return { kind: "input", limit, requestedInputTokens: prompt + query };
    }
  }
  const openAi = text.match(
    /maximum context length (?:is|of)\s*([\d,]+)\s*tokens[\s\S]{0,180}?requested\s*([\d,]+)\s*tokens(?:\s*\(([\d,]+)\s*(?:in )?(?:the )?(?:messages|prompt|input)[\s,]+([\d,]+)\s*(?:in )?(?:the )?(?:completion|output))/i,
  );
  if (openAi) {
    const limit = validTokenCount(openAi[1]);
    if (limit && limit >= 1_024) {
      return {
        kind: "total", limit,
        requestedTotalTokens: validTokenCount(openAi[2]),
        requestedInputTokens: validTokenCount(openAi[3]),
        requestedOutputTokens: validTokenCount(openAi[4]),
      };
    }
  }
  const inputPatterns = [
    /(?:prompt|input) (?:is )?too long[\s\S]{0,100}?(?:>|limit(?: is| of)?|maximum(?: is| of)?)\s*([\d,]+)/i,
    /(?:prompt|input)\s+(?:token\s+)?limit\s*(?:is|of|:|=)?\s*([\d,]+)/i,
  ];
  for (const pattern of inputPatterns) {
    const limit = validTokenCount(text.match(pattern)?.[1]);
    if (limit && limit >= 1_024) return { kind: "input", limit };
  }
  const totalPatterns = [
    /maximum context length (?:is|of)\s*([\d,]+)/i,
    /context (?:window|limit)\s*(?:is|of|:|=)?\s*([\d,]+)/i,
  ];
  for (const pattern of totalPatterns) {
    const limit = validTokenCount(text.match(pattern)?.[1]);
    if (limit && limit >= 1_024) return { kind: "total", limit };
  }
  // A legacy sanitized error may only carry `limit`. It remains useful as a
  // conservative total-window hint, but raw max_tokens fields are ambiguous
  // (they often mean requested output) and are deliberately ignored.
  if (structuredLimit && structuredLimit >= 1_024) {
    return { kind: "total", limit: structuredLimit };
  }
  return undefined;
}

/** Size the complete payload, not just message.content. Without the upstream
 * tokenizer a UTF-8 byte per token is deliberately conservative for byte-fallback
 * tokenizers. JSON escaping, per-message/tool overhead and a separate safety
 * reserve cover formatting; a routed server can still impose a lower cap.
 */
export function estimateRequestTokens(request: unknown): number {
  const value = request as { messages?: unknown[]; tools?: unknown[] };
  return Buffer.byteLength(JSON.stringify(request) ?? "", "utf8")
    + 256 + (value?.messages?.length ?? 0) * 24 + (value?.tools?.length ?? 0) * 64;
}

export class RequestContextBudget {
  limit: number;
  inputLimit: number;
  readonly protectedInputFloor: number;
  private unknownReductions = 0;
  private lastRejectedTarget?: number;
  constructor(
    readonly config: ModelProviderConfig,
    readonly maxOutputTokens: number,
    readonly stage: string,
    advertisedWindow = CONSERVATIVE_CONTEXT_LIMIT,
    protectedInputFloor = 0,
  ) {
    const knownDirect = config.providerMode === "byoc" && (
      (config.provider === "openai" && /^(?:openai\/)?gpt-(?:4o|5)(?:-|$)/.test(config.modelName))
      || (config.provider === "anthropic" && /^claude-(?:sonnet|opus|haiku)-/.test(config.modelName))
    );
    this.limit = Math.min(advertisedWindow, knownDirect ? advertisedWindow : CONSERVATIVE_CONTEXT_LIMIT);
    this.inputLimit = this.limit - maxOutputTokens - CONTEXT_SAFETY_TOKENS;
    this.protectedInputFloor = Math.max(0, Math.floor(protectedInputFloor));
  }

  estimate(request: unknown): number {
    return estimateRequestTokens(request);
  }

  fits(request: unknown): boolean {
    return this.estimate(request) <= this.inputLimit;
  }

  diagnostic(request: unknown): string {
    return `${this.stage}: model=${this.config.modelName || "(default)"}, estimated_input=${this.estimate(request)}, input_limit=${this.inputLimit}, output_reserved=${this.maxOutputTokens}, context_limit=${this.limit}, safety=${CONTEXT_SAFETY_TOKENS}`;
  }

  assertFits(request: unknown): void {
    if (!this.fits(request)) {
      throw new ContextBudgetError(`Request is too large after context compaction (${this.diagnostic(request)}). Shorten custom instructions or split the input; completed experiments must not be rerun just to recover output.`);
    }
  }

  /** Return true only when a retry will be sent with a strictly tighter target. */
  reduce(error: unknown, request: unknown): boolean {
    if (!isContextOverflow(error)) return false;
    const estimate = this.estimate(request);
    const constraint = providerContextConstraint(error);
    let target: number;
    if (constraint) {
      this.limit = Math.min(this.limit, constraint.limit);
      const allowedInput = constraint.kind === "total"
        ? constraint.limit - this.maxOutputTokens - CONTEXT_SAFETY_TOKENS
        : constraint.limit - CONTEXT_SAFETY_TOKENS;
      const reportedInput = constraint.requestedInputTokens
        ?? (constraint.requestedTotalTokens !== undefined
          ? constraint.requestedTotalTokens - (constraint.requestedOutputTokens ?? this.maxOutputTokens)
          : undefined);
      // Translate provider-tokenizer counts into our estimator's scale. This
      // avoids repeatedly applying an arbitrary percentage to the same floor.
      target = reportedInput && reportedInput > 0
        ? Math.floor(estimate * allowedInput / reportedInput)
        : Math.min(allowedInput, Math.floor(estimate * 0.85));
    } else {
      if (this.unknownReductions >= 1) return false;
      this.unknownReductions++;
      target = Math.floor(estimate * 0.85);
    }
    target = Math.min(this.inputLimit, target);
    if (target < this.protectedInputFloor) return false;
    if (target >= estimate || target >= this.inputLimit || target === this.lastRejectedTarget) return false;
    this.lastRejectedTarget = target;
    this.inputLimit = target;
    return true;
  }
}