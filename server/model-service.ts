import OpenAI from "openai";
import {
  ContextBudgetError,
  MAX_CONTEXT_RETRIES,
  RequestContextBudget,
  isContextOverflow,
  providerContextConstraint,
  reportedContextLimit,
} from "./llm-context";
import { describeToolContext, fitToolContext, type ToolContextProtection } from "./tool-context";

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
export const PLATFORM_MODELS = [
  { provider: "openrouter", model: "deepseek/deepseek-chat", label: "DeepSeek Chat (via OpenRouter)", credits: 1, default: true, contextWindow: 64000 },
  { provider: "openrouter", model: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4 (via OpenRouter)", credits: 5, contextWindow: 200000 },
  { provider: "openrouter", model: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5 (via OpenRouter)", credits: 9, contextWindow: 200000 },
  { provider: "openrouter", model: "openai/gpt-4o", label: "GPT-4o (via OpenRouter)", credits: 5, contextWindow: 128000 },
  { provider: "openrouter", model: "openai/gpt-5", label: "GPT-5 (via OpenRouter)", credits: 10, contextWindow: 400000 },
  { provider: "openrouter", model: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna (via OpenRouter)", credits: 12, contextWindow: 1000000 },
  { provider: "openrouter", model: "anthropic/claude-opus-4", label: "Claude Opus 4 (via OpenRouter)", credits: 15, contextWindow: 200000 },
];

// `defaultContextWindow` is used for bring-your-own-key models where we don't know
// the exact model, so we fall back to a sensible per-provider window.
export const BYOC_PROVIDERS = [
  { id: "openai", label: "OpenAI", baseURL: "https://api.openai.com/v1", defaultModel: "gpt-4o", defaultContextWindow: 128000 },
  { id: "anthropic", label: "Anthropic", baseURL: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-20250514", defaultContextWindow: 200000 },
  { id: "openrouter", label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", defaultModel: "deepseek/deepseek-chat", defaultContextWindow: 64000 },
];

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

const OPENAI_COMPAT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

export function createLLMClient(config: ModelProviderConfig, options: { maxRetries?: number } = {}): OpenAI | null {
  if (config.providerMode === "platform") {
    const platformKey = process.env.OPENROUTER_API_KEY;
    if (!platformKey) {
      throw new Error("Platform model generation is not configured. OPENROUTER_API_KEY is missing.");
    }
    return new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: platformKey,
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    });
  }

  if (!config.apiKey) {
    throw new Error("BYOC mode requires an API key.");
  }

  if (config.provider === "anthropic") {
    return null;
  }

  const baseURL = OPENAI_COMPAT_BASE_URLS[config.provider] || OPENAI_COMPAT_BASE_URLS.openrouter;
  return new OpenAI({
    baseURL,
    apiKey: config.apiKey,
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
  });
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

  if (config.provider === "anthropic" && config.providerMode === "byoc") {
    if (!config.apiKey) {
      throw new Error("BYOC Anthropic mode requires an API key.");
    }
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
      ...(contextRequest ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (contextRequest) {
        throw sanitizeContextRequestError(
          { status: response.status, message: errorText },
          model,
        );
      }
      throw new Error(`Anthropic API request failed (${response.status})`);
    }

    const result: AnthropicMessagesResponse = await response.json() as AnthropicMessagesResponse;
    if (contextRequest && (result.type === "error" || (result as any).error)) {
      throw sanitizeContextRequestError((result as any).error ?? result, model);
    }
    const textBlock = result.content?.find((block) => block.type === "text");
    const content = textBlock?.text || "";

    return { content, model, provider: "anthropic" };
  }

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
    if (contextRequest) {
      throw sanitizeContextRequestError({ ...err, status, message: body }, model);
    }
    const diagnostic = safeProviderErrorDiagnostic(err);
    console.error(`[LLM] API request failed — model=${model} provider=${config.provider} status=${diagnostic.providerStatus ?? "unknown"} code=${diagnostic.providerCode ?? "unknown"}`);
    throw new Error(`LLM request failed (${diagnostic.providerStatus ?? "unknown"}; code=${diagnostic.providerCode ?? "unknown"})`);
  }

  if (completion?.error) {
    if (contextRequest) {
      throw sanitizeContextRequestError(completion.error, model);
    }
    const diagnostic = safeProviderErrorDiagnostic(completion.error);
    console.error(`[LLM] API returned an error — model=${model} provider=${config.provider} status=${diagnostic.providerStatus ?? "unknown"} code=${diagnostic.providerCode ?? "unknown"}`);
    throw new Error(`LLM API error (${diagnostic.providerStatus ?? "unknown"}; code=${diagnostic.providerCode ?? "unknown"})`);
  }

  const content = completion.choices?.[0]?.message?.content || "";
  if (!content) {
    if (contextRequest) {
      throw new Error(`LLM returned empty response for context request (model=${model})`);
    }
    console.error(`[LLM] Empty content returned — model=${model} choices:`, JSON.stringify(completion.choices));
    throw new Error(`LLM returned empty response (choices: ${JSON.stringify(completion.choices)})`);
  }
  return { content, model, provider: config.provider };
}

function sanitizeContextRequestError(error: any, model: string): Error {
  const status = error?.status ?? error?.statusCode;
  const code = error?.code ?? error?.type ?? "context_request_failed";
  const rawMessage = contextRequestErrorText(error);
  const contextLike = isContextOverflow(error);
  const message = contextLike
    ? `Context length exceeded (${status ?? "unknown"})`
    : `LLM context request failed (${status ?? "unknown"})`;
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

interface AnthropicMessagesResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{ type: string; text: string }>;
  model: string;
  stop_reason: string | null;
}

export function resolveModelName(config: ModelProviderConfig): string {
  if (config.modelName) return config.modelName;

  if (config.providerMode === "platform") {
    const defaultPlatform = PLATFORM_MODELS.find(m => m.default);
    return defaultPlatform?.model || "deepseek/deepseek-chat";
  }

  const byocProvider = BYOC_PROVIDERS.find(p => p.id === config.provider);
  return byocProvider?.defaultModel || "deepseek/deepseek-chat";
}

export async function validateApiKey(provider: string, apiKey: string): Promise<{ valid: boolean; error?: string }> {
  try {
    if (provider === "anthropic") {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1,
          messages: [{ role: "user", content: "test" }],
        }),
      });

      if (response.status === 401 || response.status === 403) {
        return { valid: false, error: "Invalid Anthropic API key. Please check your credentials." };
      }
      return { valid: true };
    }

    const baseURL = OPENAI_COMPAT_BASE_URLS[provider];
    if (!baseURL) {
      return { valid: false, error: `Unknown provider: ${provider}` };
    }

    const client = new OpenAI({ baseURL, apiKey });
    await client.models.list();
    return { valid: true };
  } catch (err: any) {
    if (err.status === 401 || err.status === 403) {
      return { valid: false, error: "Invalid API key. Please check your credentials." };
    }
    if (err.status === 404 || err.status === 405) {
      return { valid: true };
    }
    return { valid: false, error: "Could not validate API key. Please check your credentials and try again." };
  }
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

export interface ToolLoopOutcome {
  kind: "completion" | "arguments" | "tool" | "stop" | "provider-error";
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
  contextLimit?: number;
  requestedInputTokens?: number;
  requestedOutputTokens?: number;
  requestedTotalTokens?: number;
}

export interface ToolLoopOptions {
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
]);

/** Numeric/allowlisted provider facts safe for private diagnostics. */
export function safeProviderErrorDiagnostic(error: unknown): Pick<ToolLoopOutcome,
  "providerStatus" | "providerCode" | "contextLimit" | "requestedInputTokens"
  | "requestedOutputTokens" | "requestedTotalTokens"> {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const statusValue = Number(value.status ?? value.statusCode);
  const rawCode = String(value.code ?? value.type ?? "");
  const constraint = providerContextConstraint(error);
  return {
    providerStatus: Number.isSafeInteger(statusValue) && statusValue >= 100 && statusValue <= 599
      ? statusValue : undefined,
    providerCode: PROVIDER_CODES.has(rawCode) ? rawCode : "unknown",
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
  return typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
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

export async function runToolLoop(
  config: ModelProviderConfig,
  systemPrompt: string,
  userMessage: string,
  tools: ToolSpec[],
  execute: (name: string, args: Record<string, unknown>) => Promise<string>,
  options: ToolLoopOptions,
): Promise<ToolLoopResult> {
  if (config.provider === "anthropic" && config.providerMode === "byoc") {
    throw new Error("Tool-using agents require an OpenAI-compatible provider (platform, OpenAI, or OpenRouter). Anthropic BYOC is not supported for this workflow yet.");
  }
  const client = createLLMClient(config, options.contextProtection ? { maxRetries: 0 } : {});
  if (!client) throw new Error(`Could not create LLM client for provider: ${config.provider}`);
  const model = resolveModelName(config);
  const maxTokens = options.maxTokens ?? 8000;
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
  let recoveryProgressHighWater: number | undefined;
  const observe = async (event: ToolLoopOutcome): Promise<void> => {
    try { await options.onOutcome?.(event); } catch { /* Diagnostics cannot break a run. */ }
  };

  for (let round = 1; round <= maxRounds; round++) {
    const budgetExhausted = toolCalls.length >= options.maxToolCalls;
    const pastDeadline = Date.now() >= options.deadlineMs;
    if (!forceFinal && (budgetExhausted || pastDeadline)) {
      forceFinal = true;
      stoppedBy = budgetExhausted ? "tool-budget" : "deadline";
      messages.push({
        role: "user",
        content: budgetExhausted
          ? "STOP: your tool-call budget is exhausted. Do not call any more tools. Write your final logbook now, based strictly on the tool outputs you have already seen. Any claim you could not finish testing must be recorded as inconclusive in the logbook."
          : "STOP: the time budget is exhausted. Do not call any more tools. Write your final logbook now, based strictly on the tool outputs you have already seen. Any claim you could not finish testing must be recorded as inconclusive in the logbook.",
      });
    }
    if (!requestBudget) compactMessages(messages, contextBudget, elidedToolOutputMessage);

    const requestWasForcedFinal = forceFinal;
    const fallbackAfterResourceStop = (): ToolLoopResult | null => {
      if (
        requestWasForcedFinal
        && (stoppedBy === "deadline" || stoppedBy === "tool-budget")
      ) {
        return { content: "", toolCalls, rounds: round, stoppedBy };
      }
      if (!requestWasForcedFinal && Date.now() >= options.deadlineMs) {
        stoppedBy = "deadline";
        return { content: "", toolCalls, rounds: round, stoppedBy };
      }
      return null;
    };
    const baseRequest: Record<string, unknown> = {
      model,
      messages: messages as any,
      ...(forceFinal ? {} : { tools: toolDefs as any, tool_choice: "auto" as const }),
      max_tokens: maxTokens,
      temperature,
    };
    let completion: any;
    let contextReductions = 0;
    while (true) {
      let request: Record<string, unknown>;
      try {
        request = requestBudget
          ? fitToolContext(baseRequest, {
            budget: requestBudget,
            protection: options.contextProtection!,
            elidedToolOutputMessage,
            numberToolResults: options.numberToolResults,
          })
          : baseRequest;
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
      try {
        completion = await client.chat.completions.create(
          request as any,
          { timeout: activeRequestTimeout(options.deadlineMs, Boolean(requestBudget)), ...(requestBudget ? { maxRetries: 0 } : {}) },
        );
      } catch (err: any) {
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
           stopReason: "provider-request-failed", ...safeProviderErrorDiagnostic(err) });
        if (options.allowResourceStopFallback) {
          const fallback = fallbackAfterResourceStop();
          if (fallback) return fallback;
        }
        if (requestBudget && isContextOverflow(err)) {
          throw terminalContextError(requestBudget, request, model);
        }
         throw sanitizeContextRequestError(err, model);
      }
      if (completion?.error) {
        const completionError = completion.error;
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
           stopReason: "provider-error-response", ...safeProviderErrorDiagnostic(completionError) });
        if (options.allowResourceStopFallback) {
          const fallback = fallbackAfterResourceStop();
          if (fallback) return fallback;
        }
        if (requestBudget && isContextOverflow(completionError)) {
          throw terminalContextError(requestBudget, request, model);
        }
        throw sanitizeContextRequestError(completionError, model);
      }
      break;
    }
    const msg = completion?.choices?.[0]?.message;
    const finishReason = safeFinishReason(completion?.choices?.[0]?.finish_reason);
    await observe({
      kind: "completion", round, callCount: toolCalls.length, finishReason,
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
      (msg.tool_calls || []).filter((c: any) => c?.type === "function" && c.function?.name);
    const assistantText: string | null = typeof msg.content === "string" && msg.content.trim() ? msg.content : null;
    messages.push({
      role: "assistant",
      content: assistantText ?? "",
      ...(calls.length ? { tool_calls: calls } : {}),
    });
    await options.onRound?.(round, assistantText);

    if (calls.length === 0) {
      // A request may have started before the deadline and returned after it.
      // Do not offer another recovery continuation in that case.
      if (!forceFinal && Date.now() >= options.deadlineMs) {
        forceFinal = true;
        stoppedBy = "deadline";
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
      await observe({ kind: "tool", round, callCount: toolCalls.length + (dispatched ? 1 : 0),
        toolName: call.function.name, argumentParse, validationErrors, toolExcerpt: result.slice(0, 2000) });
      let resultContent = result;
      if (dispatched) {
        const record: ToolCallRecord = {
          index: toolCalls.length + 1,
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
  while (true) {
    let request: Record<string, unknown>;
    try {
      request = requestBudget
        ? fitToolContext(finalRequest, {
          budget: requestBudget,
          protection: options.contextProtection!,
          elidedToolOutputMessage,
          numberToolResults: options.numberToolResults,
        })
        : finalRequest;
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
         stopReason: "provider-request-failed", ...safeProviderErrorDiagnostic(err) });
       throw sanitizeContextRequestError(err, model);
    }
    if (finalCompletion?.error) {
      const completionError = finalCompletion.error;
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
         stopReason: "provider-error-response", ...safeProviderErrorDiagnostic(completionError) });
      throw sanitizeContextRequestError(completionError, model);
    }
    break;
  }
  const finalText = finalCompletion?.choices?.[0]?.message?.content;
  const finishReason = safeFinishReason(finalCompletion?.choices?.[0]?.finish_reason);
  await observe({ kind: "completion", round: maxRounds + 1, callCount: toolCalls.length, finishReason,
    responseExcerpt: typeof finalText === "string" ? finalText.slice(0, 2000) : undefined });
  await observe({ kind: "stop", round: maxRounds + 1, callCount: toolCalls.length, finishReason, stopReason: stoppedBy });
  return { content: finishReason !== "length" && finishReason !== "content_filter" && typeof finalText === "string" ? finalText : "", toolCalls, rounds: maxRounds + 1, stoppedBy, finishReason };
}
