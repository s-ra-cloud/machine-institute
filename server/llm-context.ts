import type { ModelProviderConfig } from "./model-service";

// Routed endpoints may expose a smaller serving window than the advertised
// model. Keep this separate from literature-review/model capability metadata.
export const CONSERVATIVE_CONTEXT_LIMIT = 32_768;
export const CONTEXT_SAFETY_TOKENS = 1_024;
export const MAX_CONTEXT_RETRIES = 2;

export class ContextBudgetError extends Error {
  readonly code = "REQUEST_CONTEXT_BUDGET";
  constructor(message: string) {
    super(message);
    this.name = "ContextBudgetError";
  }
}

function errorText(error: unknown, depth = 0): string {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object" || depth > 4) return "";
  const object = error as Record<string, unknown>;
  return ["message", "code", "type", "error", "body", "data", "metadata", "raw", "cause"]
    .map(key => errorText(object[key], depth + 1)).filter(Boolean).join(" ");
}

export function isContextOverflow(error: unknown): boolean {
  if (error instanceof ContextBudgetError) return false;
  return /context_length_exceeded|prompt_too_long|(?:prompt|input|context|request)[\s\S]{0,100}(?:too long|too large|exceed)|maximum context length|max_num_tokens|too many (?:input )?tokens/i.test(errorText(error));
}

export function reportedContextLimit(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    const value = Number((error as Record<string, unknown>).limit);
    if (Number.isSafeInteger(value) && value >= 1_024 && value <= 10_000_000) return value;
  }
  const text = errorText(error);
  const patterns = [
    /max_num_tokens\s*(?:[=:]\s*)?\(?([\d,]+)/i,
    /maximum context length (?:is|of)\s*([\d,]+)/i,
    /(?:context|token|input)\s+(?:window|limit)\s*(?:is|of|:|=)?\s*([\d,]+)/i,
    /(?:exceed|maximum allowed tokens[: ]+)\s*\(?([\d,]+)\s*tokens/i,
    /prompt is too long[\s\S]{0,80}>\s*([\d,]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const limit = Number(match?.[1]?.replace(/,/g, ""));
    if (Number.isSafeInteger(limit) && limit >= 1_024 && limit <= 10_000_000) return limit;
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
  constructor(
    readonly config: ModelProviderConfig,
    readonly maxOutputTokens: number,
    readonly stage: string,
    advertisedWindow = CONSERVATIVE_CONTEXT_LIMIT,
  ) {
    const knownDirect = config.providerMode === "byoc" && (
      (config.provider === "openai" && /^(?:openai\/)?gpt-(?:4o|5)(?:-|$)/.test(config.modelName))
      || (config.provider === "anthropic" && /^claude-(?:sonnet|opus|haiku)-/.test(config.modelName))
    );
    this.limit = Math.min(advertisedWindow, knownDirect ? advertisedWindow : CONSERVATIVE_CONTEXT_LIMIT);
    this.inputLimit = this.limit - maxOutputTokens - CONTEXT_SAFETY_TOKENS;
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

  /** Callers bound attempts and enforce deadlines. Always lower the input target,
   * even if a provider rejects a request below our estimated/advertised limit.
   */
  reduce(error: unknown, request: unknown): boolean {
    if (!isContextOverflow(error)) return false;
    const reported = reportedContextLimit(error);
    if (reported) this.limit = Math.min(this.limit, reported);
    this.inputLimit = Math.min(
      this.limit - this.maxOutputTokens - CONTEXT_SAFETY_TOKENS,
      Math.floor(this.inputLimit * 0.75),
      Math.floor(this.estimate(request) * 0.75),
    );
    return true;
  }
}