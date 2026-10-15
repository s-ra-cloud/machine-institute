import {
  generateWithConfig,
  getContextWindow,
  type ModelProviderConfig,
  type ToolCallRecord,
} from "./model-service";
import { isDeepSeekV4 } from "./reasoning-continuation";
import { requestFailureCode } from "./request-failure";
import { falsificationRejection } from "./reproduction-comparison";
import {
  ContextBudgetError,
  isContextOverflow,
  isProviderPaymentFailure,
  outputBudgetExhausted,
  RequestContextBudget,
} from "./llm-context";
import {
  parseJudgeOutput,
  type ClaimVerdict,
  type RecordedResult,
} from "./prompts/reproduce";

// Each request gets its own reasoning allowance, including split children.
// Never divide a fixed global allowance by the total registered claim count.
const JUDGE_OUTPUT_TOKENS = 6000;
function initialOutputTokens(config: ModelProviderConfig): number {
  // Live V4 runs exhausted 6k even for single claims. Reserve reasoning room
  // up front; context preflight still splits or rejects rather than losing evidence.
  return isDeepSeekV4(config.modelName) ? 12_000 : JUDGE_OUTPUT_TOKENS;
}
// Reasoning and evidence comparison cost much more than serializing verdict rows.
const JUDGE_MAX_BATCH_CLAIMS = 3;
const JUDGE_REQUEST_TIMEOUT_MS = 240_000;
/** Ceiling for one request after growth; reasoning models may spend most of it before the JSON. */
const JUDGE_OUTPUT_CAP = 24_000;
const JUDGE_TIMEOUT_MS = 1_200_000;
const MAX_CONTEXT_RETRIES = 2;
const TRANSCRIPT_RESULT_CHARS = 3_000;
/** Cited executions up to this size are shown whole at reduction levels 0-2. */
const FULL_EXECUTION_CHARS = 40_000;
/** Compact levels 3-4 keep the earlier whole-capture bound. */
const COMPACT_EXECUTION_CHARS = 12_000;
/** Context kept on each side of the cited excerpt when an execution is too long to show whole. */
const EXECUTION_WINDOW_CHARS = 4_000;

import type { QuestioningState } from "./reproduction-questioning";
import { JUDGE_VERIFICATION_STANDARD, QUESTIONING_JUDGE_PROMPT } from "./prompts/reproduce";
import { VERIFICATION_CHECK, verificationConflict } from "./reproduction-verification";

export interface RunBoundedReproductionJudgeOptions {
  questioning?: QuestioningState;
  config: ModelProviderConfig;
  prompt: string;
  title: string;
  abstract: string;
  logbook: string;
  recordedResults: RecordedResult[];
  toolCalls: readonly ToolCallRecord[];
  onDiagnostic?: (message: string) => Promise<void> | void;
}

export interface BoundedReproductionJudgeResult {
  summary: string;
  results: ClaimVerdict[];
  independentAssessmentAvailable?: boolean;
}

type InputReduction = 0 | 1 | 2 | 3 | 4;
type JudgeRequest = {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  max_tokens: number;
  temperature: number;
};

/**
 * Keep the evidence block deliberately independent from the chronological
 * transcript.  The latter is useful context, but it is not authoritative:
 * cited tool output is the evidence a judge must be able to inspect.
 */
function citedEvidence(
  result: RecordedResult,
  toolCalls: readonly ToolCallRecord[],
  level: InputReduction = 0,
  shown: Map<number, string> = new Map(),
): string {
  const ids = new Set<number>(result.evidenceToolCallIds ?? []);
  if (result.rawInputToolCallId !== undefined) ids.add(result.rawInputToolCallId);
  // A printed number is not proof of recomputation. Preserve the last source
  // write before each cited execution, even if chronological context is compacted.
  if (result.method === "raw-data-rederived") {
    for (const execution of toolCalls.filter(call => ids.has(call.index) && call.name === "run_command")) {
      const command = String(execution.args.command ?? "");
      const writes = toolCalls.filter(call => call.index < execution.index && call.name === "write_file"
        && typeof call.args.path === "string" && command.split(/\s+/).includes(call.args.path));
      const latest = new Map<string, ToolCallRecord>();
      for (const write of writes) latest.set(String(write.args.path), write);
      latest.forEach(write => ids.add(write.index));
    }
  }
  const calls = toolCalls.filter(call => ids.has(call.index));
  // A compound claim may need several rows, not just the agent's selected
  // excerpt, so execution captures are shown whole while context allows.
  // Only the compact reduction levels fall back to excerpt-centred windows.
  const wholeExecutionChars = level >= 3 ? COMPACT_EXECUTION_CHARS : FULL_EXECUTION_CHARS;
  const blocks = calls.map(call => {
    const args = JSON.stringify(call.args ?? {});
    const excerpt = result.evidenceExcerpt?.trim();
    const excerptPosition = excerpt ? call.result.indexOf(excerpt) : -1;
    const exactExcerptFound = excerptPosition >= 0;
    const isExecution = call.name === "run_command";
    const retainedExecution = isExecution && call.result.length <= wholeExecutionChars;
    const provenance = result.rawInputToolCallId === call.index
      ? `\nRaw-input provenance: ${result.rawInputPath || "(path not recorded)"} (original tool #${call.index})`
      : "";
    // Claims in one batch often cite the same long execution: show it once.
    const shownUnder = retainedExecution ? shown.get(call.index) : undefined;
    if (shownUnder) {
      return [
        `Original tool #${call.index}: ${call.name} ${args}`,
        `Output: the complete output of tool #${call.index} is shown above under ${shownUnder}.`,
        exactExcerptFound ? `Exact cited excerpt: ${excerpt}` : "",
        provenance,
      ].filter(Boolean).join("\n");
    }
    if (retainedExecution) shown.set(call.index, result.id);
    let output = call.result;
    if (exactExcerptFound && !retainedExecution) {
      const pad = isExecution && level < 3 ? EXECUTION_WINDOW_CHARS : 250;
      const start = Math.max(0, excerptPosition - pad);
      const end = Math.min(call.result.length, excerptPosition + excerpt!.length + pad);
      output = `${start > 0 ? "[... preceding output omitted ...]\n" : ""}${call.result.slice(start, end)}${end < call.result.length ? "\n[... following output omitted ...]" : ""}`;
    } else if (call.name === "read_file" && call.result.length > 8_000) {
      output = `${call.result.slice(0, 8_000)}\n[... raw read output bounded to the first 8000 characters; cite a retained exact excerpt ...]`;
    } else if (!retainedExecution) {
      const bound = isExecution ? wholeExecutionChars : COMPACT_EXECUTION_CHARS;
      if (call.result.length > bound) output = `${call.result.slice(0, bound)}\n[... uncited command output bounded ...]`;
    }
    return [
      `Original tool #${call.index}: ${call.name} ${args}`,
      `Output status: ${call.result.split("\n", 1)[0]}`,
      output,
      exactExcerptFound ? `Exact cited excerpt: ${excerpt}` : "",
      provenance,
    ].filter(Boolean).join("\n");
  });
  return blocks.length
    ? blocks.join("\n\n")
    : "No scientific output cited. The structured result is not evidence by itself.";
}

function transcriptBlocks(toolCalls: readonly ToolCallRecord[]): string[] {
  return toolCalls.map(call => {
    const args = call.name === "run_command"
      ? String(call.args?.command ?? "")
      : JSON.stringify(call.args ?? {});
    const output = call.result.slice(0, TRANSCRIPT_RESULT_CHARS);
    return [
      `### [${call.index}] ${call.name}: ${args.slice(0, 500)}`,
      output,
      call.result.length > TRANSCRIPT_RESULT_CHARS ? "[... truncated ...]" : "",
      "",
    ].filter(Boolean).join("\n");
  });
}

function compact(text: string, limit: number, label: string): string {
  if (text.length <= limit) return text || `(no ${label} produced)`;
  const tail = Math.max(200, Math.floor(limit * 0.25));
  return `${text.slice(0, limit - tail)}\n[... ${label} compacted by the bounded judge ...]\n${text.slice(-tail)}`;
}

function transcriptForLevel(blocks: string[], level: InputReduction): string {
  if (level === 0) return blocks.join("\n\n") || "(no tools were called)";
  // A transcript is redundant with ORIGINAL CITED TOOL OUTPUTS.  Remove the
  // oldest blocks first, retaining the recent chronological context.
  const keep = level === 1 ? Math.min(8, blocks.length) : level === 2 ? Math.min(3, blocks.length) : 0;
  const omitted = blocks.length - keep;
  const prefix = omitted > 0 ? `[... ${omitted} earlier transcript tool call(s) omitted ...]\n\n` : "";
  const retained = keep === 0 ? [] : blocks.slice(-keep);
  return `${prefix}${retained.join("\n\n") || "(transcript omitted; see original cited outputs)"}`;
}

function buildJudgeInput(
  title: string,
  abstract: string,
  logbook: string,
  claims: RecordedResult[],
  toolCalls: readonly ToolCallRecord[],
  level: InputReduction,
  allIds: readonly string[] = claims.map(claim => claim.id),
): string {
  const blocks = transcriptBlocks(toolCalls);
  // Batches see the whole logbook; without this, a batch reports the other
  // results as missing from the record in the published judge summary.
  const batchIds = new Set(claims.map(claim => claim.id));
  const elsewhere = Array.from(new Set(allIds)).filter(id => !batchIds.has(id));
  const scope = elsewhere.length && claims.length
    ? `Scope: this request grades only ${Array.from(batchIds).join(", ")}. The other recorded results (${elsewhere.join(", ")}) are graded in separate requests with their own evidence; they are not missing. Return verdicts only for the results below, and write the summary about these results only.`
    : "";
  const paperAbstract = level >= 3 ? compact(abstract, level >= 4 ? 500 : 2_000, "abstract") : abstract || "(none)";
  const paperLogbook = level >= 2
    ? compact(logbook, level >= 4 ? 1_000 : level >= 3 ? 4_000 : 8_000, "logbook")
    : logbook || "(no logbook produced)";
  const shown = new Map<number, string>();
  const evidence = claims.map(result => [
    `### ${result.id} — original cited evidence`,
    citedEvidence(result, toolCalls, level, shown),
  ].join("\n")).join("\n\n");
  return [
    "# PAPER",
    `**Title:** ${title}`,
    `**Abstract:** ${paperAbstract}`,
    "",
    ...(scope ? ["# SCOPE OF THIS REQUEST", scope, ""] : []),
    "# AGENT'S RECORDED RESULTS (proposals, not verdicts)",
    claims.length ? JSON.stringify(claims, null, 2) : "(the agent registered no results)",
    "",
    "# AGENT'S LOGBOOK",
    paperLogbook,
    "",
    "# ORIGINAL CITED TOOL OUTPUTS (server-extracted, before chronological transcript truncation)",
    evidence,
    "",
    "# TOOL TRANSCRIPT (commands and outputs)",
    transcriptForLevel(blocks, level),
  ].join("\n");
}

function requestFor(config: ModelProviderConfig, prompt: string, input: string, maxTokens: number): JudgeRequest {
  return {
    model: config.modelName,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: input },
    ],
    max_tokens: maxTokens,
    temperature: 0.1,
  };
}

function budgetFor(
  config: ModelProviderConfig,
  maxTokens: number,
  observedInputLimit = Number.POSITIVE_INFINITY,
): RequestContextBudget {
  const budget = new RequestContextBudget(
    config,
    maxTokens,
    "reproduction-judge",
    getContextWindow(config),
  );
  if (Number.isFinite(observedInputLimit)) {
    budget.inputLimit = Math.min(budget.inputLimit, observedInputLimit);
  }
  return budget;
}

async function diagnostic(
  onDiagnostic: ((message: string) => Promise<void> | void) | undefined,
  message: string,
): Promise<void> {
  await onDiagnostic?.(message);
}

function judgeContextOverflow(error: unknown): boolean {
  if (isProviderPaymentFailure(error)) return false;
  if (isContextOverflow(error)) return true;
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /context[_\s-]*length[\s\S]{0,80}\d[\s\S]{0,20}>\s*\d+/i.test(text);
}

function reduceJudgeBudget(
  budget: RequestContextBudget,
  error: unknown,
  request: JudgeRequest,
): boolean {
  if (budget.reduce(error, request)) return true;
  // Some SDK wrappers retain only "context_length 35175 > 32768", which is
  // safe to recognize locally even when the shared classifier cannot parse it.
  if (!judgeContextOverflow(error)) return false;
  return budget.reduce(new Error("context length exceeded"), request);
}

function fitsAt(
  config: ModelProviderConfig,
  prompt: string,
  input: string,
  maxTokens: number,
): boolean {
  const budget = budgetFor(config, maxTokens);
  return budget.fits(requestFor(config, prompt, input, maxTokens));
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "unknown error");
  return text.replace(/\s+/g, " ").slice(0, 300);
}

const allResultIds = (opts: RunBoundedReproductionJudgeOptions) => opts.recordedResults.map(result => result.id);

function firstFittingLevel(
  opts: RunBoundedReproductionJudgeOptions,
  claims: RecordedResult[],
  maxTokens: number,
  minimumLevel = 0,
  budget?: RequestContextBudget,
): InputReduction | undefined {
  for (let level = minimumLevel; level <= 4; level++) {
    const input = buildJudgeInput(opts.title, opts.abstract, opts.logbook, claims, opts.toolCalls, level as InputReduction, allResultIds(opts));
    const request = requestFor(opts.config, opts.prompt, input, maxTokens);
    if (budget ? budget.fits(request) : fitsAt(opts.config, opts.prompt, input, maxTokens)) {
      return level as InputReduction;
    }
  }
  return undefined;
}

interface PartitionedGroup {
  claims: RecordedResult[];
  initialLevel: InputReduction;
  contextRetries: number;
}

/**
 * Partition claims without throwing away evidence.  This is done before
 * making model calls so a context failure cannot turn into a self-verdict.
 */
function partitionClaims(
  opts: RunBoundedReproductionJudgeOptions,
  claims: RecordedResult[],
): PartitionedGroup[] {
  const groups: PartitionedGroup[] = [];
  const visit = (group: RecordedResult[]): void => {
    if (group.length > JUDGE_MAX_BATCH_CLAIMS) {
      for (let i = 0; i < group.length; i += JUDGE_MAX_BATCH_CLAIMS) {
        visit(group.slice(i, i + JUDGE_MAX_BATCH_CLAIMS));
      }
      return;
    }
    const maxTokens = initialOutputTokens(opts.config);
    const fittingLevel = firstFittingLevel(opts, group, maxTokens);
    if (fittingLevel !== undefined) {
      groups.push({ claims: group, initialLevel: fittingLevel, contextRetries: 0 });
      return;
    }
    if (group.length > 1) {
      const midpoint = Math.ceil(group.length / 2);
      visit(group.slice(0, midpoint));
      visit(group.slice(midpoint));
      return;
    }
    const input = buildJudgeInput(opts.title, opts.abstract, opts.logbook, group, opts.toolCalls, 4, allResultIds(opts));
    const budget = budgetFor(opts.config, maxTokens);
    const request = requestFor(opts.config, opts.prompt, input, maxTokens);
    try {
      budget.assertFits(request);
    } catch {
      throw new ContextBudgetError(
        `Reproduction judge cannot fit essential evidence (${budget.diagnostic(request)}).`,
      );
    }
    throw new ContextBudgetError(
      `Reproduction judge cannot fit essential evidence (${budget.diagnostic(request)}).`,
    );
  };
  visit(claims);
  return groups;
}

function resultForClaim(result: RecordedResult): ClaimVerdict {
  return {
    id: result.id,
    claim: result.claim,
    verdict: "inconclusive",
    originalValue: result.originalValue,
    reproducedValue: result.reproducedValue,
    evidence: result.evidence,
  };
}

/** Conservative guard for explicit sample-count mismatches, independent of model obedience. */
export function comparisonCountMismatch(claim: string, reproduced: string): boolean {
  const counts = (text: string) => Array.from(text.matchAll(/\b(\d+)[ -]+(?:binary[ -]+)?(?:tasks|samples|participants|observations)\b/gi))
    .map(match => Number(match[1]));
  const expected = counts(claim);
  const actual = counts(reproduced);
  return expected.length === 1 && actual.length === 1 && expected[0] !== actual[0];
}

/** A rounding-only rationale does not establish scientific contradiction. */
export function hasRoundingOnlyRationale(evidence: string): boolean {
  return /\b(?:beyond|exceeds?|exceeding|outside)\s+(?:the\s+)?rounding(?:\s+(?:tolerance|precision))?\b/i.test(evidence);
}

function aggregate(
  recordedResults: RecordedResult[],
  judged: Map<string, ClaimVerdict>,
  toolCalls: readonly ToolCallRecord[],
): ClaimVerdict[] {
  // Iterating the registered list makes the result order stable and also
  // guarantees one row per registered ID, regardless of model output order.
  const seen = new Set<string>();
  return recordedResults.filter(recorded => {
    if (seen.has(recorded.id)) return false;
    seen.add(recorded.id);
    return true;
  }).map(recorded => {
    const proposed = judged.get(recorded.id);
    if (!proposed) return resultForClaim(recorded);
    if (proposed.verdict === "falsified" && hasRoundingOnlyRationale(proposed.evidence ?? "")) {
      return {
        ...resultForClaim(recorded),
        verdict: "inconclusive" as const,
        reproducedValue: proposed.reproducedValue ?? recorded.reproducedValue,
        evidence: `Comparison rejected: exceeding rounding precision alone does not establish a material scientific contradiction. Assess experimental uncertainty and repeatability. Judge rationale requiring reassessment: ${proposed.evidence}`,
      };
    }
    if ((proposed.verdict === "verified" || proposed.verdict === "falsified")
      && comparisonCountMismatch(recorded.claim, proposed.reproducedValue ?? recorded.reproducedValue ?? "")) {
      return {
        ...resultForClaim(recorded),
        verdict: "inconclusive" as const,
        reproducedValue: proposed.reproducedValue ?? recorded.reproducedValue,
        evidence: `Comparison rejected: the reported and reproduced sample/task counts differ. Establish matching conditions before verification or falsification. ${proposed.evidence ?? recorded.evidence ?? ""}`,
      };
    }
    const rejection = proposed.verdict === "falsified" ? falsificationRejection(
      proposed.falsificationAssessment, recorded,
      proposed.reproducedValue ?? recorded.reproducedValue ?? "", toolCalls,
    ) : undefined;
    if (rejection) return {
      ...resultForClaim(recorded),
      verdict: "inconclusive" as const,
      reproducedValue: proposed.reproducedValue ?? recorded.reproducedValue,
      evidence: `Comparison rejected: ${rejection} Judge rationale requiring reassessment: ${proposed.evidence ?? ""}`,
    };
    return {
      ...resultForClaim(recorded),
      verdict: proposed.verdict,
      falsificationAssessment: proposed.falsificationAssessment,
      // These are descriptive judge fields, never the claim identity.
      reproducedValue: proposed.reproducedValue ?? recorded.reproducedValue,
      evidence: proposed.evidence ?? recorded.evidence,
      confidence: proposed.confidence,
    };
  });
}

export async function runBoundedReproductionJudge(
  opts: RunBoundedReproductionJudgeOptions,
): Promise<BoundedReproductionJudgeResult> {
  if (opts.questioning) {
    const q = opts.questioning;
    // Source/change text is reducible like the logbook; phase and comparability
    // obligations remain fixed even when the evidence needs partitioning.
    opts = { ...opts,
      prompt: `${opts.prompt}\n\n${QUESTIONING_JUDGE_PROMPT}\nqP decision: ${q.assessment?.decision ?? "not assessed"}. ${q.changes.length} changes; ${q.executions.length} executions. Evidence omitted by context reduction is NOT endorsement of adaptation.`,
      logbook: `# qP suitability and bounded provenance excerpts\n${q.judgeContext()}\n# Agent logbook\n${opts.logbook}`,
    };
  }
  // Saved retry prompts and custom prompts may predate the current standard;
  // every judged run applies the same verification rule.
  if (!opts.prompt.includes(JUDGE_VERIFICATION_STANDARD)) {
    opts = { ...opts, prompt: `${opts.prompt}\n\n${JUDGE_VERIFICATION_STANDARD}` };
  }
  opts = { ...opts, prompt: `${opts.prompt}\n\n${VERIFICATION_CHECK}` };
  const started = Date.now();
  const seenIds = new Set<string>();
  const recordedResults = opts.recordedResults.filter(result => {
    if (seenIds.has(result.id)) return false;
    seenIds.add(result.id);
    return true;
  });
  if (recordedResults.length === 0) {
    return { summary: "No registered claims were available for judging.", results: [] };
  }

  const groups = partitionClaims(opts, recordedResults);
  const judged = new Map<string, ClaimVerdict>();
  const summaries: string[] = [];
  let observedInputLimit = Number.POSITIVE_INFINITY;

  judgeGroups: for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    const claims = group.claims;
    let maxTokens = initialOutputTokens(opts.config);
    const budget = budgetFor(opts.config, maxTokens, observedInputLimit);
    let level: InputReduction = group.initialLevel;
    let parsed: { summary: string; results: ClaimVerdict[] } | undefined;
    let completed = false;
    let contextRetries = group.contextRetries;
    let consistencyRetry = "";

    while (true) {
      const input = buildJudgeInput(opts.title, opts.abstract, opts.logbook, claims, opts.toolCalls, level, allResultIds(opts))
        + (consistencyRetry ? `\n# CONSISTENCY RECHECK (one attempt only)\n${consistencyRetry}\nReturn all verdicts for this batch again. Do not assume the earlier verdict is correct.` : "");
      const request = requestFor(opts.config, opts.prompt, input, maxTokens);
      try {
        budget.assertFits(request);
      } catch {
        // A local preflight failure is not a provider retry. Select a fitting
        // compact form, or split the batch while preserving every claim.
        const nextLevel = firstFittingLevel(opts, claims, maxTokens, level + 1, budget);
        if (nextLevel !== undefined) {
          level = nextLevel;
          continue;
        }
        if (claims.length > 1) {
          const midpoint = Math.ceil(claims.length / 2);
          const children = [claims.slice(0, midpoint), claims.slice(midpoint)]
            .map(child => ({
              claims: child,
              initialLevel: firstFittingLevel(
                opts,
                child,
                initialOutputTokens(opts.config),
                0,
                budget,
              ) ?? 0,
              contextRetries: contextRetries,
            }));
          groups.splice(groupIndex, 1, ...children);
          groupIndex--;
          break;
        }
        const message = `Reproduction judge cannot fit essential evidence (${budget.diagnostic(request)}).`;
        await diagnostic(opts.onDiagnostic, message);
        throw new ContextBudgetError(message);
      }

      const remaining = JUDGE_TIMEOUT_MS - (Date.now() - started);
      if (remaining <= 0) {
        await diagnostic(opts.onDiagnostic, "Reproduction judge deadline exhausted; remaining claims are inconclusive.");
        summaries.push(`No judged verdict was produced for ${claims.map(claim => claim.id).join(", ")}; claims remain inconclusive.`);
        break;
      }
      try {
        const response = await generateWithConfig(opts.config, opts.prompt, input, {
          maxTokens,
          temperature: 0.1,
          contextRequest: true,
          // A stuck batch must not consume the time belonging to later claims.
          timeoutMs: Math.max(1, Math.min(JUDGE_REQUEST_TIMEOUT_MS,
            Math.floor(remaining / (groups.length - groupIndex)))),
        });
        parsed = parseJudgeOutput(response.content);
        const conflicts = parsed.results.map(verificationConflict).filter(Boolean);
        if (conflicts.length && !consistencyRetry) {
          consistencyRetry = conflicts.join("\n");
          await diagnostic(opts.onDiagnostic, "Judge comparison checks conflict with verdicts; performing one evidence-grounded recheck.");
          continue;
        }
        for (const result of parsed.results) {
          if (result.verdict === "verified" && verificationConflict(result)) {
            result.verdict = "inconclusive";
            result.evidence = `Verification checks remained inconsistent after one recheck. ${result.evidence ?? ""}`;
          }
        }
        if (conflicts.length) {
          parsed.summary = `Consistency warning: ${conflicts.join(" ")} Unresolved checks do not establish verification; individual final verdicts take precedence.\n\n${parsed.summary}`;
        }
        if (parsed.results.length === 0) {
          await diagnostic(opts.onDiagnostic, "Judge returned no parseable claim verdicts; claims remain inconclusive.");
          summaries.push(`The judge returned no parseable verdicts for ${claims.map(claim => claim.id).join(", ")}; claims remain inconclusive.`);
        }
        completed = true;
        break;
      } catch (error) {
        const failureCode = requestFailureCode(error);
        if (failureCode === "SPENDING_CAP" || failureCode === "INVALID_COST") {
          const ids = groups.slice(groupIndex).flatMap(group => group.claims.map(claim => claim.id));
          const message = `Local ${failureCode === "SPENDING_CAP" ? "spending limit reached" : "cost verification failed"}; no further judge requests will be sent. Ungraded claims: ${ids.join(", ")}. These remain inconclusive, not scientifically refuted.`;
          summaries.push(message);
          await diagnostic(opts.onDiagnostic, message);
          break judgeGroups;
        }
        // A provider refusing payment did not grade the experiment. Do not turn
        // a service failure into an inconclusive scientific verdict.
        if (isProviderPaymentFailure(error)) throw error;
        if (judgeContextOverflow(error)) {
          contextRetries++;
          if (contextRetries > MAX_CONTEXT_RETRIES || !reduceJudgeBudget(budget, error, request)) {
            const message = `Reproduction judge exhausted context retries (${budget.diagnostic(request)}).`;
            await diagnostic(opts.onDiagnostic, message);
            throw new ContextBudgetError(message);
          }
          observedInputLimit = Math.min(observedInputLimit, budget.inputLimit);
          const nextLevel = firstFittingLevel(opts, claims, maxTokens, level + 1, budget);
          if (nextLevel === undefined) {
            if (claims.length > 1) {
              const midpoint = Math.ceil(claims.length / 2);
              const children = [claims.slice(0, midpoint), claims.slice(midpoint)]
                .map(child => ({
                  claims: child,
                  initialLevel: firstFittingLevel(
                    opts,
                    child,
                    initialOutputTokens(opts.config),
                    0,
                    budget,
                  ) ?? 0,
                  contextRetries,
                }));
              groups.splice(groupIndex, 1, ...children);
              groupIndex--;
              break;
            }
            const message = `Reproduction judge cannot fit essential evidence after provider reduction (${budget.diagnostic(request)}).`;
            await diagnostic(opts.onDiagnostic, message);
            throw new ContextBudgetError(message);
          }
          level = nextLevel;
          await diagnostic(opts.onDiagnostic, `Judge provider rejected context; retrying with reduced context (${budget.diagnostic(request)}).`);
          continue;
        }
        if (error instanceof ContextBudgetError) throw error;
        if (outputBudgetExhausted(error)) {
          // The model used the whole output budget without finishing its verdicts (reasoning included).
          // Give the same batch more room while the evidence still fits; otherwise split it.
          const raised = Math.min(JUDGE_OUTPUT_CAP, maxTokens * 2);
          // Split multi-claim work immediately instead of paying for repeated
          // reasoning over the same oversized group. Only singletons grow.
          if (claims.length === 1 && raised > maxTokens && budget.raiseOutputReserve(raised, { ...request, max_tokens: raised })) {
            await diagnostic(opts.onDiagnostic, `Judge output budget exhausted at max_tokens=${maxTokens} before the verdicts were complete; retrying ${claims.map(claim => claim.id).join(", ")} with max_tokens=${raised}.`);
            maxTokens = raised;
            continue;
          }
          if (claims.length > 1) {
            const midpoint = Math.ceil(claims.length / 2);
            await diagnostic(opts.onDiagnostic, `Judge output budget exhausted at max_tokens=${maxTokens}; splitting ${claims.length} claims into two batches.`);
            const children = [claims.slice(0, midpoint), claims.slice(midpoint)]
              .map(child => ({
                claims: child,
                initialLevel: firstFittingLevel(opts, child, initialOutputTokens(opts.config), 0, budget) ?? 0,
                contextRetries,
              }));
            groups.splice(groupIndex, 1, ...children);
            groupIndex--;
            break;
          }
        }
        const reason = describeError(error);
        await diagnostic(opts.onDiagnostic, `Judge batch failed (${reason}); its claims remain inconclusive.`);
        summaries.push(`The judge request failed for ${claims.map(claim => claim.id).join(", ")} (${reason}); claims remain inconclusive.`);
        break;
      }
    }

    if (!completed || !parsed) continue;
    if (parsed.summary.trim()) summaries.push(parsed.summary.trim());
    const groupIds = new Set(claims.map(claim => claim.id));
    for (const verdict of parsed.results) {
      // Foreign IDs and duplicate IDs are never allowed to affect a claim.
      if (!groupIds.has(verdict.id) || judged.has(verdict.id)) continue;
      judged.set(verdict.id, verdict);
    }
  }

  const aggregated = aggregate(recordedResults, judged, opts.toolCalls);
  const rejectedComparisons = aggregated.filter(result => result.evidence?.startsWith("Comparison rejected:"));
  return {
    summary: [
      rejectedComparisons.length ? `Comparison safeguard: ${rejectedComparisons.map(result => result.id).join(", ")} remain inconclusive because comparison validity or scientific tolerance was not established; see the individual evidence explanations. Any contrary verdict in the model narrative below is superseded.` : "",
      ...summaries,
    ].filter(Boolean).join("\n\n"),
    results: opts.questioning ? opts.questioning.constrainOriginalVerdicts(aggregated) : aggregated,
    ...(opts.questioning ? { independentAssessmentAvailable: judged.size > 0 } : {}),
  };
}
