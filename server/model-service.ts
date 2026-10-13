import { MANAGED_MODELS } from "../shared/model-catalog";
import { completionStructure, type CompletionStructure } from "./completion-structure";
import { isDeepSeekV4, reasoningContinuation } from "./reasoning-continuation";
import { createByocChatClient, createManagedChatClient, type ManagedChatClient } from "./managed-adapter";
import { BYOC_PROVIDERS, isSyntacticallyValidApiKey } from "./managed-models";
import {
  ContextBudgetError,
  MAX_CONTEXT_RETRIES,
  MAX_PROVIDER_PAYMENT_RETRIES,
  MAX_PROVIDER_RETRY_DELAY_MS,
  ProviderPaymentError,
  RequestContextBudget,
  isContextOverflow,
  isProviderPaymentFailure,
  isTransientProviderPaymentFailure,
  providerPaymentMetadata,
  providerPaymentReason,
  providerRetryAfterMs,
  providerContextConstraint,
  reportedContextLimit,
  IncompleteGenerationError,
} from "./llm-context";
import { describeToolContext, fitToolContext, type ToolContextProtection } from "./tool-context";
import { verifiedProviderContext } from "./provider-context";

export interface ModelProviderConfig {
  providerMode: "platform" | "byoc";
  provider: string;
  modelName: string;
  apiKey?: string;
}

export interface GenerationResult {
  content: string;
  model: string;
  provider: string;
}

// `contextWindow` is the model's real total token window; the reading-budget helper
// below uses it to decide how many papers a literature review can read in full.
export const PLATFORM_MODELS = MANAGED_MODELS;

// `defaultContextWindow` is used for bring-your-own-key models where we don't know
// the exact model, so we fall back to a sensible per-provider window.
export { BYOC_PROVIDERS };

// Reading-budget constants for literature-review full-text reading.
// Roughly 8,000 tokens are budgeted per paper read in full. The synthesis call reserves
// ~12,000 output tokens (see generateWithConfig's default maxTokens) and a modest
// prompt/instructions overhead is held back before dividing the rest across papers.
export const READING_BUDGET = {
  tokensPerPaper: 8000,
  reservedOutputTokens: 12000,
  promptOverheadTokens: 4000,
  fallbackContextWindow: 64000,
  // Characters ≈ tokens × 3.5 (matches estimateTokens in the LR pipeline).
  charsPerToken: 3.5,
};

// Resolve the total context window for a given model config.
export function getContextWindow(config: ModelProviderConfig): number {
  const verifiedWindow = verifiedProviderContext(config);
  if (verifiedWindow !== undefined) return verifiedWindow;
  const modelName = resolveModelName(config);
  const platformMatch = PLATFORM_MODELS.find(m => m.model === modelName);
  if (platformMatch?.contextWindow) return platformMatch.contextWindow;
  const byocMatch = BYOC_PROVIDERS.find(p => p.id === config.provider);
  if (byocMatch?.defaultContextWindow) return byocMatch.defaultContextWindow;
  return READING_BUDGET.fallbackContextWindow;
}

export interface ReadingBudget {
  contextWindow: number;
  // Total input tokens available (context window minus reserved output tokens).
  maxInputTokens: number;
  // Max number of papers that can be read in full at ~8k tokens each, after holding
  // back reserved output tokens and prompt overhead.
  maxFullTextPapers: number;
  // Per-paper full-text character cap so one paper can actually use its ~8k-token share.
  fullTextPerPaperChars: number;
}

// Given a model config, compute how many papers can be read in full and the input-token
// budget for trimming the corpus.
export function getReadingBudget(config: ModelProviderConfig): ReadingBudget {
  const contextWindow = getContextWindow(config);
  const maxInputTokens = Math.max(1, contextWindow - READING_BUDGET.reservedOutputTokens);
  const maxFullTextPapers = Math.max(
    1,
    Math.floor((maxInputTokens - READING_BUDGET.promptOverheadTokens) / READING_BUDGET.tokensPerPaper),
  );
  const fullTextPerPaperChars = Math.round(READING_BUDGET.tokensPerPaper * READING_BUDGET.charsPerToken);
  return { contextWindow, maxInputTokens, maxFullTextPapers, fullTextPerPaperChars };
}

export function createLLMClient(config: ModelProviderConfig, options: { maxRetries?: number } = {}): ManagedChatClient {
  return config.providerMode === "byoc"
    ? createByocChatClient(config, options)
    : createManagedChatClient(config, options);
}

export async function generateWithConfig(
  config: ModelProviderConfig,
  systemPrompt: string,
  userMessage: string,
  options: {
    maxTokens?: number;
    temperature?: number;
    /** Opt into context-safe request behavior used by judge/reproduction callers. */
    contextRequest?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<GenerationResult> {
  const model = resolveModelName(config);
  const maxTokens = options.maxTokens || 12000;
  const temperature = options.temperature || 0.3;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const contextRequest = options.contextRequest === true;

  const client = createLLMClient(config, contextRequest ? { maxRetries: 0 } : {});
  if (!client) {
    throw new Error(`Could not create LLM client for provider: ${config.provider}`);
  }

  let completion: any;
  try {
    completion = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_tokens: maxTokens,
        temperature,
      },
      { timeout: timeoutMs, ...(contextRequest ? { maxRetries: 0 } : {}) },
    );
  } catch (err: any) {
    const status = err?.status ?? err?.statusCode ?? "unknown";
    const body = err?.error ?? err?.message ?? String(err);
    throw sanitizeContextRequestError({ ...err, status, message: body }, model, config);
  }

  if (completion?.error) {
    if (contextRequest || isProviderPaymentFailure(completion.error)) {
      throw sanitizeContextRequestError(completion.error, model, config);
    }
    const diagnostic = safeProviderErrorDiagnostic(completion.error);
    console.error(`[LLM] API returned an error — model=${model} provider=${config.provider} status=${diagnostic.providerStatus ?? "unknown"} code=${diagnostic.providerCode ?? "unknown"}`);
    throw new Error(`LLM API error (${diagnostic.providerStatus ?? "unknown"}; code=${diagnostic.providerCode ?? "unknown"})`);
  }

  const choice = completion?.choices?.[0];
  if (choice?.finish_reason !== "stop" || choice?.message?.refusal != null || choice?.message?.tool_calls?.length) {
    const finishReason = String(choice?.finish_reason ?? "unknown");
    throw new IncompleteGenerationError(
      `${config.providerMode === "byoc" ? "BYOK provider" : "Managed model"} did not return a complete, non-refused text answer (model=${model}, finish_reason=${finishReason}${finishReason === "length" ? `, max_tokens=${maxTokens}` : ""}). No result was accepted.`,
      finishReason,
      Number(completion?.usage?.completion_tokens) || undefined,
    );
  }
  const content = choice.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    if (contextRequest) {
      throw new Error(`LLM returned empty response for context request (model=${model})`);
    }
    throw new Error(`LLM returned empty response (model=${model}).`);
  }
  return { content, model, provider: config.provider };
}

export function sanitizeContextRequestError(
  error: any,
  model: string,
  config?: Pick<ModelProviderConfig, "providerMode">,
): Error {
  const status = error?.status ?? error?.statusCode;
  const paymentReason = providerPaymentReason(error);
  if (paymentReason) {
    const numericStatus = Number(status);
    const paymentStatus = Number.isSafeInteger(numericStatus) ? numericStatus
      : paymentReason === "payment_required" ? 402 : undefined;
    const result = new ProviderPaymentError(
      paymentStatus, paymentReason, providerPaymentMetadata(error), config?.providerMode,
      providerRetryAfterMs(error) || undefined,
    );
    Object.assign(result, { statusCode: paymentStatus, model });
    return result;
  }
  const code = error?.code ?? error?.type ?? "context_request_failed";
  const rawMessage = contextRequestErrorText(error);
  const contextLike = isContextOverflow(error);
  const byoc = config?.providerMode === "byoc";
  const message = contextLike
    ? `Context length exceeded (${status ?? "unknown"})`
    : Number(status) === 429 ? `${byoc ? "Your provider" : "Managed model"} rate limit reached. Wait before retrying.`
    : Number(status) === 401 || Number(status) === 403 ? byoc
      ? "Your provider rejected the BYOK credentials or access. Check the selected provider, model, and key."
      : "Managed model access was rejected. An administrator must check the Replit integration configuration."
    : [502, 503, 504].includes(Number(status))
      ? `Model provider temporarily unavailable (${status}). Retry later; this does not establish a credential problem.`
    : byoc
      ? `BYOK provider request failed (${status ?? "unknown"}). Check your provider account and key, then retry.`
      : `LLM request failed (${status ?? "unknown"}). Retry later or ask an administrator to check the managed integration.`;
  const result = new Error(message);
  const constraint = providerContextConstraint(error);
  const reportedLimit = constraint?.limit ?? reportedContextLimit(error);
  Object.assign(result, {
    code: contextLike ? "context_length_exceeded" : code,
    status,
    statusCode: status,
    model,
    // Providers commonly return one of these fields. Keeping the numeric hint
    // lets RequestContextBudget.reduce choose a smaller input cap without
    // retaining or logging the provider's raw response.
    limit: reportedLimit === undefined ? undefined : Number(reportedLimit),
    contextLimitKind: constraint?.kind,
    requestedInputTokens: constraint?.requestedInputTokens,
    requestedOutputTokens: constraint?.requestedOutputTokens,
    requestedTotalTokens: constraint?.requestedTotalTokens,
  });
  return result;
}

function contextRequestErrorText(error: unknown, depth = 0): string {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object" || depth > 3) return "";
  const value = error as Record<string, unknown>;
  return ["message", "code", "type", "error", "body", "data"]
    .map(key => contextRequestErrorText(value[key], depth + 1))
    .filter(Boolean)
    .join(" ");
}

export function resolveModelName(config: ModelProviderConfig): string {
  if (config.modelName) return config.modelName;
  throw new Error("Select a model explicitly.");
}

export async function validateApiKey(provider: string, apiKey: string): Promise<{ valid: boolean; error?: string }> {
  if (!BYOC_PROVIDERS.some(candidate => candidate.id === provider)) {
    return { valid: false, error: "Select a supported BYOK provider." };
  }
  if (!isSyntacticallyValidApiKey(provider, apiKey)) {
    return { valid: false, error: "The key format does not match the selected provider." };
  }
  // Deliberately no provider request: checking syntax cannot spend credits, and
  // the key is never retained or sent back to the caller.
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Tool-using agent loop (OpenAI-compatible function calling)
// ---------------------------------------------------------------------------

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallRecord {
  index: number;
  name: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
  error: boolean;
}

export interface ToolLoopOutcome extends CompletionStructure {
  phase?: string;
  phaseCallCount?: number;
  kind: "completion" | "arguments" | "tool" | "stop" | "provider-error" | "context";
  round: number;
  callCount: number;
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | "unknown";
  argumentParse?: "valid" | "invalid-json" | "invalid-schema" | "truncated";
  toolName?: string;
  validationErrors?: string[];
  responseExcerpt?: string;
  toolExcerpt?: string;
  stopReason?: string;
  providerStatus?: number;
  providerCode?: string;
  providerReason?: "provider-credit" | "payment" | "context" | "rate-limit" | "unknown";
  providerLimitSource?: "openrouter_in_flight_budget" | "openrouter_key_limit" | "openrouter_credits";
  providerPaymentReason?: "in_flight_budget_exhausted" | "weight_exceeds_budget";
  providerRetryAfterMs?: number;
  contextLimit?: number;
  requestedInputTokens?: number;
  requestedOutputTokens?: number;
  requestedTotalTokens?: number;
}

export interface ToolLoopOptions {
  /** Structured-only stages must not spend a final request on a logbook. */
  stopWithoutFinalResponse?: boolean;
  /** Host-owned stage transition; does not supply the model's scientific arguments. */
  getRequiredTool?: () => string | undefined;
  /** Opt-in structured-stage retries; default one, hard ceiling two per tool. */
  maxRequiredToolRecoveries?: 0 | 1 | 2;
  requiredToolRecoveryInstruction?: string;
  /** Restrict the next request to host-authorized tools without adding calls. */
  getAvailableTools?: () => readonly string[];
  /** Stage contract check on the actual fitted request, before dispatch. */
  onRequestPrepared?: (request: Record<string, unknown>) => void;
  /** Application-owned stage completion. No extra model finalization request. */
  isStageComplete?: () => boolean;
  /** Preserve run-wide evidence IDs across short, independent stage loops. */
  toolCallIndexOffset?: number;
  maxToolCalls: number;
  /** Absolute epoch-ms deadline after which the agent is told to wrap up. */
  deadlineMs: number;
  maxTokens?: number;
  temperature?: number;
  maxToolResultChars?: number;
  contextCharBudget?: number;
  /** Prefix tool messages shown to the model with their stable numeric call ID. */
  numberToolResults?: boolean;
  onToolCall?: (record: ToolCallRecord) => Promise<void> | void;
  /** Task-specific guard applied to the model-visible (already truncated) tool result. */
  transformToolResult?: (name: string, result: string, callIndex: number) => string;
  onRound?: (round: number, assistantText: string | null) => Promise<void> | void;
  /**
   * Return a user message when a tool-free response is not yet a valid finish.
   * The loop continues with tools enabled until the recovery limit is reached.
   */
  onPrematureStop?: (
    assistantText: string,
    toolCalls: readonly ToolCallRecord[],
  ) => string | null;
  maxPrematureStopRecoveries?: number;
  /**
   * Return monotonic workflow progress used to distinguish productive
   * continuations from repeated premature stops.
   */
  getRecoveryProgress?: () => number;
  /** Opt-in early stop when a task-specific guard detects repeated nonprogress. */
  getStallReason?: (nextToolName?: string) => string | null;
  /** Replacement text used when older tool output is compacted. */
  elidedToolOutputMessage?: string;
  /** Return an empty result instead of throwing when a forced resource stop's
   * finalization request fails. */
  allowResourceStopFallback?: boolean;
  /** Opt-in protection for routed context caps and context-length retries. */
  contextProtection?: ToolContextProtection;
  /** Estimated size of fixed instructions/schemas/state that compaction cannot remove. */
  protectedInputFloor?: number;
  /** Observability only: failures in this callback never affect execution. */
  onOutcome?: (event: ToolLoopOutcome) => Promise<void> | void;
  /** Actual accepted workflow state to include after parse/schema refusals.
   * Invalid argument text is intentionally not passed to this callback. */
  getArgumentRepair?: (toolName: string, validationErrors: readonly string[]) => string;
}

export interface ToolLoopResult {
  content: string;
  toolCalls: ToolCallRecord[];
  rounds: number;
  stoppedBy: "model" | "tool-budget" | "deadline" | "round-cap" | "no-progress";
  finishReason?: ToolLoopOutcome["finishReason"];
}

const safeFinishReason = (value: unknown): NonNullable<ToolLoopOutcome["finishReason"]> =>
  ["stop", "length", "tool_calls", "content_filter", "function_call"].includes(String(value))
    ? value as NonNullable<ToolLoopOutcome["finishReason"]> : "unknown";

const PROVIDER_CODES = new Set([
  "context_length_exceeded", "prompt_too_long", "invalid_request_error",
  "max_tokens", "max_num_tokens", "request_too_large",
  "payment_required", "provider_credit",
]);

/** Numeric/allowlisted provider facts safe for private diagnostics. */
export function safeProviderErrorDiagnostic(error: unknown): Pick<ToolLoopOutcome,
  "providerStatus" | "providerCode" | "providerReason" | "contextLimit" | "requestedInputTokens"
  | "requestedOutputTokens" | "requestedTotalTokens" | "providerLimitSource"
  | "providerPaymentReason" | "providerRetryAfterMs"> {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const statusValue = Number(value.status ?? value.statusCode);
  const rawCode = String(value.code ?? value.type ?? "");
  const constraint = providerContextConstraint(error);
  const payment = providerPaymentReason(error);
  const context = !payment && isContextOverflow(error);
  const rateLimit = !payment && statusValue === 429;
  const paymentMetadata = providerPaymentMetadata(error);
  const retryAfterMs = providerRetryAfterMs(error);
  const providerStatus = Number.isSafeInteger(statusValue) && statusValue >= 100 && statusValue <= 599
    ? statusValue : payment === "payment_required" ? 402 : undefined;
  return {
    providerStatus,
    providerCode: payment ?? (PROVIDER_CODES.has(rawCode) ? rawCode : "unknown"),
    providerReason: payment === "provider_credit" ? "provider-credit"
      : payment ? "payment" : rateLimit ? "rate-limit" : context ? "context" : "unknown",
    providerLimitSource: paymentMetadata.limitSource,
    providerPaymentReason: paymentMetadata.reason,
    providerRetryAfterMs: retryAfterMs || undefined,
    contextLimit: constraint?.limit,
    requestedInputTokens: constraint?.requestedInputTokens,
    requestedOutputTokens: constraint?.requestedOutputTokens,
    requestedTotalTokens: constraint?.requestedTotalTokens,
  };
}

function parseToolArguments(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw);
  // JSON.parse silently keeps the last duplicate key. Reject that ambiguity,
  // including escaped aliases such as "id" and "\u0069d".
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^{}\[\],:\s]+/g) ?? [];
  let index = 0;
  const visit = (): void => {
    const token = tokens[index++];
    if (token === "{") {
      const keys = new Set<string>();
      while (tokens[index] !== "}") {
        const key = JSON.parse(tokens[index++]);
        if (keys.has(key)) throw new Error("duplicate object key");
        keys.add(key);
        index++; // colon (syntax already checked by JSON.parse)
        visit();
        if (tokens[index] !== ",") break;
        index++;
      }
      index++;
    } else if (token === "[") {
      while (tokens[index] !== "]") {
        visit();
        if (tokens[index] !== ",") break;
        index++;
      }
      index++;
    }
  };
  visit();
  return parsed;
}

/** Strict JSON-schema subset used by our tool definitions; never coerces inputs. */
export function validateToolArguments(value: unknown, schema: Record<string, any>, path = "arguments"): string[] {
  const errors: string[] = [];
  const type = schema.type;
  const valid = type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
    : type === "array" ? Array.isArray(value)
    : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
    : type === "number" ? typeof value === "number" && Number.isFinite(value)
    : type === "string" ? typeof value === "string"
    : type === "boolean" ? typeof value === "boolean"
    : type === "null" ? value === null : true;
  if (!valid) return [`${path} must be ${type}`];
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((branch: Record<string, any>) =>
    validateToolArguments(value, branch, path).length === 0)) {
    const alternatives = schema.anyOf.map((branch: Record<string, any>) =>
      validateToolArguments(value, branch, path).join("; "));
    errors.push(`${path} must satisfy one alternative: ${alternatives.join(" OR ")}`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      errors.push(`${path} must contain at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      errors.push(`${path} must contain at most ${schema.maxLength} characters`);
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
  if (type === "object") {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(object, key)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(object)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) {
        errors.push(...validateToolArguments(child, schema.properties[key], `${path}.${key}`));
      } else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
    }
  }
  if (type === "array" && schema.items) {
    (value as unknown[]).forEach((child, index) =>
      errors.push(...validateToolArguments(child, schema.items, `${path}[${index}]`)));
  }
  return errors;
}

const ELIDED_TOOL_OUTPUT = "[earlier tool output elided to fit the context window — re-run the tool if you need it again]";
const KEEP_RECENT_TOOL_MESSAGES = 8;

function messageChars(m: { content?: unknown }): number {
  const continuation = reasoningContinuation(m);
  return (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length)
    + (Object.keys(continuation).length ? JSON.stringify(continuation).length : 0);
}

// Drop the bodies of the oldest tool results once the transcript outgrows the
// model's context window, keeping the most recent ones intact.
function compactMessages(
  messages: Array<Record<string, unknown>>,
  budgetChars: number,
  elidedToolOutputMessage: string = ELIDED_TOOL_OUTPUT,
): void {
  let total = messages.reduce((n, m) => n + messageChars(m), 0);
  if (total <= budgetChars) return;
  const toolIdx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter(i => i >= 0);
  const candidates = toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_RECENT_TOOL_MESSAGES));
  for (const i of candidates) {
    const m = messages[i];
    if (m.content === elidedToolOutputMessage) continue;
    const numberedPrefix = typeof m.content === "string"
      ? m.content.match(/^\[Tool call #\d+\]\n/)?.[0] || ""
      : "";
    const replacement = `${numberedPrefix}${elidedToolOutputMessage}`;
    total -= messageChars(m) - replacement.length;
    m.content = replacement;
    if (total <= budgetChars) break;
  }
}

function truncateToolResult(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.floor(max * 0.7))}\n\n[... ${s.length - max} chars truncated ...]\n\n${s.slice(-Math.floor(max * 0.3))}`;
}

async function reportContextDiagnostic(
  budget: RequestContextBudget,
  request: unknown,
  model: string,
  protection: ToolContextProtection | undefined,
): Promise<void> {
  const message = `[ToolLoop] context budget stage=tool-loop model=${model}: ${budget.diagnostic(request)}; ${fittedContextSizes(request)}`;
  console.warn(message);
  await protection?.onDiagnostic?.(message);
}

function fittedContextSizes(request: unknown): string {
  const fitted = request as Record<string, any>;
  // fitToolContext appends the current bounded state as the final user message.
  return describeToolContext(fitted, fitted.messages?.at(-1)?.content);
}

function terminalContextError(
  budget: RequestContextBudget,
  request: unknown,
  model: string,
): ContextBudgetError {
  return new ContextBudgetError(
    `Tool-loop context request remained too large (stage=tool-loop model=${model}; ${budget.diagnostic(request)}; ${fittedContextSizes(request)}).`,
  );
}

function activeRequestTimeout(deadlineMs: number, protectedRequest: boolean): number {
  if (!protectedRequest) return 600_000;
  return Math.max(1, Math.min(600_000, deadlineMs - Date.now()));
}

const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RATE_LIMIT_RETRY_DELAY_MS = 1_000;
const MAX_RATE_LIMIT_TOTAL_WAIT_MS = 2_000;

function isRateLimit429(error: unknown): boolean {
  if (!error || typeof error !== "object" || isProviderPaymentFailure(error)) return false;
  const value = error as Record<string, unknown>;
  return Number(value.status ?? value.statusCode) === 429;
}

async function waitForRetryableProviderError(
  error: unknown,
  retries: number,
  waitedMs: number,
  deadlineMs: number,
): Promise<number | null> {
  // Share the existing bounded request retry allowance across rate limits and
  // transient gateway failures. No tools have been dispatched for this request.
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const gatewayFailure = [502, 503, 504].includes(Number(value.status ?? value.statusCode));
  if (retries >= MAX_RATE_LIMIT_RETRIES || isProviderPaymentFailure(error)
    || (!isRateLimit429(error) && !gatewayFailure)) return null;
  const retryAfterMs = providerRetryAfterMs(error);
  const delayMs = retryAfterMs > 0
    ? retryAfterMs
    : Math.min(500, 100 * (2 ** retries));
  if (
    delayMs > MAX_RATE_LIMIT_RETRY_DELAY_MS
    || waitedMs + delayMs > MAX_RATE_LIMIT_TOTAL_WAIT_MS
    || Date.now() + delayMs >= deadlineMs
  ) return null;
  if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  return Date.now() < deadlineMs ? waitedMs + delayMs : null;
}

async function waitForTransientProviderPayment(error: unknown, deadlineMs: number): Promise<boolean> {
  if (!isTransientProviderPaymentFailure(error)) return false;
  const delayMs = providerRetryAfterMs(error);
  if (delayMs > MAX_PROVIDER_RETRY_DELAY_MS) return false;
  if (Date.now() + delayMs >= deadlineMs) return false;
  if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  return Date.now() < deadlineMs;
}

export async function runToolLoop(
  config: ModelProviderConfig,
  systemPrompt: string,
  userMessage: string,
  tools: ToolSpec[],
  execute: (name: string, args: Record<string, unknown>) => Promise<string>,
  options: ToolLoopOptions,
): Promise<ToolLoopResult> {
  const client = createLLMClient(config, { maxRetries: 0 });
  if (!client) throw new Error(`Could not create LLM client for provider: ${config.provider}`);
  const model = resolveModelName(config);
  let maxTokens = options.maxTokens ?? 8000;
  // A response that ends on max_tokens with no text and no tool call carries nothing to continue from
  // (reasoning models can think through the whole budget). The same request is retried with more room,
  // doubling up to this cap, before any prose/required-tool recovery is spent on it.
  const providerOutputCap = PLATFORM_MODELS.find(m => m.model === model)?.maxOutputTokens;
  const maxTokensCap = Math.max(maxTokens, Math.min(32_000, maxTokens * 4, providerOutputCap ?? Number.POSITIVE_INFINITY));
  let outputBudgetRaises = 0;
  const temperature = options.temperature ?? 0.2;
  const maxToolResultChars = options.maxToolResultChars ?? 12_000;
  const contextBudget = options.contextCharBudget ?? Math.floor(getContextWindow(config) * 3.0);
  const elidedToolOutputMessage = options.elidedToolOutputMessage ?? ELIDED_TOOL_OUTPUT;
  const requestBudget = options.contextProtection
    ? new RequestContextBudget(
      config, maxTokens, "tool-loop", getContextWindow(config), options.protectedInputFloor,
    )
    : null;

  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
  const toolDefs = tools.map(t => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const toolCalls: ToolCallRecord[] = [];
  const maxRounds = options.maxToolCalls * 2 + 5;
  let stoppedBy: ToolLoopResult["stoppedBy"] = "model";
  let forceFinal = false;
  let prematureStopRecoveries = 0;
  const missingRequiredToolRecoveries = new Map<string, number>();
  let recoveryProgressHighWater: number | undefined;
  const observe = async (event: ToolLoopOutcome): Promise<void> => {
    try { await options.onOutcome?.(event); } catch { /* Diagnostics cannot break a run. */ }
  };

  for (let round = 1; round <= maxRounds; round++) {
    if (options.isStageComplete?.()) return { content: "", toolCalls, rounds: round - 1, stoppedBy: "model" };
    const budgetExhausted = toolCalls.length >= options.maxToolCalls;
    const pastDeadline = Date.now() >= options.deadlineMs;
    const stallReason = !budgetExhausted && !pastDeadline ? options.getStallReason?.() : null;
    if (!forceFinal && (budgetExhausted || pastDeadline || stallReason)) {
      forceFinal = true;
      stoppedBy = budgetExhausted ? "tool-budget" : pastDeadline ? "deadline" : "no-progress";
      if (options.stopWithoutFinalResponse) {
        await observe({ kind: "stop", round, callCount: toolCalls.length, stopReason: stoppedBy });
        return { content: "", toolCalls, rounds: round - 1, stoppedBy };
      }
      messages.push({
        role: "user",
        content: budgetExhausted
          ? "STOP: your tool-call budget is exhausted. Do not call any more tools. Write your final logbook now, based strictly on the tool outputs you have already seen. Any claim you could not finish testing must be recorded as inconclusive in the logbook."
          : pastDeadline
            ? "STOP: the time budget is exhausted. Do not call any more tools. Write your final logbook now, based strictly on the tool outputs you have already seen. Any claim you could not finish testing must be recorded as inconclusive in the logbook."
            : `STOP: ${stallReason}. No more tools are available. Write an honest final logbook using only accepted claims and actual evidence; do not claim that rereading a source is an experiment.`,
      });
    }
    if (!requestBudget) compactMessages(messages, contextBudget, elidedToolOutputMessage);

    const requestWasForcedFinal = forceFinal;
    const fallbackAfterResourceStop = (): ToolLoopResult | null => {
      if (
        requestWasForcedFinal
          && (stoppedBy === "deadline" || stoppedBy === "tool-budget" || stoppedBy === "no-progress")
      ) {
        return { content: "", toolCalls, rounds: round, stoppedBy };
      }
      if (!requestWasForcedFinal && Date.now() >= options.deadlineMs) {
        stoppedBy = "deadline";
        return { content: "", toolCalls, rounds: round, stoppedBy };
      }
      return null;
    };
    const requiredTool = forceFinal ? undefined : options.getRequiredTool?.();
    const availableNames = options.getAvailableTools?.();
    const availableToolDefs = availableNames
      ? toolDefs.filter(tool => availableNames.includes(tool.function.name)) : toolDefs;
    if (requiredTool && !availableToolDefs.some(tool => tool.function.name === requiredTool))
      throw new Error("Required stage tool is unavailable.");
    const baseRequest: Record<string, unknown> = {
      model,
      messages: messages as any,
      ...(forceFinal ? {} : { tools: (requiredTool && isDeepSeekV4(model)
        ? availableToolDefs.filter(tool => tool.function.name === requiredTool) : availableToolDefs) as any,
        tool_choice: requiredTool && !isDeepSeekV4(model)
        ? { type: "function", function: { name: requiredTool } } : "auto" }),
      max_tokens: maxTokens,
      temperature,
    };
    let completion: any;
    let contextReductions = 0;
    let paymentRetries = 0;
    let rateLimitRetries = 0;
    let rateLimitWaitedMs = 0;
    let exactRateLimitRetryRequest: Record<string, unknown> | undefined;
    while (true) {
      let request: Record<string, unknown>;
      try {
        if (exactRateLimitRetryRequest) {
          request = exactRateLimitRetryRequest;
          exactRateLimitRetryRequest = undefined;
        } else {
          request = requestBudget
            ? fitToolContext(baseRequest, {
              budget: requestBudget,
              protection: options.contextProtection!,
              elidedToolOutputMessage,
              numberToolResults: options.numberToolResults,
            })
            : baseRequest;
        }
      } catch (error) {
        if (error instanceof ContextBudgetError) {
          console.warn(`[ToolLoop] ${error.message}`);
          await options.contextProtection?.onDiagnostic?.(error.message);
          if (options.allowResourceStopFallback) {
            const fallback = fallbackAfterResourceStop();
            if (fallback) return fallback;
          }
        }
        throw error;
      }
      if (requestBudget && !requestWasForcedFinal && Date.now() >= options.deadlineMs) {
        stoppedBy = "deadline";
        return { content: "", toolCalls, rounds: round, stoppedBy };
      }
      options.onRequestPrepared?.(request);
      try {
        completion = await client.chat.completions.create(
          request as any,
          { timeout: activeRequestTimeout(options.deadlineMs, Boolean(requestBudget)), ...(requestBudget ? { maxRetries: 0 } : {}) },
        );
      } catch (err: any) {
        if (
          paymentRetries < MAX_PROVIDER_PAYMENT_RETRIES
          && await waitForTransientProviderPayment(err, options.deadlineMs)
        ) {
          paymentRetries++;
          await observe({ kind: "provider-error", round, callCount: toolCalls.length,
            ...safeProviderErrorDiagnostic(err) });
          continue;
        }
        const rateLimitWait = await waitForRetryableProviderError(
          err, rateLimitRetries, rateLimitWaitedMs, options.deadlineMs,
        );
        if (rateLimitWait !== null) {
          rateLimitWaitedMs = rateLimitWait;
          rateLimitRetries++;
          exactRateLimitRetryRequest = request;
          await observe({ kind: "provider-error", round, callCount: toolCalls.length,
            ...safeProviderErrorDiagnostic(err) });
          continue;
        }
        if (
          requestBudget
          && isContextOverflow(err)
           && contextReductions < MAX_CONTEXT_RETRIES
          && Date.now() < options.deadlineMs
          && requestBudget.reduce(err, request)
        ) {
          contextReductions++;
          await reportContextDiagnostic(requestBudget, request, model, options.contextProtection);
          if (Date.now() >= options.deadlineMs) {
            stoppedBy = "deadline";
            return { content: "", toolCalls, rounds: round, stoppedBy };
          }
          continue;
        }
        if (requestBudget && isContextOverflow(err)) {
          await reportContextDiagnostic(requestBudget, request, model, options.contextProtection);
        }
         await observe({ kind: "provider-error", round, callCount: toolCalls.length,
           stopReason: isRateLimit429(err) ? "rate-limit" : "provider-request-failed",
           ...safeProviderErrorDiagnostic(err) });
        const sanitizedError = sanitizeContextRequestError(err, model, config);
        if (isProviderPaymentFailure(sanitizedError)) throw sanitizedError;
        if (options.allowResourceStopFallback) {
          const fallback = fallbackAfterResourceStop();
          if (fallback) return fallback;
        }
        if (requestBudget && isContextOverflow(err)) {
          throw terminalContextError(requestBudget, request, model);
        }
         throw sanitizedError;
      }
      if (completion?.error) {
        const completionError = completion.error;
        if (
          paymentRetries < MAX_PROVIDER_PAYMENT_RETRIES
          && await waitForTransientProviderPayment(completionError, options.deadlineMs)
        ) {
          paymentRetries++;
          await observe({ kind: "provider-error", round, callCount: toolCalls.length,
            ...safeProviderErrorDiagnostic(completionError) });
          continue;
        }
        const rateLimitWait = await waitForRetryableProviderError(
          completionError, rateLimitRetries, rateLimitWaitedMs, options.deadlineMs,
        );
        if (rateLimitWait !== null) {
          rateLimitWaitedMs = rateLimitWait;
          rateLimitRetries++;
          exactRateLimitRetryRequest = request;
          await observe({ kind: "provider-error", round, callCount: toolCalls.length,
            ...safeProviderErrorDiagnostic(completionError) });
          continue;
        }
        if (
          requestBudget
          && isContextOverflow(completionError)
           && contextReductions < MAX_CONTEXT_RETRIES
          && Date.now() < options.deadlineMs
          && requestBudget.reduce(completionError, request)
        ) {
          contextReductions++;
          await reportContextDiagnostic(requestBudget, request, model, options.contextProtection);
          if (Date.now() >= options.deadlineMs) {
            stoppedBy = "deadline";
            return { content: "", toolCalls, rounds: round, stoppedBy };
          }
          continue;
        }
        if (requestBudget && isContextOverflow(completionError)) {
          await reportContextDiagnostic(requestBudget, request, model, options.contextProtection);
        }
         await observe({ kind: "provider-error", round, callCount: toolCalls.length,
           stopReason: isRateLimit429(completionError) ? "rate-limit" : "provider-error-response",
           ...safeProviderErrorDiagnostic(completionError) });
        const sanitizedError = sanitizeContextRequestError(completionError, model, config);
        if (isProviderPaymentFailure(sanitizedError)) throw sanitizedError;
        if (options.allowResourceStopFallback) {
          const fallback = fallbackAfterResourceStop();
          if (fallback) return fallback;
        }
        if (requestBudget && isContextOverflow(completionError)) {
          throw terminalContextError(requestBudget, request, model);
        }
        throw sanitizedError;
      }
      break;
    }
    const msg = completion?.choices?.[0]?.message;
    const finishReason = safeFinishReason(completion?.choices?.[0]?.finish_reason);
    await observe({
      kind: "completion", round, callCount: toolCalls.length, finishReason,
      ...completionStructure(completion),
      responseExcerpt: typeof msg?.content === "string" ? msg.content.slice(0, 2000) : undefined,
    });
    if (!msg) {
      if (options.allowResourceStopFallback) {
        const fallback = fallbackAfterResourceStop();
        if (fallback) return fallback;
      }
      throw new Error("LLM returned no message.");
    }

    const calls: Array<{ id: string; function: { name: string; arguments: string } }> =
      (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).filter((c: any) => c?.type === "function" && c.function?.name);
    const assistantText: string | null = typeof msg.content === "string" && msg.content.trim() ? msg.content : null;
    if (finishReason === "length" && !assistantText && calls.length === 0 && !forceFinal && maxTokens < maxTokensCap) {
      const raised = Math.min(maxTokensCap, maxTokens * 2);
      const probe = { ...baseRequest, max_tokens: raised };
      if (!requestBudget || requestBudget.raiseOutputReserve(raised, probe)) {
        outputBudgetRaises++;
        await observe({ kind: "context", round, callCount: toolCalls.length, finishReason,
          requestedOutputTokens: raised,
          stopReason: `output budget exhausted without an answer; retrying with max_tokens=${raised} (raise ${outputBudgetRaises})` });
        maxTokens = raised;
        continue;
      }
    }
    messages.push({
      role: "assistant",
      content: assistantText ?? "",
      ...(calls.length ? { tool_calls: calls } : {}),
      ...(msg.providerParts ? { providerParts: msg.providerParts } : {}),
      ...(isDeepSeekV4(model) ? reasoningContinuation(msg) : {}),
    });
    await options.onRound?.(round, assistantText);

    if (calls.length === 0) {
      // A request may have started before the deadline and returned after it.
      // Do not offer another recovery continuation in that case.
      if (!forceFinal && Date.now() >= options.deadlineMs) {
        forceFinal = true;
        stoppedBy = "deadline";
      }
      // A provider can return prose even with an explicit function tool_choice.
      // Give each required transition bounded corrections independently of earlier
      // general reminders. Never renew this allowance on browsing activity.
      if (!forceFinal && requiredTool) {
        const used = missingRequiredToolRecoveries.get(requiredTool) ?? 0;
        const configured = options.maxRequiredToolRecoveries;
        const limit = configured === 0 || configured === 2 ? configured : 1;
        if (used < limit) {
          missingRequiredToolRecoveries.set(requiredTool, used + 1);
          messages.push({ role: "user", content:
            `The required ${requiredTool} tool call was missing (finish_reason=${finishReason}). The stage is still incomplete. Call ${requiredTool} using the existing evidence and its declared schema. Do not invent evidence or repeat completed experiments.${options.requiredToolRecoveryInstruction ? ` ${options.requiredToolRecoveryInstruction}` : ""}` });
          continue;
        }
        stoppedBy = "no-progress";
        await observe({ kind: "stop", round, callCount: toolCalls.length, finishReason, stopReason: stoppedBy });
        return { content: "", toolCalls, rounds: round, stoppedBy, finishReason };
      }
      const incomplete = finishReason === "length" || finishReason === "content_filter" || finishReason === "tool_calls";
      const continuation = !forceFinal
        ? (incomplete
          ? `Your response was incomplete (finish_reason=${finishReason}); it is not an accepted final logbook. Continue from accepted claim state and prior evidence. Do not re-register existing claims or repeat completed experiments.`
          : options.onPrematureStop?.(assistantText ?? "", toolCalls) ?? null)
        : null;
      const maxRecoveries = options.maxPrematureStopRecoveries ?? 0;
      if (continuation) {
        if (options.getRecoveryProgress) {
          const progress = options.getRecoveryProgress();
          if (recoveryProgressHighWater === undefined) {
            // The first premature stop establishes the baseline. Subsequent
            // increases are the only events that reset the consecutive count.
            recoveryProgressHighWater = progress;
          } else if (progress > recoveryProgressHighWater) {
            recoveryProgressHighWater = progress;
            prematureStopRecoveries = 0;
          }
        }
        if (prematureStopRecoveries < maxRecoveries) {
          prematureStopRecoveries++;
          messages.push({ role: "user", content: continuation });
          continue;
        }
        if (options.getRecoveryProgress || incomplete) stoppedBy = "no-progress";
      }
      await observe({ kind: "stop", round, callCount: toolCalls.length, finishReason, stopReason: stoppedBy });
      return { content: incomplete ? "" : assistantText ?? "", toolCalls, rounds: round, stoppedBy, finishReason };
    }

    for (const call of calls) {
      if (options.isStageComplete?.()) return { content: "", toolCalls, rounds: round, stoppedBy: "model" };
      if (!forceFinal && options.getStallReason?.(call.function.name)) {
        forceFinal = true;
        stoppedBy = "no-progress";
      }
      let args: Record<string, unknown> = {};
      let argumentParse: ToolLoopOutcome["argumentParse"] = "valid";
      let validationErrors: string[] = [];
      try {
        if (typeof call.function.arguments !== "string") throw new Error("not JSON text");
        const parsedArgs = parseToolArguments(call.function.arguments);
        const spec = tools.find(tool => tool.name === call.function.name);
        validationErrors = spec
          ? validateToolArguments(parsedArgs, { ...spec.parameters, type: "object" })
          : ["tool name is not available"];
        if (isDeepSeekV4(model) && requiredTool && call.function.name !== requiredTool)
          validationErrors.push(`this stage requires ${requiredTool}; other tools cannot execute`);
        if (isDeepSeekV4(model) && availableNames && !availableNames.includes(call.function.name))
          validationErrors.push("tool is not available in this stage");
        if (validationErrors.length) argumentParse = "invalid-schema";
        else args = parsedArgs as Record<string, unknown>;
      } catch {
        argumentParse = "invalid-json";
        validationErrors = ["arguments must be complete, valid JSON with unique keys and an object at the root"];
      }
      if (finishReason === "length" || finishReason === "content_filter") {
        argumentParse = "truncated";
        args = {}; // A parsed prefix must never look like executed command evidence.
        validationErrors = [`response finish_reason=${finishReason}; no calls from this incomplete response were executed`];
      }
      await observe({ kind: "arguments", round, callCount: toolCalls.length, finishReason,
        toolName: call.function.name, argumentParse, validationErrors });
      const started = Date.now();
      let result: string;
      let error = false;
      let dispatched = false;
      if (forceFinal) {
        result = stoppedBy === "deadline"
          ? "Deadline exhausted — this call was not executed. Write your final logbook."
          : stoppedBy === "no-progress"
            ? "Repeated source inspection stopped this run — this call was not executed. Write an honest final logbook."
            : "Tool budget exhausted — this call was not executed. Write your final logbook.";
        error = true;
      } else if (toolCalls.length >= options.maxToolCalls) {
        result = "Tool budget exhausted — this call was not executed. Write your final logbook.";
        error = true;
        forceFinal = true;
        stoppedBy = "tool-budget";
      } else if (Date.now() >= options.deadlineMs) {
        forceFinal = true;
        stoppedBy = "deadline";
        result = "Deadline exhausted — this call was not executed. Write your final logbook.";
        error = true;
      } else if (argumentParse !== "valid") {
        dispatched = true; // Invalid attempts consume the existing budget, but never execute.
        error = true;
        result = `Refused: ${validationErrors.join("; ")}. Resubmit this tool with complete fields of the declared types; do not infer missing values. Existing accepted claim state is unchanged. For an existing pending claim, retrieve its state/evidence and update the same id with tested outcome; do not register it again.`;
        const repair = options.getArgumentRepair?.(call.function.name, validationErrors);
        if (repair) result += `\n${repair}`;
      } else {
        dispatched = true;
        try {
          result = await execute(call.function.name, args);
        } catch (err) {
          result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
          error = true;
        }
      }
      result = truncateToolResult(result ?? "", maxToolResultChars);
      if (dispatched && !error && options.transformToolResult) {
        result = options.transformToolResult(call.function.name, result, toolCalls.length + 1 + (options.toolCallIndexOffset ?? 0));
      }
      await observe({ kind: "tool", round, callCount: toolCalls.length + (dispatched ? 1 : 0),
        toolName: call.function.name, argumentParse, validationErrors, toolExcerpt: result.slice(0, 2000) });
      let resultContent = result;
      if (dispatched) {
        const record: ToolCallRecord = {
          index: toolCalls.length + 1 + (options.toolCallIndexOffset ?? 0),
          name: call.function.name,
          args,
          result,
          durationMs: Date.now() - started,
          error,
        };
        toolCalls.push(record);
        await options.onToolCall?.(record);
        resultContent = options.numberToolResults
          ? `[Tool call #${record.index}]\n${result}`
          : result;
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: resultContent,
      });
    }

    // A forced-final request is deliberately issued without tools. If the
    // model nevertheless returns tool calls, preserve the refusal records and
    // stop rather than allowing it to consume the remaining round budget.
    if (requestWasForcedFinal) {
      await observe({ kind: "stop", round, callCount: toolCalls.length, finishReason, stopReason: stoppedBy });
      return { content: "", toolCalls, rounds: round, stoppedBy, finishReason };
    }
  }

  // Round cap reached with the model still calling tools: force one last
  // tool-free turn so a logbook is always produced.
  if (options.stopWithoutFinalResponse)
    return { content: "", toolCalls, rounds: maxRounds, stoppedBy: "round-cap" };
  if (!forceFinal || (stoppedBy !== "deadline" && stoppedBy !== "tool-budget")) {
    stoppedBy = "round-cap";
  }
  messages.push({ role: "user", content: "STOP: the round limit is reached. Do not call any more tools. Write your final logbook now." });
  if (!requestBudget) compactMessages(messages, contextBudget, elidedToolOutputMessage);
  const finalRequest: Record<string, unknown> = {
    model,
    messages: messages as any,
    max_tokens: maxTokens,
    temperature,
  };
  let finalCompletion: any;
  let finalReductions = 0;
  let finalPaymentRetries = 0;
  let finalRateLimitRetries = 0;
  let finalRateLimitWaitedMs = 0;
  let finalExactRateLimitRetryRequest: Record<string, unknown> | undefined;
  while (true) {
    let request: Record<string, unknown>;
    try {
      if (finalExactRateLimitRetryRequest) {
        request = finalExactRateLimitRetryRequest;
        finalExactRateLimitRetryRequest = undefined;
      } else {
        request = requestBudget
          ? fitToolContext(finalRequest, {
            budget: requestBudget,
            protection: options.contextProtection!,
            elidedToolOutputMessage,
            numberToolResults: options.numberToolResults,
          })
          : finalRequest;
      }
    } catch (error) {
      if (error instanceof ContextBudgetError) {
        console.warn(`[ToolLoop] ${error.message}`);
        await options.contextProtection?.onDiagnostic?.(error.message);
        if (options.allowResourceStopFallback && (stoppedBy === "deadline" || stoppedBy === "tool-budget")) {
          return { content: "", toolCalls, rounds: maxRounds + 1, stoppedBy };
        }
      }
      throw error;
    }
    try {
      finalCompletion = await client.chat.completions.create(
        request as any,
        { timeout: activeRequestTimeout(options.deadlineMs, Boolean(requestBudget)), ...(requestBudget ? { maxRetries: 0 } : {}) },
      );
    } catch (err: any) {
      if (
        finalPaymentRetries < MAX_PROVIDER_PAYMENT_RETRIES
        && await waitForTransientProviderPayment(err, options.deadlineMs)
      ) {
        finalPaymentRetries++;
        await observe({ kind: "provider-error", round: maxRounds + 1, callCount: toolCalls.length,
          ...safeProviderErrorDiagnostic(err) });
        continue;
      }
      const rateLimitWait = await waitForRetryableProviderError(
        err, finalRateLimitRetries, finalRateLimitWaitedMs, options.deadlineMs,
      );
      if (rateLimitWait !== null) {
        finalRateLimitWaitedMs = rateLimitWait;
        finalRateLimitRetries++;
        finalExactRateLimitRetryRequest = request;
        await observe({ kind: "provider-error", round: maxRounds + 1, callCount: toolCalls.length,
          ...safeProviderErrorDiagnostic(err) });
        continue;
      }
      if (
        requestBudget
        && isContextOverflow(err)
         && finalReductions < MAX_CONTEXT_RETRIES
        && Date.now() < options.deadlineMs
        && requestBudget.reduce(err, request)
      ) {
        finalReductions++;
        await reportContextDiagnostic(requestBudget, request, model, options.contextProtection);
        if (Date.now() >= options.deadlineMs) {
          stoppedBy = "deadline";
          return { content: "", toolCalls, rounds: maxRounds + 1, stoppedBy };
        }
        continue;
      }
      if (requestBudget && isContextOverflow(err)) {
        await reportContextDiagnostic(requestBudget, request, model, options.contextProtection);
        throw terminalContextError(requestBudget, request, model);
      }
       await observe({ kind: "provider-error", round: maxRounds + 1, callCount: toolCalls.length,
         stopReason: isRateLimit429(err) ? "rate-limit" : "provider-request-failed",
         ...safeProviderErrorDiagnostic(err) });
       throw sanitizeContextRequestError(err, model, config);
    }
    if (finalCompletion?.error) {
      const completionError = finalCompletion.error;
      if (
        finalPaymentRetries < MAX_PROVIDER_PAYMENT_RETRIES
        && await waitForTransientProviderPayment(completionError, options.deadlineMs)
      ) {
        finalPaymentRetries++;
        await observe({ kind: "provider-error", round: maxRounds + 1, callCount: toolCalls.length,
          ...safeProviderErrorDiagnostic(completionError) });
        continue;
      }
      const rateLimitWait = await waitForRetryableProviderError(
        completionError, finalRateLimitRetries, finalRateLimitWaitedMs, options.deadlineMs,
      );
      if (rateLimitWait !== null) {
        finalRateLimitWaitedMs = rateLimitWait;
        finalRateLimitRetries++;
        finalExactRateLimitRetryRequest = request;
        await observe({ kind: "provider-error", round: maxRounds + 1, callCount: toolCalls.length,
          ...safeProviderErrorDiagnostic(completionError) });
        continue;
      }
      if (
        requestBudget
        && isContextOverflow(completionError)
         && finalReductions < MAX_CONTEXT_RETRIES
        && Date.now() < options.deadlineMs
        && requestBudget.reduce(completionError, request)
      ) {
        finalReductions++;
        await reportContextDiagnostic(requestBudget, request, model, options.contextProtection);
        if (Date.now() >= options.deadlineMs) {
          stoppedBy = "deadline";
          return { content: "", toolCalls, rounds: maxRounds + 1, stoppedBy };
        }
        continue;
      }
      if (requestBudget && isContextOverflow(completionError)) {
        await reportContextDiagnostic(requestBudget, request, model, options.contextProtection);
        throw terminalContextError(requestBudget, request, model);
      }
       await observe({ kind: "provider-error", round: maxRounds + 1, callCount: toolCalls.length,
         stopReason: isRateLimit429(completionError) ? "rate-limit" : "provider-error-response",
         ...safeProviderErrorDiagnostic(completionError) });
      throw sanitizeContextRequestError(completionError, model, config);
    }
    break;
  }
  const finalText = finalCompletion?.choices?.[0]?.message?.content;
  const finishReason = safeFinishReason(finalCompletion?.choices?.[0]?.finish_reason);
  await observe({ kind: "completion", round: maxRounds + 1, callCount: toolCalls.length, finishReason,
    ...completionStructure(finalCompletion),
    responseExcerpt: typeof finalText === "string" ? finalText.slice(0, 2000) : undefined });
  await observe({ kind: "stop", round: maxRounds + 1, callCount: toolCalls.length, finishReason, stopReason: stoppedBy });
  return { content: finishReason !== "length" && finishReason !== "content_filter" && typeof finalText === "string" ? finalText : "", toolCalls, rounds: maxRounds + 1, stoppedBy, finishReason };
}
