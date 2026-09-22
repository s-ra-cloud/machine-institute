import type { ModelProviderConfig } from "./model-service";

// Routed endpoints may expose a smaller serving window than the advertised
// model. Keep this separate from literature-review/model capability metadata.
export const CONSERVATIVE_CONTEXT_LIMIT = 32_768;
export const CONTEXT_SAFETY_TOKENS = 1_024;
export const MAX_CONTEXT_RETRIES = 2;

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