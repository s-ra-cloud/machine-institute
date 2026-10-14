import { createHash } from "node:crypto";
import { runToolLoop, type ModelProviderConfig, type ToolCallRecord, type ToolLoopOptions, type ToolLoopResult, type ToolSpec } from "./model-service";
import type { ReproductionSession } from "./reproduction-session";
import type { RecordedResult } from "./prompts/reproduce";
import { describeExtractionCoverage, type ExtractionCoverage } from "./reproduction-extraction";
import { isPlannedEntrypoint, rerunLaunchRefusal } from "./reproduction-entrypoint";
import { executionRecoveryExcerpt, isSupportedRawInputPath, rerunEvidenceIssue } from "./reproduction-stage-evidence";
import { parsePreparationRefusal, parseRepairedSourceRefusal } from "./reproduction-preparation";
import {
  diagnoseExecutionFailure, normalizeShippedPath, PIP_PACKAGE_ALIASES, PLAN_LIMITS, validateExperimentPlan,
  type ExperimentMethod, type PlannedClaim, type PlannedExperiment,
} from "./reproduction-plan";

/**
 * Batch reproduction orchestrator.
 *
 * The model plans every experiment once, the application executes each planned
 * command itself (zero model calls), and the model then assesses the captured
 * output of each experiment in a short, independent stage. Model calls are
 * spent on judgement, not on orchestration, so the 100-call budget covers
 * dozens of claims instead of a handful. Evidence validation, exact excerpts,
 * original tool IDs and the independent judge are unchanged.
 */
export const BATCH_LIMITS = {
  planCalls: 12,
  planCallsQuestioning: 16,
  repairCallsPerExperiment: 8,
  repairCallsTotal: 24,
  deriveCalls: 10,
  assessCallsMin: 3,
  assessCallsMax: 8,
  sweepCalls: 8,
  hostCommands: 40,
  deterministicRepairs: 2,
  inlineOutputChars: 16_000,
  inlineInventoryChars: 9_000,
  inlineReadmeChars: 6_000,
  inlineRawPreviewChars: 1_500,
  assessmentReservePerExperiment: 2,
} as const;

export type BatchPhase = "extraction" | "planning" | "execution" | "repair" | "derivation" | "assessment" | "sweep" | "finalization" | "report" | "complete" | "failed";
type ExperimentStatus = "planned" | "executed" | "failed" | "assessed" | "skipped";

export interface BatchExperiment extends PlannedExperiment {
  status: ExperimentStatus;
  origin: "plan" | "deferred";
  executionIds: number[];
  evidenceId?: number;
  failure?: string;
  /** Set when the model called declare_blocked in the repair stage (blocker kind + explanation). */
  declaredBlocker?: string;
  repairs: string[];
  assessment?: string;
}

export interface BatchControllerSnapshot {
  version: 2;
  phase: BatchPhase;
  calls: number;
  phaseCalls: number;
  hostCommands: number;
  milestones: Array<{ phase: BatchPhase; calls: number }>;
  experiments: Array<{
    id: string; method: ExperimentMethod; status: ExperimentStatus; origin: "plan" | "deferred";
    claimIds: string[]; command?: string; executionIds: number[]; evidenceId?: number; failure?: string; declaredBlocker?: string;
    repairs: string[]; assessment?: string;
  }>;
}

export interface PipelineCheckpoint {
  extraction?: ExtractionCoverage;
  failure?: { phase: string; phaseCalls: number; aggregateCalls: number; reason: string };
  controller: BatchControllerSnapshot;
  claims: Array<{ id: string; claim: string; status: string; evidenceIds: number[] }>;
  outputs: Array<{ id: number; tool: string; sha256: string; error: boolean; origin?: "pre-pipeline" | "host-run" | "agent-tool" }>;
  logbook: string;
}

export interface BatchReproductionInput {
  config: ModelProviderConfig;
  instructions: string;
  tools: ToolSpec[];
  session: ReproductionSession;
  shippedPaths: Set<string>;
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Base loop options. `onToolCall` runs after the session has observed each record. */
  options: ToolLoopOptions;
  extractionCalls: number;
  extraction?: ExtractionCoverage;
  checkpoint?: (value: PipelineCheckpoint) => Promise<void>;
  /** Progress line for the run log when a stage ends before its goal (no secrets, no model prose). */
  log?: (message: string) => Promise<void> | void;
  inventoryPath?: string;
  readmePaths?: string[];
}

const SUBMIT_PLAN_TOOL: ToolSpec = {
  name: "submit_plan",
  description: "Submit the complete experiment plan once: every pending claim assigned to exactly one experiment. The application executes each command itself and then asks you to assess the captured output per experiment. One experiment per command; group every claim that command's output measures.",
  parameters: {
    type: "object", additionalProperties: false, required: ["experiments"],
    properties: {
      experiments: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["method", "claims", "material_paths", "rationale"],
          properties: {
            method: { type: "string", enum: ["rerun", "raw-data-rederived", "toy", "blocked"], description: "rerun: a shipped script prints the measurement (command required). raw-data-rederived: no shipped script prints it but shipped raw observation files allow recomputation (you write that computation later). toy: only a reduced-scale run is feasible. blocked: essential material is not shipped (name it in rationale)." },
            command: { type: "string", maxLength: 1000, description: "rerun (required) / toy (optional): one standalone shipped entrypoint, e.g. python /work/materials/analysis.py [args]. No cd, chaining, pipes or redirection." },
            working_directory: { type: "string", enum: ["/work", "/work/materials"], description: "P only: /work/materials when the script opens relative paths. qP: omit." },
            timeout_seconds: { type: "integer", description: "Optional; default 600, max 900." },
            material_paths: { type: "array", items: { type: "string" }, description: "Shipped files the experiment relies on: the script and the data it reads." },
            raw_inputs: { type: "array", items: { type: "string" }, description: "raw-data-rederived only: shipped raw observation files (csv/tsv/json/jsonl/parquet/npy/npz/pt/pkl), not precomputed summaries." },
            claims: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["claim_id", "measurement"],
                properties: {
                  claim_id: { type: "string" },
                  measurement: { type: "string", minLength: 1, maxLength: 2000, description: "Which printed quantity answers this claim and where it appears in the output." },
                },
              },
            },
            rationale: { type: "string", minLength: 1, maxLength: 2000, description: "Why this method and command measure these claims; for blocked, which required material is missing." },
          },
        },
      },
    },
  },
};

const RECORD_RESULTS_TOOL: ToolSpec = {
  name: "record_results",
  description: "Record final results for the listed claims in one call. Each item follows the record_result evidence contract: method, status, evidence_tool_call_ids naming the cited original execution, an exact evidence_excerpt copied from that output, and reproduced_value occurring inside the excerpt. Items are validated independently; refused items stay pending and can be resubmitted.",
  parameters: {
    type: "object", additionalProperties: false, required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["id", "status", "method", "evidence_tool_call_ids", "evidence_excerpt"],
          properties: {
            id: { type: "string" },
            status: { type: "string", enum: ["verified", "falsified", "toy", "inconclusive"] },
            method: { type: "string", enum: ["rerun", "raw-data-rederived", "toy", "blocked"] },
            reproduced_value: { type: "string", maxLength: 2000, description: "Literal contiguous measurement text copied from evidence_excerpt. Do not round or relabel; explain comparisons in notes." },
            copy_excerpt_to_reproduced_value: { type: "boolean", enum: [true], description: "For a compound measurement or table: set true and omit reproduced_value; the application copies evidence_excerpt verbatim." },
            evidence_tool_call_ids: { type: "array", items: { type: "integer" }, description: "Original run_command IDs (read_file/list_files IDs for missing-material blockers). Never read_tool_result IDs." },
            evidence_excerpt: { type: "string", minLength: 1, maxLength: 6000, description: "Exact contiguous quote from the cited original output containing the measurement (or the error line for a blocker)." },
            evidence: { type: "string", maxLength: 2000, description: "One or two sentences: what was compared and how it matched or differed." },
            notes: { type: "string", maxLength: 2000 },
            blocker_kind: { type: "string", enum: ["oom", "missing-material", "command-error", "timeout"] },
            required_material: { type: "string", maxLength: 500, description: "missing-material only: the paper's wording for the missing input; it must appear in the claim's source quote." },
            raw_input_path: { type: "string", description: "raw-data-rederived only: the raw input path the computation loaded." },
            raw_input_tool_call_id: { type: "integer", description: "raw-data-rederived only: the read_file ID of that raw input listed in the packet." },
          },
        },
      },
    },
  },
};

const DEFER_CLAIMS_TOOL: ToolSpec = {
  name: "defer_claims",
  description: "Move listed claims whose measurement this experiment's output does not contain into a new experiment that runs after the current assessments. Allowed once per claim. Prefer raw-data-rederived when shipped raw data can recompute the quantity; otherwise toy.",
  parameters: {
    type: "object", additionalProperties: false, required: ["claim_ids", "method", "reason"],
    properties: {
      claim_ids: { type: "array", items: { type: "string" } },
      method: { type: "string", enum: ["raw-data-rederived", "toy"] },
      reason: { type: "string", minLength: 1, maxLength: 2000 },
      raw_inputs: { type: "array", items: { type: "string" }, description: "raw-data-rederived: shipped raw observation files." },
      command: { type: "string", maxLength: 1000, description: "toy only: a shipped entrypoint that accepts a reduced-scale argument." },
    },
  },
};

const SUBMIT_FOR_ASSESSMENT_TOOL: ToolSpec = {
  name: "submit_for_assessment",
  description: "Finish this computation stage by citing the successful run_command that printed the measurements. If the computation is impossible with the shipped data, give a limitation instead and omit the ID.",
  parameters: {
    type: "object", additionalProperties: false,
    properties: {
      evidence_tool_call_id: { type: "integer" },
      limitation: { type: "string", minLength: 1, maxLength: 2000 },
    },
  },
};

const DECLARE_BLOCKED_TOOL: ToolSpec = {
  name: "declare_blocked",
  description: "Stop repairing this experiment because its failure is not an environment or path problem that can be fixed safely. The failed output stays available for assessment.",
  parameters: {
    type: "object", additionalProperties: false, required: ["blocker_kind", "explanation"],
    properties: {
      blocker_kind: { type: "string", enum: ["oom", "missing-material", "timeout", "command-error"] },
      explanation: { type: "string", minLength: 1, maxLength: 2000 },
    },
  },
};

const escapeText = (s: string) => s.replace(/[<>]/g, c => c === "<" ? "&lt;" : "&gt;");
const succeeded = (record: Pick<ToolCallRecord, "error" | "result">) => !record.error && /^exit code 0\b/.test(record.result);
/** The command never ran: a pre-execution refusal (preparation guard, launch rules) is not execution evidence. */
const refused = (record: Pick<ToolCallRecord, "result">) => record.result.startsWith("Refused");
const statusLine = (record: Pick<ToolCallRecord, "result">) => record.result.split("\n", 1)[0].slice(0, 120);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Deterministic scaffold; model prose is never required for retaining results. */
export function renderAcceptedLogbook(claims: readonly RecordedResult[], calls: readonly ToolCallRecord[], limitation?: string): string {
  return [
    "## Claims",
    claims.length ? claims.map(c => `- ${escapeText(c.id)}: ${escapeText(c.claim)}\n  Accepted status: ${c.status}; method: ${c.method ?? "not established"}.`).join("\n") : "No claims accepted.",
    "## Reproduction Log",
    calls.filter(c => c.name === "run_command").map(c => `- Command #${c.index}: ${c.error ? "tool failure" : "output captured"}; execution alone is not scientific verification.`).join("\n") || "No commands executed.",
    "## Discrepancies",
    claims.filter(c => c.status === "falsified").map(c => `- ${escapeText(c.id)}: ${escapeText(c.evidence ?? "See accepted evidence record.")}`).join("\n") || "No accepted falsification recorded. This is not proof of agreement.",
    "## Limitations",
    limitation ? escapeText(limitation) : "Accepted statuses are reproducer proposals until independently judged. Supplied results, toy analyses and adaptations do not establish original-result verification.",
    ...claims.filter(c => c.status === "pending" || c.status === "inconclusive" || c.status === "toy")
      .map(c => `- ${escapeText(c.id)}: ${escapeText(c.evidence ?? "Claim not independently verified.")}`),
  ].join("\n\n");
}

export function renderBatchLogbook(input: {
  claims: readonly RecordedResult[];
  calls: readonly ToolCallRecord[];
  experiments: readonly BatchExperiment[];
  modelCalls: number;
  hostCommands: number;
  limitations: string[];
}): string {
  const byId = new Map(input.claims.map(c => [c.id, c]));
  const call = (id: number | undefined) => id === undefined ? undefined : input.calls.find(c => c.index === id);
  const claimLines = input.claims.length ? input.claims.map(c => {
    const original = c.originalValue ? ` original ${escapeText(c.originalValue)}` : "";
    const reproduced = c.reproducedValue ? ` → reproduced ${escapeText(c.reproducedValue.replace(/\s+/g, " ").slice(0, 200))}` : "";
    const evidence = c.evidenceToolCallIds?.length ? ` [evidence #${c.evidenceToolCallIds.join(", #")}]` : "";
    return `- ${escapeText(c.id)} — ${c.status} (${c.method ?? "no method"}):${original}${reproduced}${evidence}\n  ${escapeText(c.claim)}`;
  }).join("\n") : "No claims accepted.";
  const experimentBlocks = input.experiments.length ? input.experiments.map(x => {
    const header = `### ${x.id} — ${x.method}${x.origin === "deferred" ? " (deferred from assessment)" : ""}: ${x.command ? `\`${escapeText(x.command)}\`${x.workingDirectory ? ` (cwd ${x.workingDirectory})` : ""}` : "no planned command"}`;
    const executions = x.executionIds.length
      ? x.executionIds.map(id => { const rec = call(id); return rec ? `#${id} ${escapeText(statusLine(rec))} (${rec.result.length} chars)` : `#${id}`; }).join("; ")
      : "none";
    const outcomes = x.claims.map(c => `${c.claimId}: ${byId.get(c.claimId)?.status ?? "unknown"}`).join(", ");
    return [
      header,
      `Claims: ${x.claims.map(c => c.claimId).join(", ")}. Rationale: ${escapeText(x.rationale)}`,
      `Executions: ${executions}.${x.repairs.length ? ` Repairs: ${escapeText(x.repairs.join("; "))}.` : ""}${x.failure ? ` Failure: ${escapeText(x.failure)}.` : ""}`,
      `Assessment: ${outcomes}.${x.assessment ? ` ${escapeText(x.assessment)}` : ""}`,
    ].join("\n");
  }).join("\n\n") : "No experiments were planned.";
  const discrepancies = input.claims.filter(c => c.status === "falsified")
    .map(c => `- ${escapeText(c.id)}: original ${escapeText(c.originalValue ?? "(unspecified)")} vs reproduced ${escapeText(c.reproducedValue ?? "(unspecified)")} — ${escapeText(c.evidence ?? c.notes ?? "See accepted evidence record.")}`)
    .join("\n") || "No accepted falsification recorded. This is not proof of agreement.";
  const limitations = [
    ...input.limitations.map(escapeText),
    ...input.claims.filter(c => c.status === "pending" || c.status === "inconclusive" || c.status === "toy")
      .map(c => `- ${escapeText(c.id)}: ${escapeText(c.evidence ?? "Claim not independently verified.")}`),
  ];
  return [
    "## Claims",
    claimLines,
    "## Reproduction Log",
    `Application-executed experiment plan: ${input.experiments.length} experiment(s), ${input.hostCommands} host-run command(s), ${input.modelCalls} model tool call(s). Statuses are reproducer proposals until independently judged.\n\n${experimentBlocks}`,
    "## Discrepancies",
    discrepancies,
    "## Limitations",
    limitations.length ? limitations.join("\n") : "Accepted statuses are reproducer proposals until independently judged. Supplied results, toy analyses and adaptations do not establish original-result verification.",
  ].join("\n\n");
}

export async function runBatchReproduction(input: BatchReproductionInput): Promise<ToolLoopResult & { completeReport: () => Promise<void> }> {
  const { session, options } = input;
  const questioning = Boolean(session.questioning);
  const shippedPaths = input.shippedPaths;
  const inventoryPath = input.inventoryPath ?? "/work/MATERIALS_INDEX.md";
  const readmePaths = input.readmePaths ?? Array.from(shippedPaths).filter(path => /(?:^|\/)readme(?:\.[^/]*)?$/i.test(path));
  const started = session.toolCalls.length;
  const hostRunIds = new Set<number>();
  const experiments: BatchExperiment[] = [];
  /** claim id → id of the deferred experiment that now owns it (the original experiment no longer assesses it). */
  const deferredTo = new Map<string, string>();
  const budgetFinalized: string[] = [];
  const installed = new Set<string>();
  const rawReads = new Map<string, ToolCallRecord>();
  const milestones: BatchControllerSnapshot["milestones"] = [];
  let modelCalls = input.extractionCalls;
  let rounds = 0;
  let phaseCalls = 0;
  let hostCommands = 0;
  let repairCallsUsed = 0;
  let deadlineHit = false;
  let phase: BatchPhase = "planning";
  let failure: PipelineCheckpoint["failure"];

  const pendingClaims = () => Array.from(session.recorded.values()).filter(c => c.status === "pending");
  const remainingCalls = () => Math.max(0, options.maxToolCalls - modelCalls);
  const timeLeft = () => options.deadlineMs - Date.now();
  const setPhase = (next: BatchPhase) => { phase = next; phaseCalls = 0; milestones.push({ phase: next, calls: modelCalls }); };
  const snapshot = (): BatchControllerSnapshot => ({
    version: 2, phase, calls: modelCalls, phaseCalls, hostCommands, milestones: [...milestones],
    experiments: experiments.map(x => ({
      id: x.id, method: x.method, status: x.status, origin: x.origin, claimIds: x.claims.map(c => c.claimId),
      command: x.command, executionIds: [...x.executionIds], evidenceId: x.evidenceId, failure: x.failure, declaredBlocker: x.declaredBlocker,
      repairs: [...x.repairs], assessment: x.assessment,
    })),
  });
  const limitationNotes = (): string[] => {
    const notes: string[] = [];
    if (budgetFinalized.length) notes.push(`- System-finalized at the enforced call allowance (inconclusive, no verdict inferred): ${budgetFinalized.join(", ")}.`);
    for (const x of experiments) if (x.status === "failed" || x.status === "skipped") notes.push(`- ${x.id} (${x.method}) ${x.status}: ${x.failure ?? "no execution evidence"}.`);
    if (deadlineHit) notes.push("- The wall-clock deadline stopped remaining experiments.");
    if (input.extraction) notes.push(describeExtractionCoverage(input.extraction));
    return notes;
  };
  const logbook = () => renderBatchLogbook({
    claims: Array.from(session.recorded.values()), calls: session.toolCalls, experiments,
    modelCalls: Math.max(0, modelCalls - input.extractionCalls), hostCommands, limitations: limitationNotes(),
  });
  const save = async () => {
    await input.checkpoint?.({
      extraction: input.extraction,
      failure,
      controller: snapshot(),
      claims: Array.from(session.recorded.values()).map(c => ({ id: c.id, claim: c.claim.slice(0, 400), status: c.status, evidenceIds: c.evidenceToolCallIds ?? [] })),
      outputs: session.toolCalls.map(c => ({
        id: c.index, tool: c.name,
        origin: c.index <= started ? "pre-pipeline" as const : hostRunIds.has(c.index) ? "host-run" as const : "agent-tool" as const,
        sha256: createHash("sha256").update(c.result).digest("hex"), error: c.error,
      })),
      logbook: logbook(),
    });
  };

  /** Application-executed tool call: recorded with a run-wide evidence ID, never charged to the model budget. */
  const hostCall = async (name: string, args: Record<string, unknown>): Promise<ToolCallRecord> => {
    const startedAt = Date.now();
    let result: string;
    let error = false;
    try { result = await input.execute(name, args); }
    catch (err) { result = `Tool error: ${err instanceof Error ? err.message : String(err)}`; error = true; }
    const record: ToolCallRecord = { index: session.toolCalls.length + 1, name, args, result, durationMs: Date.now() - startedAt, error };
    session.observeToolCall(record);
    hostRunIds.add(record.index);
    await options.onToolCall?.(record);
    return record;
  };
  const hostCommand = async (command: string, extra: { working_directory?: string; timeout_seconds?: number } = {}): Promise<ToolCallRecord | undefined> => {
    if (hostCommands >= BATCH_LIMITS.hostCommands) return undefined;
    if (timeLeft() <= 0) { deadlineHit = true; return undefined; }
    hostCommands++;
    const args: Record<string, unknown> = { command };
    if (extra.working_directory) args.working_directory = extra.working_directory;
    if (extra.timeout_seconds) args.timeout_seconds = extra.timeout_seconds;
    return hostCall("run_command", args);
  };
  const runExperimentCommand = async (x: BatchExperiment): Promise<ToolCallRecord | undefined> => {
    const record = await hostCommand(x.command!, { working_directory: x.workingDirectory, timeout_seconds: x.timeoutSeconds });
    if (record) x.executionIds.push(record.index);
    return record;
  };
  const failureSummary = (record: ToolCallRecord) => `${statusLine(record)}: ${executionRecoveryExcerpt(record).split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim().slice(-300)}`;
  const pickTools = (names: readonly string[]) => input.tools.filter(tool => names.includes(tool.name));
  const toolList = (tools: readonly ToolSpec[]) => tools.map(tool => tool.name).join(", ");

  const stageSystem = (text: string) => [
    input.instructions,
    "APPLICATION-OWNED BATCH WORKFLOW: claims were extracted and registered by the application (R-ids are fixed; never register, rename or re-extract claims). The application executes planned commands itself and opens short, independent stages. Follow ONLY the CURRENT STAGE packet and the tools offered in it; older single-loop instructions about registering claims, searching the paper, submit/revision handoffs or returning a logbook do not apply inside a stage. Custom scientific instructions and qP gates remain binding.",
    text,
  ].join("\n\n");

  interface StageSpec {
    name: BatchPhase;
    allowance: number;
    system: string;
    packet: string;
    tools: ToolSpec[];
    execute: (name: string, args: Record<string, unknown>) => Promise<string>;
    isComplete: () => boolean;
    /** proseStops counts answers without a tool call so far; a stage may force its closing tool after one. */
    requiredTool?: (proseStops: number) => string | undefined;
    prematureStop: string;
    /** Prose answers tolerated before the stage ends (default 1); stages without a single closing tool allow more. */
    prematureStopRecoveries?: number;
    onRecord?: (record: ToolCallRecord) => void;
    state: () => string;
  }
  const runStage = async (stage: StageSpec): Promise<ToolLoopResult> => {
    setPhase(stage.name);
    const startCalls = modelCalls;
    const startRounds = rounds;
    let proseStops = 0;
    const outcome = await runToolLoop(input.config, stageSystem(stage.system), stage.packet, stage.tools, stage.execute, {
      ...options,
      maxToolCalls: stage.allowance,
      toolCallIndexOffset: session.toolCalls.length,
      numberToolResults: true,
      stopWithoutFinalResponse: true,
      allowResourceStopFallback: true,
      maxPrematureStopRecoveries: stage.prematureStopRecoveries ?? 1,
      isStageComplete: stage.isComplete,
      getRequiredTool: stage.requiredTool ? () => stage.requiredTool!(proseStops) : undefined,
      getAvailableTools: undefined,
      getStallReason: undefined,
      transformToolResult: undefined,
      getRecoveryProgress: undefined,
      onRequestPrepared: undefined,
      onPrematureStop: () => { proseStops++; return stage.prematureStop; },
      getArgumentRepair: (tool, errors) => `Schema errors for ${tool}: ${errors.join("; ")}. Resubmit ${tool} with exactly the declared fields. Stage state: ${stage.state().slice(0, 1500)}`,
      onOutcome: event => options.onOutcome?.({
        ...event, phase: stage.name, phaseCallCount: event.callCount,
        callCount: startCalls + event.callCount, round: startRounds + event.round,
      }),
      onToolCall: async record => {
        session.observeToolCall(record);
        phaseCalls++;
        modelCalls++;
        stage.onRecord?.(record);
        await options.onToolCall?.(record);
      },
      contextProtection: options.contextProtection ? {
        ...options.contextProtection,
        preserveLatestToolBatch: true,
        getState: (maxBytes = 2500) => stage.state().slice(0, maxBytes),
        getActiveInstruction: () => stage.prematureStop.slice(0, 900),
        compactUserMessage: stage.packet.length > 6000
          ? `${stage.packet.slice(0, 5000)}\n[... packet shortened to fit the request; captured output remains retrievable with read_tool_result ...]`
          : stage.packet,
        resizeRecentToolOutput: (result, bytes) => {
          const index = result.match(/^\[Tool call #(\d+)\]\n/)?.[1];
          if (!index) return undefined;
          const args = { tool_call_id: Number(index), offset: 0, max_chars: 6000 };
          return session.resizeRetrieval("read_tool_result", args, session.readToolResult(args), bytes);
        },
      } : undefined,
    });
    rounds += outcome.rounds;
    // Calls refused for budget are not dispatched; count exactly what the session observed.
    modelCalls = startCalls + outcome.toolCalls.length;
    if (outcome.stoppedBy === "deadline") deadlineHit = true;
    if (!stage.isComplete()) {
      try {
        await input.log?.(`Stage ${stage.name} ended without reaching its goal (${outcome.stoppedBy}${outcome.finishReason ? `, finish_reason=${outcome.finishReason}` : ""}; ${outcome.toolCalls.length}/${stage.allowance} tool calls, ${proseStops} answer(s) without a tool call). State: ${stage.state().slice(0, 300)}`);
      } catch { /* Progress reporting never affects the run. */ }
    }
    return outcome;
  };

  const describeClaim = (claim: RecordedResult, measurement?: string) =>
    `- ${claim.id}${claim.originalValue ? ` (original_value: ${claim.originalValue})` : ""}: ${JSON.stringify(claim.claim.slice(0, 600))}${measurement ? `\n  planned measurement: ${measurement.slice(0, 400)}` : ""}`;

  // ---------------------------------------------------------------- planning
  const planExperiments = async (): Promise<void> => {
    const pending = pendingClaims();
    if (!pending.length) throw new Error("No pending claims were registered before planning.");
    const inventoryRead = await hostCall("read_file", { path: inventoryPath, max_chars: BATCH_LIMITS.inlineInventoryChars });
    // Missing-material blockers must cite inventory and every README read; pre-read them all, inline the first two.
    const readmeReads: ToolCallRecord[] = [];
    for (let position = 0; position < Math.min(readmePaths.length, 6); position++)
      readmeReads.push(await hostCall("read_file", { path: readmePaths[position], max_chars: position < 2 ? BATCH_LIMITS.inlineReadmeChars : 2000 }));
    const allowance = Math.min(questioning ? BATCH_LIMITS.planCallsQuestioning : BATCH_LIMITS.planCalls, remainingCalls());
    if (allowance < 1) throw new Error("System-enforced tool-call budget exhausted before experiment planning.");
    let accepted = false;
    let lastRefusal = "";
    const tools = [...pickTools(["read_file", "list_files", ...(questioning ? ["assess_suitability", "setup_environment"] : [])]), SUBMIT_PLAN_TOOL];
    const scripts = Array.from(shippedPaths).filter(path => /\.(?:py|sh|js|mjs|r|jl)$/i.test(path));
    const data = Array.from(shippedPaths).filter(isSupportedRawInputPath);
    const packet = [
      `CURRENT STAGE: planning. Design the complete experiment plan for the ${pending.length} pending claims below, then call submit_plan once. You have ${allowance} tool calls in this stage; read_file/list_files calls count, and the last call must be submit_plan. Do NOT run commands: the application executes every planned command after the plan is accepted and shows you the captured output for assessment.`,
      questioning ? "qP: call assess_suitability (required before submit_plan) after inspecting the materials. Plan commands of the form python materials/FILE.py [args] without working_directory; adaptation (write_file of planned working copies) happens later, in the repair stage of the affected experiment." : "",
      `## Pending claims\n${pending.map(c => describeClaim(c)).join("\n")}`,
      `## Material inventory (${inventoryPath}, read as #${inventoryRead.index})\n${inventoryRead.result.slice(0, BATCH_LIMITS.inlineInventoryChars)}`,
      ...readmeReads.slice(0, 2).map(read => `## ${String(read.args.path)} (read as #${read.index})\n${read.result.slice(0, BATCH_LIMITS.inlineReadmeChars)}`),
      readmeReads.length > 2 ? `Further README reads: ${readmeReads.slice(2).map(read => `${String(read.args.path)} (#${read.index})`).join(", ")}` : "",
      `## Shipped scripts\n${scripts.length ? scripts.join("\n") : "(none)"}\n## Shipped data files eligible as raw inputs\n${data.length ? data.join("\n") : "(none)"}`,
      [
        "## How to plan",
        "1. Identify which shipped script prints each claim's number (README first; read a script only to confirm what it prints and which files it reads).",
        "2. One experiment per command; list every claim its output measures, each with a measurement description. Prefer analysis/evaluation scripts over long training scripts; set timeout_seconds (max 900) for slow runs.",
        "3. Claims whose numbers no shipped script prints but shipped raw data can recompute: method raw-data-rederived with raw_inputs (you will write the computation after the plan is accepted).",
        "For every claim, establish the matching analysis, dataset, conditions and metric from inspected source or README. A JSON filename is not proof that it contains raw observations. Inspect its structure: precomputed means, accuracies or confidence intervals are summaries, not raw inputs for recomputation. Prefer the matching shipped rerun over extracting stored summary numbers; never substitute results from a different analysis.",
        "4. Claims needing unavailable models, data, GPU-days or external services: method blocked with the missing material named in rationale; use toy only when a reduced-scale run of a shipped script is possible.",
        `Every pending claim must be assigned exactly once. Limits: ${PLAN_LIMITS.maxExperiments} experiments, ${PLAN_LIMITS.maxClaimsPerExperiment} claims per experiment, ${PLAN_LIMITS.maxMaterialPaths} material paths per experiment.`,
      ].join("\n"),
    ].filter(Boolean).join("\n\n");
    const execute = async (name: string, args: Record<string, unknown>): Promise<string> => {
      if (name !== "submit_plan") return input.execute(name, args);
      if (questioning && !session.questioning?.assessment) return "Refused: qP requires assess_suitability before submit_plan.";
      const validation = validateExperimentPlan(args, { pendingClaimIds: pending.map(c => c.id), shippedPaths, questioning, firstExperimentNumber: experiments.length + 1 });
      if (validation.errors) {
        lastRefusal = validation.errors.join("; ");
        const shown = validation.errors.slice(0, 12);
        return `Refused: ${shown.join("; ")}${validation.errors.length > shown.length ? `; and ${validation.errors.length - shown.length} more` : ""}. Resubmit the complete plan.`;
      }
      const suitability = session.questioning?.assessment;
      if (suitability) {
        for (const x of validation.experiments) {
          if (x.claims.length < 2) continue;
          const covered = x.claims.every(c => suitability.claim_ids.includes(c.claimId)
            && (suitability.decision !== "adapt" || suitability.planned_changes?.every(change => change.claim_ids.includes(c.claimId))));
          if (!covered) return `Refused: sharing a qP experiment requires every grouped claim (${x.claims.map(c => c.claimId).join(", ")}) to be covered by the immutable suitability assessment and, for adaptation, every planned change. Keep separately scoped claims in separate experiments.`;
        }
      }
      for (const x of validation.experiments) experiments.push({ ...x, status: "planned", origin: "plan", executionIds: [], repairs: [] });
      accepted = true;
      await save();
      return `Plan accepted: ${validation.experiments.length} experiment(s) covering ${validation.experiments.reduce((n, x) => n + x.claims.length, 0)} claim(s). The application will now execute them.`;
    };
    await runStage({
      name: "planning", allowance, packet, tools, execute,
      system: `STAGE CONTRACT (planning): inspect only what the plan needs, then call submit_plan with every pending claim assigned. Available tools: ${toolList(tools)}.`,
      isComplete: () => accepted,
      requiredTool: (proseStops) => {
        if (accepted) return undefined;
        if (questioning && !session.questioning?.assessment) return proseStops > 0 || phaseCalls >= allowance - 4 ? "assess_suitability" : undefined;
        return proseStops > 0 || phaseCalls >= allowance - 3 ? "submit_plan" : undefined;
      },
      prematureStop: "Call submit_plan with the complete experiment plan; prose is not a plan. Every pending claim must be assigned exactly once.",
      prematureStopRecoveries: 2,
      state: () => JSON.stringify({ stage: "planning", pending: pending.map(c => c.id), accepted, lastRefusal: lastRefusal.slice(0, 600) }),
    });
    if (!accepted) throw new Error(`Planning failed: no valid experiment plan was accepted within ${allowance} model calls${lastRefusal ? ` (last refusal: ${lastRefusal.slice(0, 800)})` : ""}.`);
  };

  // --------------------------------------------------------------- execution
  /**
   * The preparation guard refuses a script that reads-then-rewrites a file until
   * the script (at that function) and the file have been inspected. The host
   * performs those inspections itself; only the judgement — initialize
   * bookkeeping or declare a missing scientific input — is left to the model.
   */
  const satisfyPreparation = async (x: BatchExperiment, failed: ToolCallRecord): Promise<ToolCallRecord | undefined> => {
    const preparation = parsePreparationRefusal(failed.result);
    if (preparation) {
      const key = `preparation ${preparation.functionName}→${preparation.dependency}`;
      if (x.repairs.filter(note => note.startsWith(key)).length >= 2) return undefined;
      const fnRead = await hostCall("read_file", { path: preparation.path, query: `def ${preparation.functionName}`, max_chars: 12_000 });
      const depRead = await hostCall("read_file", { path: preparation.dependency, max_chars: 4_000 });
      const present = depRead.result.startsWith(`Verified file: ${preparation.dependency}\n`);
      x.repairs.push(`${key}: inspected ${preparation.path} (#${fnRead.index}) and ${preparation.dependency} (#${depRead.index}${present ? "" : ", absent"})`);
      return present ? runExperimentCommand(x) : undefined;
    }
    const repaired = parseRepairedSourceRefusal(failed.result);
    if (repaired && !x.repairs.some(note => note === `inspected repaired source ${repaired.path}`)) {
      const read = await hostCall("read_file", { path: repaired.path, max_chars: 12_000 });
      x.repairs.push(`inspected repaired source ${repaired.path}`);
      return read.error ? undefined : runExperimentCommand(x);
    }
    return undefined;
  };

  const deterministicRepair = async (x: BatchExperiment, failed: ToolCallRecord): Promise<ToolCallRecord | undefined> => {
    if (!x.command) return undefined;
    if (refused(failed)) return questioning ? undefined : satisfyPreparation(x, failed);
    if (questioning) return undefined; // qP setup is frozen and sealed; no host-side environment changes.
    const diagnosis = diagnoseExecutionFailure(failed.result, shippedPaths);
    if (diagnosis.kind === "missing-module") {
      if (diagnosis.local) {
        if (x.workingDirectory === "/work/materials") return undefined;
        x.workingDirectory = "/work/materials";
        x.repairs.push(`working_directory=/work/materials (local module ${diagnosis.module})`);
        return runExperimentCommand(x);
      }
      const pkg = PIP_PACKAGE_ALIASES[diagnosis.module] ?? diagnosis.module;
      if (installed.has(pkg)) return undefined;
      installed.add(pkg);
      const pip = await hostCommand(`pip install -q ${pkg}`, { timeout_seconds: 600 });
      if (!pip) return undefined;
      x.repairs.push(`pip install ${pkg} → ${statusLine(pip)} (#${pip.index})`);
      return runExperimentCommand(x);
    }
    if (diagnosis.kind === "missing-file") {
      const alternative = x.workingDirectory === "/work/materials" ? "/work" : "/work/materials";
      if (!diagnosis.path.startsWith("/") && !x.repairs.some(note => note.includes(`working_directory=${alternative}`))) {
        x.workingDirectory = alternative;
        x.repairs.push(`working_directory=${alternative} (relative path ${diagnosis.path})`);
        return runExperimentCommand(x);
      }
      const tail = failed.result.slice(-3000);
      const writing = /(?:open\([^)]*['"]w|savefig|to_csv|to_json|to_parquet|np\.save|torch\.save|json\.dump|\.write_text|\.write\()/.test(tail);
      const directory = diagnosis.path.replace(/\/[^/]*$/, "");
      if (writing && diagnosis.path.startsWith("/work/") && directory && !shippedPaths.has(diagnosis.path) && !x.repairs.some(note => note.includes(`mkdir -p ${directory}`))) {
        const mkdir = await hostCommand(`mkdir -p ${directory}`, { timeout_seconds: 30 });
        if (!mkdir) return undefined;
        x.repairs.push(`mkdir -p ${directory} (output directory, #${mkdir.index})`);
        return runExperimentCommand(x);
      }
    }
    return undefined;
  };

  const reserveAfter = (x: BatchExperiment) => {
    const position = experiments.indexOf(x);
    return experiments.slice(position + 1)
      .filter(other => other.claims.some(c => session.recorded.get(c.claimId)?.status === "pending")).length * BATCH_LIMITS.assessmentReservePerExperiment;
  };

  /** Outcome of the model repair stage: "fixed" (rerun exited 0), "declared" (declare_blocked), or "open" (allowance ended). */
  const repairExperiment = async (x: BatchExperiment, failed: ToolCallRecord): Promise<"fixed" | "declared" | "open"> => {
    const allowance = Math.min(BATCH_LIMITS.repairCallsPerExperiment, BATCH_LIMITS.repairCallsTotal - repairCallsUsed, remainingCalls() - reserveAfter(x) - BATCH_LIMITS.assessmentReservePerExperiment);
    if (allowance < 2) { x.repairs.push("model repair skipped: insufficient call allowance"); return "open"; }
    let fixed = false;
    let declared: string | undefined;
    const tools = [...pickTools(["read_file", "list_files", "read_tool_result", "write_file", "run_command", ...(questioning ? ["setup_environment"] : [])]), DECLARE_BLOCKED_TOOL];
    const preparation = parsePreparationRefusal(failed.result);
    const inspections = session.toolCalls.filter(c => hostRunIds.has(c.index) && c.name === "read_file"
      && (c.args.path === preparation?.path || c.args.path === preparation?.dependency));
    const packet = [
      preparation
        ? `CURRENT STAGE: repair of experiment ${x.id} (${x.method}). The planned command has NOT run yet: the preparation check refuses it until ${preparation.dependency}, which ${preparation.functionName} in ${preparation.path} reads and rewrites, is accounted for. You have ${allowance} tool calls.`
        : `CURRENT STAGE: repair of experiment ${x.id} (${x.method}). The planned command failed. Fix ONLY environment or path problems, then rerun the SAME entrypoint with run_command; the stage ends automatically when a rerun exits 0. You have ${allowance} tool calls.`,
      `Planned command: ${x.command}${x.workingDirectory ? ` (working_directory ${x.workingDirectory})` : ""}\nClaims waiting on it: ${x.claims.map(c => c.claimId).join(", ")}\nRationale: ${x.rationale.slice(0, 600)}`,
      preparation
        ? [
          `Refusal #${failed.index}: ${failed.result.slice(0, 900)}`,
          inspections.length ? `The application already inspected: ${inspections.map(c => `${c.args.path} (#${c.index}${c.result.startsWith("Verified file:") ? "" : ": not readable — absent"})`).join(", ")}. Page them with read_tool_result; do not repeat the reads.` : "",
          `Decide from the inspected function source what ${preparation.dependency} is:`,
          `- Bookkeeping the script maintains itself (history, cache, log): create it with write_file using exactly the schema the code expects (for example {} or []), then read_file it, then rerun the planned command with run_command.`,
          `- A shipped input stored elsewhere: list_files/read_file the shipped copy under /work/materials and write_file it to ${preparation.dependency} unchanged, then read_file it and rerun.`,
          `- A scientific input that is not shipped and cannot be reconstructed: call declare_blocked with blocker_kind missing-material and name the input.`,
          "Never invent measurements, results or data rows to satisfy the schema.",
        ].filter(Boolean).join("\n")
        : `Failing execution #${failed.index}: ${statusLine(failed)}\n--- last 3000 characters ---\n${failed.result.slice(-3000)}`,
      x.repairs.length ? `Repairs already tried by the application: ${x.repairs.join("; ")}` : "",
      questioning
        ? "qP: allowed actions are setup_environment for approved packages and write_file of planned working copies under /work/working/materials with a scientific reason (the write gate applies); then rerun python materials/FILE.py. Do not change analysis logic beyond the assessed adaptation."
        : "Allowed: pip install, creating missing output directories, working_directory=/work/materials, or writing a minimally patched copy of the script under /work/materials (fixing an import or hard-coded path only) and running that copy. Not allowed: changing analysis logic, hardcoding or fabricating results, downloading unavailable data or models.",
      "If the failure is not safely repairable (missing data/model, out of memory, timeout, genuine code error), call declare_blocked with the observed blocker; the failed output remains the evidence for assessment.",
    ].filter(Boolean).join("\n\n");
    const execute = async (name: string, args: Record<string, unknown>): Promise<string> => {
      if (name === "declare_blocked") {
        declared = `${String(args.blocker_kind)}: ${String(args.explanation).slice(0, 600)}`;
        return "Recorded. The repair stage ends; the failed execution output remains available for assessment.";
      }
      if (name === "run_command" && x.method === "rerun") {
        const refusal = rerunLaunchRefusal(String(args.command ?? ""), x.materialPaths, questioning);
        if (refusal) return refusal;
      }
      const result = await input.execute(name, args);
      if (name === "write_file" && !questioning && result.startsWith("Wrote ")) {
        const path = String(args.path ?? "");
        if (/^\/work\/(?:materials|results)\/.+\.(?:py|sh|js|mjs|r|jl)$/i.test(path) && !x.materialPaths.includes(path)) {
          x.materialPaths.push(path);
          x.repairs.push(`model wrote ${path}`);
        }
      }
      return result;
    };
    await runStage({
      name: "repair", allowance, packet, tools, execute,
      system: `STAGE CONTRACT (repair): environment/path repair only, then rerun the planned entrypoint. Available tools: ${toolList(tools)}.`,
      isComplete: () => fixed || Boolean(declared),
      prematureStop: "Either rerun the planned command with run_command after a repair, or call declare_blocked. Prose does not end the stage.",
      prematureStopRecoveries: 2,
      onRecord: record => {
        if (record.name !== "run_command") return;
        const command = String(record.args.command ?? "");
        if (!isPlannedEntrypoint(command, x.materialPaths) && !record.result.startsWith("Refused")) {
          // Diagnostics (pip, ls) are recorded but are not experiment executions.
          if (/^(?:pip|pip3|mkdir|ls|cat|head|nvidia-smi|python3? -c|python3? -m pip)\b/.test(command.trim())) { x.repairs.push(`${command.slice(0, 80)} (#${record.index})`); return; }
        }
        x.executionIds.push(record.index);
        if (succeeded(record) && isPlannedEntrypoint(command, x.materialPaths)) {
          fixed = true;
          x.evidenceId = record.index;
          x.status = "executed";
          if (command !== x.command) x.repairs.push(`rerun as ${command}`);
        }
      },
      state: () => JSON.stringify({ stage: "repair", experiment: x.id, command: x.command, failing: failed.index, repairs: x.repairs.slice(-4), fixed, declared }),
    });
    repairCallsUsed += phaseCalls;
    if (fixed) return "fixed";
    if (declared) { x.failure = declared; x.declaredBlocker = declared; return "declared"; }
    return "open";
  };

  const repairDeterministically = async (x: BatchExperiment, first: ToolCallRecord | undefined): Promise<ToolCallRecord | undefined> => {
    let record = first;
    let attempts = 0;
    while (record && !succeeded(record) && attempts < BATCH_LIMITS.deterministicRepairs) {
      const next = await deterministicRepair(x, record);
      if (!next) break;
      record = next;
      attempts++;
    }
    return record;
  };

  const lastExecution = (x: BatchExperiment) => x.executionIds.length ? session.toolCalls.find(c => c.index === x.executionIds[x.executionIds.length - 1]) : undefined;

  const executeExperiment = async (x: BatchExperiment): Promise<void> => {
    setPhase("execution");
    let record = await repairDeterministically(x, await runExperimentCommand(x));
    if (record && succeeded(record)) { x.status = "executed"; x.evidenceId = record.index; return; }
    x.failure = record ? failureSummary(record) : deadlineHit ? "deadline reached before execution" : "host command allowance reached before execution";
    if (record) {
      const outcome = await repairExperiment(x, record);
      // The model may have satisfied a preparation requirement (e.g. initialized bookkeeping) without a
      // successful rerun; the host completes the mechanical inspections and the run itself.
      const latest = outcome === "open" ? lastExecution(x) : undefined;
      if (latest && refused(latest)) {
        setPhase("execution");
        record = await repairDeterministically(x, latest);
        if (record && succeeded(record)) { x.status = "executed"; x.evidenceId = record.index; return; }
        if (record && record !== latest) x.failure = failureSummary(record);
      }
    }
    if (x.status !== "executed") x.status = "failed";
  };

  // -------------------------------------------------------------- derivation
  const deriveExperiment = async (x: BatchExperiment): Promise<void> => {
    const allowance = Math.min(BATCH_LIMITS.deriveCalls, remainingCalls() - reserveAfter(x) - BATCH_LIMITS.assessmentReservePerExperiment);
    if (allowance < 3) { x.status = "failed"; x.failure = "derivation skipped: insufficient call allowance"; return; }
    setPhase("derivation");
    for (const path of x.rawInputs) {
      if (rawReads.has(path)) continue;
      rawReads.set(path, await hostCall("read_file", { path, max_chars: 3000 }));
    }
    let done = false;
    const script = questioning ? `materials/derive_${x.id}.py` : `/work/results/derive_${x.id}.py`;
    const tools = [...pickTools(["read_file", "list_files", "read_tool_result", "write_file", "run_command", ...(questioning ? ["setup_environment"] : [])]), SUBMIT_FOR_ASSESSMENT_TOOL];
    const packet = [
      `CURRENT STAGE: computation for experiment ${x.id} (${x.method}). Write and run the claim-specific computation. The application submits a successful execution of the requested script for assessment automatically; no closing tool call is needed. You have ${allowance} tool calls. Use submit_for_assessment to declare an evidenced limitation if computation is impossible.`,
      `Claims and planned measurements:\n${x.claims.map(c => describeClaim(session.recorded.get(c.claimId)!, c.measurement)).join("\n")}\nRationale: ${x.rationale.slice(0, 600)}`,
      x.rawInputs.length ? `Raw inputs (already read by the application; cite these read IDs later as raw_input_tool_call_id):\n${x.rawInputs.map(path => {
        const read = rawReads.get(path)!;
        return `- ${path} — read #${read.index}\n${read.result.split("\n").slice(3).join("\n").slice(0, BATCH_LIMITS.inlineRawPreviewChars)}`;
      }).join("\n")}` : `Materials: ${x.materialPaths.join(", ") || "(none listed)"}`,
      x.command ? `Planned command: ${x.command}` : "",
      x.method === "raw-data-rederived"
        ? `Write ${script} with write_file: load each raw input by its exact path above, print the loaded path, and print each measurement on its own line labelled with the claim id (for example "R5 mean=4.169"). Recompute from the raw rows; copying precomputed summary values is not re-derivation. Run it with run_command: python ${script}.`
        : `Write ${script} (or run the planned command) for a reduced-scale run of the shipped analysis; print each measurement labelled with its claim id and state the reduced scale. Run it with run_command: python ${script}.`,
      questioning ? "qP: write_file requires a scientific reason and a planned working path under /work/working/materials; run python materials/FILE.py without working_directory." : "P: outputs belong under /work/results.",
      "If the shipped data cannot support the computation, call submit_for_assessment with a limitation and no ID; do not invent data.",
    ].filter(Boolean).join("\n\n");
    const execute = async (name: string, args: Record<string, unknown>): Promise<string> => {
      if (name !== "submit_for_assessment") return input.execute(name, args);
      const id = args.evidence_tool_call_id;
      if (typeof id === "number") {
        const record = session.toolCalls.find(c => c.index === id && c.name === "run_command");
        if (!record || !x.executionIds.includes(id)) return `Refused: #${id} is not a run_command executed in this stage.`;
        if (!succeeded(record)) return `Refused: #${id} did not exit 0; repair the computation and rerun, or submit a limitation.`;
        if (x.method === "raw-data-rederived" && !x.rawInputs.some(path => String(record.args.command ?? "").includes(path) || record.result.includes(path)))
          return `Refused: neither the command nor the output of #${id} names a raw input path (${x.rawInputs.join(", ")}). Print the loaded path and rerun.`;
        x.evidenceId = id;
        x.status = "executed";
        done = true;
        return "Computation accepted for assessment.";
      }
      if (typeof args.limitation === "string" && args.limitation.trim()) {
        x.failure = args.limitation.trim().slice(0, 600);
        x.status = "failed";
        done = true;
        return "Limitation recorded; the claims will be assessed with the available evidence.";
      }
      return "Refused: supply evidence_tool_call_id of the successful computation or a limitation.";
    };
    await runStage({
      name: "derivation", allowance, packet, tools, execute,
      system: `STAGE CONTRACT (computation): write the claim-specific computation and run it. Successful execution is submitted automatically for assessment, not automatically verified. Available tools: ${toolList(tools)}.`,
      isComplete: () => done,
      // Do not force submission before a successful execution: that locks out
      // write_file/run_command repairs and can repeat refusals until the round cap.
      prematureStop: "Run the computation with run_command, or submit an evidenced limitation; prose does not end the stage.",
      prematureStopRecoveries: 2,
      onRecord: record => {
        if (record.name !== "run_command" || record.result.startsWith("Refused")) return;
        x.executionIds.push(record.index);
        const command = String(record.args.command ?? "").trim();
        const expected = `python ${script}`;
        const runsComputation = command === expected || command === `python3 ${script}`
          || Boolean(x.command && command === x.command);
        const namesInput = x.method !== "raw-data-rederived"
          || x.rawInputs.some(path => command.includes(path) || record.result.includes(path));
        if (runsComputation && succeeded(record) && namesInput) {
          x.evidenceId = record.index;
          x.status = "executed";
          done = true;
          x.repairs.push(`automatically submitted successful computation #${record.index} for assessment`);
        }
      },
      state: () => JSON.stringify({ stage: "derivation", experiment: x.id, claims: x.claims.map(c => c.claimId), executions: x.executionIds.slice(-4), done }),
    });
    if (done) return;
    const last = [...x.executionIds].reverse().map(id => session.toolCalls.find(c => c.index === id)).find(record => record && succeeded(record)
      && (x.method !== "raw-data-rederived" || x.rawInputs.some(path => String(record.args.command ?? "").includes(path) || record.result.includes(path))));
    if (last) { x.evidenceId = last.index; x.status = "executed"; x.repairs.push(`auto-submitted #${last.index} after the computation allowance ended`); return; }
    x.status = "failed";
    x.failure = x.failure ?? "computation allowance ended without a submitted successful run";
  };

  // -------------------------------------------------------------- assessment
  const finalizeAtAllowance = (claim: RecordedResult, reason: string) => {
    claim.status = "inconclusive";
    claim.method = "blocked";
    claim.blockerKind = "budget";
    claim.evidenceToolCallIds = [];
    claim.evidenceExcerpt = undefined;
    claim.reproducedValue = undefined;
    claim.evidence = deadlineHit
      ? "System-enforced deadline exhaustion prevented further claim-specific testing."
      : `System-enforced tool-call budget exhaustion (${reason}) prevented further claim-specific testing.`;
    claim.notes = "Finalized by the application at its enforced allowance; no scientific verdict is inferred.";
    budgetFinalized.push(claim.id);
  };

  const inlineOutput = (record: ToolCallRecord) => {
    const total = record.result.length;
    const shown = record.result.slice(0, BATCH_LIMITS.inlineOutputChars);
    return `## Captured output of #${record.index} (${total > shown.length ? `first ${shown.length} of ${total}` : `${total}`} characters)\n${shown}${total > shown.length ? `\n[... ${total - shown.length} more characters: read_tool_result(tool_call_id=${record.index}, offset=${shown.length}) ...]` : ""}`;
  };

  const assessClaims = async (spec: {
    name: "assessment" | "sweep";
    experiment?: BatchExperiment;
    claims: PlannedClaim[];
    allowance: number;
    methodFor: (item: Record<string, unknown>) => ExperimentMethod | undefined;
    materialPathsFor: (item: Record<string, unknown>) => string[];
    packet: string;
    allowDefer: boolean;
  }): Promise<void> => {
    const claimIds = new Set(spec.claims.map(c => c.claimId));
    // A deferred claim is assessed by the experiment it moved to; the sweep (no experiment) sees every pending claim.
    const movedAway = (id: string) => spec.experiment !== undefined && deferredTo.has(id) && deferredTo.get(id) !== spec.experiment.id;
    const isPending = (id: string) => session.recorded.get(id)?.status === "pending" && !movedAway(id);
    const outstanding = () => spec.claims.map(c => c.claimId).filter(isPending);
    const tools = [RECORD_RESULTS_TOOL, ...pickTools(["read_tool_result", "read_file", "list_files"]), ...(spec.allowDefer ? [DEFER_CLAIMS_TOOL] : [])];
    const execute = async (name: string, args: Record<string, unknown>): Promise<string> => {
      if (name === "record_results") {
        const items = Array.isArray(args.results) ? args.results as Record<string, unknown>[] : [];
        if (!items.length || items.length > PLAN_LIMITS.maxClaimsPerExperiment) return `Refused: results must contain 1-${PLAN_LIMITS.maxClaimsPerExperiment} items.`;
        const responses: string[] = [];
        for (let item of items) {
          const id = typeof item.id === "string" ? item.id : "";
          if (!claimIds.has(id)) { responses.push(`${id || "(missing id)"}: Refused: not a claim of this stage.`); continue; }
          if (movedAway(id)) { responses.push(`${id}: Refused: deferred to experiment ${deferredTo.get(id)}; it is assessed there.`); continue; }
          if (item.copy_excerpt_to_reproduced_value === true) {
            if (item.reproduced_value !== undefined) { responses.push(`${id}: Refused: omit reproduced_value when copy_excerpt_to_reproduced_value is true.`); continue; }
            if (typeof item.evidence_excerpt !== "string" || !item.evidence_excerpt.trim()) { responses.push(`${id}: Refused: evidence_excerpt is required for the copy flag.`); continue; }
            item = { ...item, reproduced_value: item.evidence_excerpt };
          }
          const { copy_excerpt_to_reproduced_value: _copy, ...payload } = item;
          const expected = spec.methodFor(item);
          if (payload.method !== "blocked" && payload.method !== expected) {
            responses.push(`${id}: Refused: method ${String(payload.method)} differs from the experiment method ${expected ?? "(unknown for the cited evidence)"}; cite this experiment's execution, use blocked for a failed/missing experiment, or defer_claims for a different experiment.`);
            continue;
          }
          if (payload.method === "rerun") {
            const issue = rerunEvidenceIssue(session.toolCalls, spec.materialPathsFor(item), payload);
            if (issue) { responses.push(`${id}: Refused: ${issue}`); continue; }
          }
          responses.push(`${id}: ${session.recordResult(payload).slice(0, 700)}`);
        }
        const left = outstanding();
        return `${responses.join("\n")}\n${left.length ? `Still pending in this stage: ${left.join(", ")}.` : "All claims of this stage are recorded."}`;
      }
      if (name === "defer_claims" && spec.experiment) {
        const x = spec.experiment;
        const ids = Array.isArray(args.claim_ids) ? args.claim_ids.filter((id): id is string => typeof id === "string") : [];
        const invalid = ids.filter(id => !claimIds.has(id) || !isPending(id));
        if (!ids.length || invalid.length) return `Refused: claim_ids must name pending claims of this experiment${invalid.length ? ` (invalid: ${invalid.join(", ")})` : ""}.`;
        if (experiments.length >= PLAN_LIMITS.maxExperiments) return "Refused: the experiment limit is reached; record these claims with the available evidence.";
        const method = args.method as ExperimentMethod;
        const rawInputs = Array.isArray(args.raw_inputs) ? args.raw_inputs.filter((p): p is string => typeof p === "string").map(normalizeShippedPath) : [];
        const badRaw = rawInputs.filter(path => !shippedPaths.has(path) || !isSupportedRawInputPath(path));
        if (method === "raw-data-rederived" && (!rawInputs.length || badRaw.length)) return `Refused: raw-data-rederived requires shipped raw data files in raw_inputs${badRaw.length ? ` (not eligible: ${badRaw.join(", ")})` : ""}.`;
        const materialPaths = Array.from(new Set([...x.materialPaths, ...rawInputs]));
        const command = typeof args.command === "string" && args.command.trim() ? args.command.trim() : undefined;
        if (command && !isPlannedEntrypoint(command, materialPaths)) return "Refused: command must launch a shipped entrypoint listed for this experiment, without cd, chaining, pipes or redirection.";
        const deferred: BatchExperiment = {
          id: `X${experiments.length + 1}`, method, command, workingDirectory: x.workingDirectory, timeoutSeconds: x.timeoutSeconds,
          materialPaths, rawInputs, claims: x.claims.filter(c => ids.includes(c.claimId)), rationale: String(args.reason).slice(0, PLAN_LIMITS.maxText),
          status: "planned", origin: "deferred", executionIds: [], repairs: [],
        };
        experiments.push(deferred);
        for (const id of ids) deferredTo.set(id, deferred.id);
        await save();
        const left = outstanding();
        return `Deferred ${ids.join(", ")} to experiment ${deferred.id} (${method}); it runs after the current assessments. ${left.length ? `Record the remaining claims now: ${left.join(", ")}.` : "No claims remain in this stage."}`;
      }
      return input.execute(name, args);
    };
    await runStage({
      name: spec.name, allowance: spec.allowance, packet: spec.packet, tools, execute,
      system: `STAGE CONTRACT (${spec.name}): compare the captured output with each listed claim and record every claim with record_results. Available tools: ${toolList(tools)}.`,
      isComplete: () => outstanding().length === 0,
      // A prose answer means the analysis exists but was not recorded: from then on only record_results is offered,
      // so the verdicts land in the session instead of ending the stage with every claim still pending.
      requiredTool: proseStops => outstanding().length && (proseStops > 0 || phaseCalls >= spec.allowance - 1) ? "record_results" : undefined,
      prematureStop: `Call record_results for the pending claims (${outstanding().join(", ")}); prose is not a recorded result and is not saved. Put each verdict, its evidence_tool_call_ids and an exact evidence_excerpt into the record_results arguments now (one call may carry all claims).`,
      state: () => JSON.stringify({ stage: spec.name, experiment: spec.experiment?.id, pending: outstanding(), evidence: spec.experiment?.evidenceId, failing: spec.experiment?.executionIds.slice(-1) }),
    });
  };

  const assessExperiment = async (x: BatchExperiment): Promise<void> => {
    const owner = (claimId: string) => deferredTo.get(claimId) ?? x.id;
    const claims = x.claims.filter(c => session.recorded.get(c.claimId)?.status === "pending" && owner(c.claimId) === x.id);
    if (!claims.length) { x.status = x.status === "planned" ? "skipped" : x.status; return; }
    const cap = clamp(2 + claims.length, BATCH_LIMITS.assessCallsMin, BATCH_LIMITS.assessCallsMax);
    const allowance = Math.min(cap, remainingCalls() - reserveAfter(x));
    if (allowance < 2 || deadlineHit || timeLeft() <= 0) {
      if (timeLeft() <= 0) deadlineHit = true;
      for (const c of claims) finalizeAtAllowance(session.recorded.get(c.claimId)!, `assessment allowance for ${x.id}`);
      x.assessment = "no assessment allowance remained; claims finalized by the application";
      return;
    }
    const evidence = x.evidenceId !== undefined ? session.toolCalls.find(c => c.index === x.evidenceId) : undefined;
    const latest = evidence ? undefined : lastExecution(x);
    // A pre-execution refusal is not an execution: it cannot be cited as a command failure.
    const failed = latest && !refused(latest) ? latest : undefined;
    if (!evidence && !failed && x.command && !x.declaredBlocker) {
      // The planned command never ran and the model did not declare a scientific blocker: no model call can
      // produce evidence for these claims, so the application finalizes them instead of spending the allowance.
      for (const c of claims) finalizeAtAllowance(session.recorded.get(c.claimId)!, `repair allowance for ${x.id} ended with its planned command never executed: ${(x.failure ?? "no execution").slice(0, 200)}`);
      x.status = "assessed";
      x.assessment = "planned command never executed; claims finalized by the application";
      return;
    }
    const inventoryRead = session.toolCalls.find(c => c.name === "read_file" && c.args.path === inventoryPath && !c.error);
    const readmeRead = session.toolCalls.find(c => c.name === "read_file" && readmePaths.includes(String(c.args.path)) && !c.error);
    const suggestedBlocker = failed ? (/^TIMED OUT/.test(failed.result) ? "timeout" : /\b(?:out of memory|oom)\b/i.test(failed.result) ? "oom" : "command-error") : undefined;
    const provenanceIds = inventoryRead || readmeRead ? ` (${[inventoryRead, readmeRead].filter(Boolean).map(c => `#${c!.index}`).join(", ")})` : "";
    const packet = [
      `CURRENT STAGE: assessment of experiment ${x.id} (${x.method}${x.origin === "deferred" ? ", deferred" : ""}). Record every claim listed below with record_results (one call can carry all of them). You have ${allowance} tool calls; the last one must be record_results. Page beyond the inline output with read_tool_result(tool_call_id, offset).`,
      [
        "## Experiment",
        `${x.method}${x.command ? ` — command: ${x.command}${x.workingDirectory ? ` (cwd ${x.workingDirectory})` : ""}` : " — model-written computation"}`,
        `Rationale: ${x.rationale.slice(0, 800)}`,
        evidence ? `Successful execution #${evidence.index}: ${statusLine(evidence)}; ${evidence.result.length} characters captured.`
          : failed ? `Execution FAILED (${x.failure ?? "see output"}). Last failing execution #${failed.index}: ${statusLine(failed)}.`
            : `No execution was performed: ${x.failure ?? x.rationale.slice(0, 400)}`,
        x.repairs.length ? `Repairs applied: ${x.repairs.join("; ")}` : "",
      ].filter(Boolean).join("\n"),
      evidence ? inlineOutput(evidence) : failed ? `## Captured output of failing #${failed.index} (last 4000 characters)\n${failed.result.slice(-4000)}` : "",
      `## Claims to record\n${claims.map(c => describeClaim(session.recorded.get(c.claimId)!, c.measurement)).join("\n")}`,
      [
        "## Recording rules",
        evidence
          ? `- Measured by this output: method ${x.method}; evidence_tool_call_ids [${evidence.index}]; evidence_excerpt an exact contiguous quote from that output containing the reproduced value (reproduced_value must occur inside it, or set copy_excerpt_to_reproduced_value=true for a table). verified = matches the original within a reasonable tolerance: rounding, reported precision, or the small run-to-run variation expected from stochastic or GPU computation when the paper's statement (sign, magnitude, significance) still holds; falsified = materially different, i.e. the difference changes what the paper states (state both values in evidence); inconclusive = the output does not settle it (explain).${x.method === "toy" ? " toy method requires status toy." : ""}`
          : failed
            ? `- The experiment failed: record each claim as status inconclusive, method blocked, blocker_kind ${suggestedBlocker}, evidence_tool_call_ids [${failed.index}], evidence_excerpt an exact error line from that output, and evidence explaining the ${suggestedBlocker === "oom" ? "memory" : suggestedBlocker === "timeout" ? "timeout" : "error"}.`
            : `- Nothing executed: record each claim as inconclusive with method blocked and blocker_kind missing-material, citing read_file of ${inventoryPath}${inventoryRead ? ` (#${inventoryRead.index})` : ""}${readmeRead ? ` and the README (#${readmeRead.index})` : ""} plus a list_files/read_file output showing the absence; required_material must use the claim's own wording from its source quote.`,
        x.method === "raw-data-rederived" && x.rawInputs.length ? `- raw-data-rederived items need raw_input_path and raw_input_tool_call_id: ${x.rawInputs.map(path => `${path} → #${rawReads.get(path)?.index ?? "?"}`).join(", ")}.` : "",
        x.origin === "plan" ? `- If this output does not contain a claim's measurement, do not guess: defer_claims to raw-data-rederived (naming shipped raw files) or toy. If it can never be measured with shipped materials, record it inconclusive with method blocked and blocker_kind missing-material citing the inventory/README reads${provenanceIds} plus proof of absence: a read_file of the path where the material would live (its 'File not found' line is the excerpt) or a list_files of a directory that does not exist. A successful execution or a listing of an existing directory cannot support a blocked result.` : "- Deferred claims cannot be deferred again; record them with the available evidence.",
        "- Never cite read_tool_result IDs as evidence; cite the original execution ID.",
      ].filter(Boolean).join("\n"),
    ].filter(Boolean).join("\n\n");
    await assessClaims({
      name: "assessment", experiment: x, claims, allowance, packet,
      methodFor: () => x.method,
      materialPathsFor: () => x.materialPaths,
      allowDefer: x.origin === "plan" && experiments.length < PLAN_LIMITS.maxExperiments,
    });
    x.status = "assessed";
    x.assessment = x.claims.map(c => `${c.claimId}=${owner(c.claimId) !== x.id ? `deferred to ${owner(c.claimId)}` : session.recorded.get(c.claimId)?.status}`).join(" ");
  };

  const sweep = async (): Promise<void> => {
    const pending = pendingClaims();
    if (!pending.length || deadlineHit || timeLeft() <= 0 || remainingCalls() < 2) return;
    const allowance = Math.min(BATCH_LIMITS.sweepCalls, remainingCalls());
    const byExecution = new Map<number, BatchExperiment>();
    for (const x of experiments) for (const id of x.executionIds) byExecution.set(id, x);
    const executions = session.toolCalls.filter(c => c.name === "run_command" && !c.error && !/^Refused/.test(c.result));
    const planned = experiments.flatMap(x => x.claims).filter(c => pending.some(p => p.id === c.claimId));
    const claims: PlannedClaim[] = pending.map(p => planned.find(c => c.claimId === p.id) ?? { claimId: p.id, measurement: "(no planned measurement)" });
    const packet = [
      `CURRENT STAGE: final sweep. ${pending.length} claim(s) remain pending after all experiments. Record each with record_results using existing evidence only; you have ${allowance} tool calls and the last one must be record_results. No new experiments can run.`,
      `## Executions available as evidence\n${executions.map(c => `- #${c.index} (${byExecution.get(c.index)?.id ?? "repair/diagnostic"}, ${byExecution.get(c.index)?.method ?? "n/a"}): ${String(c.args.command ?? "").slice(0, 120)} → ${statusLine(c)}; ${c.result.length} chars; retrieve with read_tool_result(tool_call_id=${c.index})`).join("\n") || "(none)"}`,
      `## Claims to record\n${claims.map(c => describeClaim(session.recorded.get(c.claimId)!, c.measurement)).join("\n")}`,
      "## Recording rules\n- Cite the execution that actually measured the claim; the method must be that experiment's method (or blocked, citing a failed execution or the inventory/README reads for missing material). Claims without any supporting evidence are finalized by the application as inconclusive when the stage ends; do not fabricate support.",
    ].join("\n\n");
    await assessClaims({
      name: "sweep", claims, allowance, packet, allowDefer: false,
      methodFor: item => {
        const ids = Array.isArray(item.evidence_tool_call_ids) ? item.evidence_tool_call_ids as number[] : [];
        return ids.map(id => byExecution.get(id)).find(Boolean)?.method;
      },
      materialPathsFor: item => {
        const ids = Array.isArray(item.evidence_tool_call_ids) ? item.evidence_tool_call_ids as number[] : [];
        return ids.map(id => byExecution.get(id)).find(Boolean)?.materialPaths ?? [];
      },
    });
  };

  const result = (): ToolLoopResult => ({
    content: logbook(),
    toolCalls: session.toolCalls.slice(started),
    rounds,
    stoppedBy: deadlineHit ? "deadline" : budgetFinalized.length ? "tool-budget" : "model",
  });

  try {
    await save();
    await planExperiments();
    for (let cursor = 0; cursor < experiments.length; cursor++) {
      const x = experiments[cursor];
      if (timeLeft() <= 0) deadlineHit = true;
      if (!deadlineHit) {
        if (x.method === "blocked") x.status = "planned";
        else if (x.command) await executeExperiment(x);
        else await deriveExperiment(x);
      } else if (x.status === "planned") {
        x.failure = x.failure ?? "deadline reached before execution";
      }
      await assessExperiment(x);
      await save();
    }
    await sweep();
    setPhase("finalization");
    for (const claim of pendingClaims()) finalizeAtAllowance(claim, "all stage allowances consumed");
    await save();
    const final = result();
    return {
      ...final,
      completeReport: async () => {
        setPhase("report");
        await save();
        setPhase("complete");
        await save();
      },
    };
  } catch (error) {
    failure = { phase, phaseCalls, aggregateCalls: modelCalls, reason: error instanceof Error ? error.message : String(error) };
    setPhase("failed");
    try { await save(); } catch { /* The original failure is more informative than a checkpoint failure. */ }
    throw error;
  }
}
