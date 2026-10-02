import type { RecordedResult } from "./prompts/reproduce";
import type { ReproductionPagingDiagnostics } from "./reproduction-read-guard";

const MAX_BYTES = 24_000;
const MAX_EVENTS = 32;
const snapshots = new WeakMap<object, ReproductionFailureDiagnostics>();

/** Diagnostic text is never a prompt, provider error body, or full tool output. */
export function diagnosticExcerpt(value: string, maxBytes = 700): string {
  const sanitized = value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi, "[REDACTED private key]")
    .replace(/(?:https?|postgres(?:ql)?):\/\/[^\s"'<>]+/gi, "[REDACTED URL]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[REDACTED authorization]")
    .replace(/(?:["']?[\w.-]*(?:token|secret|password|credential|api[_-]?key|authorization|cookie)[\w.-]*["']?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "[REDACTED credential field]")
    .replace(/\b(?:sk-|hf_|gh[pousr]_|AKIA)[A-Za-z0-9_-]+/g, "[REDACTED token]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, "[REDACTED JWT]")
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, "[REDACTED opaque value]")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  let result = "";
  for (const char of sanitized) {
    if (Buffer.byteLength(JSON.stringify(result + char), "utf8") > maxBytes - 30) {
      return `${result}[TRUNCATED]`;
    }
    result += char;
  }
  return result;
}

export interface ReproductionFailureDiagnostics {
  version: 1;
  stage: string;
  stopReason: string;
  rounds: number;
  callCount: number;
  redaction: string;
  truncated: boolean;
  droppedEvents: number;
  events: Array<Record<string, string | number | string[]>>;
  claims: Array<{ id: string; claim: string; status: string }>;
  paging?: ReproductionPagingDiagnostics;
  milestones?: Array<Record<string, string | number | string[]>>;
  identity?: { controller: string; model: string; provider: string; mode: string; build?: string };
}

const safeNumber = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const enumValue = (value: unknown, allowed: string[]): string =>
  typeof value === "string" && allowed.includes(value) ? value : "unknown";

export class ReproductionDiagnostics {
  private data: ReproductionFailureDiagnostics = {
    version: 1, stage: "preflight", stopReason: "exception", rounds: 0, callCount: 0,
    redaction: "Credential fields, authorization, URLs, private keys and opaque tokens are redacted. Excerpts and history are bounded; prompts, raw provider errors and full outputs are excluded.",
    truncated: false, droppedEvents: 0, events: [], claims: [],
  };

  stage(stage: "preflight" | "materials" | "sandbox" | "tool-loop" | "completion" | "judge" | "report" | "background" | "extraction"): void {
    this.data.stage = stage;
    this.pin({ kind: "phase", phase: stage });
  }

  identity(model: string, provider: string, mode: string, build?: string): void {
    this.data.identity = { controller: "stage-controller-1", model: diagnosticExcerpt(model, 180),
      provider: diagnosticExcerpt(provider, 120), mode: diagnosticExcerpt(mode, 80),
      ...(build && /^[a-f0-9]{64}$/.test(build) ? { build } : {}) };
  }

  private pin(event: Record<string, string | number | string[]>): void {
    const milestones = this.data.milestones ??= [];
    if (milestones.length < 10) milestones.push(event);
  }

  /** Numeric and enum-only snapshot; no source text, paths, quotes or prompts. */
  paging(value: ReproductionPagingDiagnostics): void {
    this.data.paging = {
      sourceReadCount: safeNumber(value.sourceReadCount),
      sourceRepeatCount: safeNumber(value.sourceRepeatCount),
      outputRepeatCount: safeNumber(value.outputRepeatCount),
      outputNewRangeCount: safeNumber(value.outputNewRangeCount),
      paperFirstGap: safeNumber(value.paperFirstGap),
      paperTotal: safeNumber(value.paperTotal),
      outputNextOffset: safeNumber(value.outputNextOffset),
      originalOutputCallId: safeNumber(value.originalOutputCallId),
      navigation: enumValue(value.navigation, ["extract", "source", "output", "none"]) as ReproductionPagingDiagnostics["navigation"],
      stalled: value.stalled === true,
    };
  }

  observe(event: {
    kind: string; round?: number; callCount?: number; finishReason?: string | null;
    argumentParse?: string; toolName?: string; validationErrors?: readonly string[];
    responseExcerpt?: string; toolExcerpt?: string; stopReason?: string;
    providerStatus?: number; providerCode?: string; contextLimit?: number;
    providerReason?: string;
    providerLimitSource?: string; providerPaymentReason?: string;
    providerRetryAfterMs?: number;
    requestedInputTokens?: number; requestedOutputTokens?: number; requestedTotalTokens?: number;
  }): void {
    this.data.rounds = Math.max(this.data.rounds, safeNumber(event.round));
    this.data.callCount = Math.max(this.data.callCount, safeNumber(event.callCount));
    if (event.stopReason) this.stop(event.stopReason);
    const safe: Record<string, string | number | string[]> = {
      kind: diagnosticExcerpt(event.kind, 100), round: safeNumber(event.round),
      callCount: safeNumber(event.callCount),
    };
    if (event.finishReason !== undefined) safe.finishReason = enumValue(event.finishReason,
      ["stop", "length", "tool_calls", "function_call", "content_filter", "unknown"]);
    if (event.argumentParse) safe.argumentParse = diagnosticExcerpt(event.argumentParse, 100);
    if (event.toolName) safe.toolName = enumValue(event.toolName,
      ["record_result", "read_tool_result", "read_reproduction_context", "run_command", "read_file", "write_file", "list_files"]);
    if (event.validationErrors) safe.validationErrors = event.validationErrors.slice(0, 8).map(s => diagnosticExcerpt(s, 300));
    if (event.responseExcerpt) safe.responseExcerpt = diagnosticExcerpt(event.responseExcerpt);
    if (event.toolExcerpt) safe.toolExcerpt = diagnosticExcerpt(event.toolExcerpt);
    if (event.providerStatus !== undefined) safe.providerStatus = safeNumber(event.providerStatus);
    if (event.providerCode !== undefined) safe.providerCode = enumValue(event.providerCode,
      ["context_length_exceeded", "prompt_too_long", "invalid_request_error",
        "max_tokens", "max_num_tokens", "request_too_large",
        "payment_required", "provider_credit", "unknown"]);
    if (event.providerReason !== undefined) safe.providerReason = enumValue(event.providerReason,
      ["provider-credit", "payment", "context", "rate-limit", "unknown"]);
    if (event.providerLimitSource !== undefined) safe.providerLimitSource = enumValue(event.providerLimitSource,
      ["openrouter_in_flight_budget", "openrouter_key_limit", "openrouter_credits"]);
    if (event.providerPaymentReason !== undefined) safe.providerPaymentReason = enumValue(event.providerPaymentReason,
      ["in_flight_budget_exhausted", "weight_exceeds_budget"]);
    if (event.providerRetryAfterMs !== undefined) safe.providerRetryAfterMs = safeNumber(event.providerRetryAfterMs);
    if (event.contextLimit !== undefined) safe.contextLimit = safeNumber(event.contextLimit);
    if (event.requestedInputTokens !== undefined) safe.requestedInputTokens = safeNumber(event.requestedInputTokens);
    if (event.requestedOutputTokens !== undefined) safe.requestedOutputTokens = safeNumber(event.requestedOutputTokens);
    if (event.requestedTotalTokens !== undefined) safe.requestedTotalTokens = safeNumber(event.requestedTotalTokens);
    if (JSON.stringify(safe).includes("[TRUNCATED]") || (event.validationErrors?.length ?? 0) > 8) this.data.truncated = true;
    this.data.events.push(safe);
    if (event.validationErrors?.length && !this.data.milestones?.some(e => e.kind === "first-validation-failure")) {
      this.pin({ kind: "first-validation-failure", callCount: safe.callCount,
        validationErrors: event.validationErrors.slice(0, 3).map(s => diagnosticExcerpt(s, 240)) });
    }
    if (event.kind === "provider-error" && !this.data.milestones?.some(e => e.kind === "first-provider-error"))
      this.pin({ kind: "first-provider-error", providerStatus: safe.providerStatus ?? 0, providerReason: safe.providerReason ?? "unknown" });
    while (this.data.events.length > MAX_EVENTS) this.dropEvent();
  }

  claims(claims: Iterable<RecordedResult>): void {
    this.data.claims = [];
    for (const claim of Array.from(claims)) {
      if (this.data.claims.length === 20) { this.data.truncated = true; break; }
      this.data.claims.push({
        id: diagnosticExcerpt(claim.id, 140), claim: diagnosticExcerpt(claim.claim, 400),
        status: enumValue(claim.status, ["pending", "verified", "falsified", "toy", "inconclusive"]),
      });
    }
    if (JSON.stringify(this.data.claims).includes("[TRUNCATED]")) this.data.truncated = true;
  }

  stop(reason: string): void {
    this.data.stopReason = enumValue(reason,
      ["model", "tool-budget", "deadline", "round-cap", "no-progress", "exception",
        "context-budget", "provider-payment", "provider-credit", "rate-limit",
        "completion-validation", "cleanup-failed"]);
  }

  private dropEvent(): void {
    this.data.events.shift();
    this.data.droppedEvents++;
    this.data.truncated = true;
  }

  snapshot(): ReproductionFailureDiagnostics {
    while (Buffer.byteLength(JSON.stringify(this.data), "utf8") > MAX_BYTES && this.data.events.length) this.dropEvent();
    return JSON.parse(JSON.stringify(this.data));
  }
}

/** Best effort only: retain the original exception and never throw from capture. */
export function attachReproductionFailureDiagnostics(error: unknown, diagnostics: ReproductionDiagnostics): void {
  try {
    if (error && typeof error === "object") snapshots.set(error, diagnostics.snapshot());
  } catch { /* Diagnostic capture must not mask the failure. */ }
}

export function getReproductionFailureDiagnostics(error: unknown): ReproductionFailureDiagnostics | undefined {
  return error && typeof error === "object" ? snapshots.get(error) : undefined;
}

export function createFallbackReproductionDiagnostics(): ReproductionFailureDiagnostics {
  const diagnostics = new ReproductionDiagnostics();
  diagnostics.stage("background");
  return diagnostics.snapshot();
}