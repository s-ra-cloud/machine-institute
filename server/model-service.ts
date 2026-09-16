import OpenAI from "openai";

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

export function createLLMClient(config: ModelProviderConfig): OpenAI | null {
  if (config.providerMode === "platform") {
    const platformKey = process.env.OPENROUTER_API_KEY;
    if (!platformKey) {
      throw new Error("Platform model generation is not configured. OPENROUTER_API_KEY is missing.");
    }
    return new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: platformKey,
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
  });
}

export async function generateWithConfig(
  config: ModelProviderConfig,
  systemPrompt: string,
  userMessage: string,
  options: { maxTokens?: number; temperature?: number } = {},
): Promise<GenerationResult> {
  const model = resolveModelName(config);
  const maxTokens = options.maxTokens || 12000;
  const temperature = options.temperature || 0.3;

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
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
    }

    const result: AnthropicMessagesResponse = await response.json() as AnthropicMessagesResponse;
    const textBlock = result.content?.find((block) => block.type === "text");
    const content = textBlock?.text || "";

    return { content, model, provider: "anthropic" };
  }

  const client = createLLMClient(config);
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
      { timeout: 600_000 },
    );
  } catch (err: any) {
    const status = err?.status ?? err?.statusCode ?? "unknown";
    const body = err?.error ?? err?.message ?? String(err);
    console.error(`[LLM] API request failed — model=${model} provider=${config.provider} status=${status}:`, JSON.stringify(body));
    throw new Error(`LLM request failed (${status}): ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }

  if (completion?.error) {
    console.error(`[LLM] API returned error body — model=${model} provider=${config.provider}:`, JSON.stringify(completion.error));
    throw new Error(`LLM API error: ${completion.error.message || JSON.stringify(completion.error)}`);
  }

  const content = completion.choices?.[0]?.message?.content || "";
  if (!content) {
    console.error(`[LLM] Empty content returned — model=${model} choices:`, JSON.stringify(completion.choices));
    throw new Error(`LLM returned empty response (choices: ${JSON.stringify(completion.choices)})`);
  }
  return { content, model, provider: config.provider };
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

export const PER_USER_PLATFORM_LIMITS: Record<string, { max: number; windowMs: number }> = {
  editorial: { max: 5, windowMs: 24 * 60 * 60 * 1000 },
  "literature-review": { max: 10, windowMs: 24 * 60 * 60 * 1000 },
  "ethics-report": { max: 5, windowMs: 24 * 60 * 60 * 1000 },
  "peer-review": { max: 5, windowMs: 24 * 60 * 60 * 1000 },
  reproduction: { max: 2, windowMs: 24 * 60 * 60 * 1000 },
};

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

export interface ToolLoopOptions {
  maxToolCalls: number;
  /** Absolute epoch-ms deadline after which the agent is told to wrap up. */
  deadlineMs: number;
  maxTokens?: number;
  temperature?: number;
  maxToolResultChars?: number;
  contextCharBudget?: number;
  onToolCall?: (record: ToolCallRecord) => Promise<void> | void;
  onRound?: (round: number, assistantText: string | null) => Promise<void> | void;
}

export interface ToolLoopResult {
  content: string;
  toolCalls: ToolCallRecord[];
  rounds: number;
  stoppedBy: "model" | "tool-budget" | "deadline" | "round-cap";
}

const ELIDED_TOOL_OUTPUT = "[earlier tool output elided to fit the context window — re-run the tool if you need it again]";
const KEEP_RECENT_TOOL_MESSAGES = 8;

function messageChars(m: { content?: unknown }): number {
  return typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
}

// Drop the bodies of the oldest tool results once the transcript outgrows the
// model's context window, keeping the most recent ones intact.
function compactMessages(messages: Array<Record<string, unknown>>, budgetChars: number): void {
  let total = messages.reduce((n, m) => n + messageChars(m), 0);
  if (total <= budgetChars) return;
  const toolIdx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter(i => i >= 0);
  const candidates = toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_RECENT_TOOL_MESSAGES));
  for (const i of candidates) {
    const m = messages[i];
    if (m.content === ELIDED_TOOL_OUTPUT) continue;
    total -= messageChars(m) - ELIDED_TOOL_OUTPUT.length;
    m.content = ELIDED_TOOL_OUTPUT;
    if (total <= budgetChars) break;
  }
}

function truncateToolResult(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.floor(max * 0.7))}\n\n[... ${s.length - max} chars truncated ...]\n\n${s.slice(-Math.floor(max * 0.3))}`;
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
  const client = createLLMClient(config);
  if (!client) throw new Error(`Could not create LLM client for provider: ${config.provider}`);
  const model = resolveModelName(config);
  const maxTokens = options.maxTokens ?? 8000;
  const temperature = options.temperature ?? 0.2;
  const maxToolResultChars = options.maxToolResultChars ?? 12_000;
  const contextBudget = options.contextCharBudget ?? Math.floor(getContextWindow(config) * 3.0);

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
    compactMessages(messages, contextBudget);

    let completion: any;
    try {
      completion = await client.chat.completions.create(
        {
          model,
          messages: messages as any,
          ...(forceFinal ? {} : { tools: toolDefs as any, tool_choice: "auto" as const }),
          max_tokens: maxTokens,
          temperature,
        },
        { timeout: 600_000 },
      );
    } catch (err: any) {
      const status = err?.status ?? err?.statusCode ?? "unknown";
      const body = err?.error ?? err?.message ?? String(err);
      console.error(`[ToolLoop] API request failed — model=${model} round=${round} status=${status}:`, JSON.stringify(body));
      throw new Error(`LLM request failed (${status}): ${typeof body === "string" ? body : JSON.stringify(body)}`);
    }
    if (completion?.error) {
      throw new Error(`LLM API error: ${completion.error.message || JSON.stringify(completion.error)}`);
    }
    const msg = completion.choices?.[0]?.message;
    if (!msg) throw new Error("LLM returned no message.");

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
      return { content: assistantText ?? "", toolCalls, rounds: round, stoppedBy };
    }

    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = { _raw: call.function.arguments };
      }
      const started = Date.now();
      let result: string;
      let error = false;
      if (toolCalls.length >= options.maxToolCalls) {
        result = "Tool budget exhausted — this call was not executed. Write your final logbook.";
        error = true;
      } else {
        try {
          result = await execute(call.function.name, args);
        } catch (err) {
          result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
          error = true;
        }
      }
      result = truncateToolResult(result ?? "", maxToolResultChars);
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
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  // Round cap reached with the model still calling tools: force one last
  // tool-free turn so a logbook is always produced.
  stoppedBy = "round-cap";
  messages.push({ role: "user", content: "STOP: the round limit is reached. Do not call any more tools. Write your final logbook now." });
  compactMessages(messages, contextBudget);
  const finalCompletion: any = await client.chat.completions.create(
    { model, messages: messages as any, max_tokens: maxTokens, temperature },
    { timeout: 600_000 },
  );
  const finalText = finalCompletion?.choices?.[0]?.message?.content;
  return { content: typeof finalText === "string" ? finalText : "", toolCalls, rounds: maxRounds + 1, stoppedBy };
}
