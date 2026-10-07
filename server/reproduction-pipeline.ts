import { createHash } from "node:crypto";
import { rerunLaunchRefusal } from "./reproduction-entrypoint";
import { executionEvidenceIndex, executionRecoveryExcerpt, rerunEvidenceIssue, repeatExecutionRefusal } from "./reproduction-stage-evidence";
import { runToolLoop, type ModelProviderConfig, type ToolSpec, type ToolLoopOptions, type ToolLoopResult } from "./model-service";
import { ReproductionController, renderAcceptedLogbook, type ExperimentPlan } from "./reproduction-controller";
import type { ReproductionSession } from "./reproduction-session";
import { ContextBudgetError, estimateRequestTokens } from "./llm-context";
import { describeExtractionCoverage, type ExtractionCoverage } from "./reproduction-extraction";
import { PlanningRecovery } from "./reproduction-planning-recovery";

const controls: ToolSpec[] = [
  { name: "submit_plan", description: "Commit a claim-specific plan using actual shipped paths. Code controls the next stage; qP assessment is additionally required.",
    parameters: { type: "object", additionalProperties: false, required: ["claimId", "method", "materialPaths", "measurement", "rationale"],
      properties: { claimId: { type: "string" }, method: { type: "string", enum: ["rerun", "raw-data-rederived", "toy", "blocked"] },
        materialPaths: { type: "array", items: { type: "string" } }, measurement: { type: "string" }, rationale: { type: "string" } } } },
  { name: "submit_for_assessment", description: "Finish execution and assess the captured outputs. No verdict is granted by this transition.",
    parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "request_plan_revision", description: "Return to planning with the reason and intended scientific method. No verdict is granted. At most two revisions per claim within the unchanged global budget.",
    parameters: { type: "object", required: ["reason", "method"], properties: {
      reason: { type: "string", minLength: 1, maxLength: 2000 },
      method: { type: "string", enum: ["rerun", "raw-data-rederived", "toy", "blocked"] },
    }, additionalProperties: false } },
];
export interface PipelineCheckpoint {
  revisions?: Array<{ claimId: string; reason: string; method: ExperimentPlan["method"]; previousPlan?: ExperimentPlan }>;
  planningRecovery?: Array<{ claimId: string; firstStallCall: number; aggregateCall: number; outcome: string }>;
  failure?: { phase: string; phaseCalls: number; aggregateCalls: number; reason: string };
  extraction?: ExtractionCoverage;
  controller: ReturnType<ReproductionController["snapshot"]>;
  claims: Array<{ id: string; claim: string; status: string; evidenceIds: number[] }>;
  outputs: Array<{ id: number; tool: string; sha256: string; error: boolean }>;
  logbook: string;
}
export async function runControlledReproduction(input: {
  config: ModelProviderConfig; instructions: string; tools: ToolSpec[];
  session: ReproductionSession; shippedPaths: Set<string>;
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
  options: ToolLoopOptions; extractionCalls: number;
  extraction?: ExtractionCoverage;
  checkpoint?: (value: PipelineCheckpoint) => Promise<void>;
}): Promise<ToolLoopResult & { completeReport: () => Promise<void> }> {
  const controller = new ReproductionController(input.options.deadlineMs, input.options.maxToolCalls);
  controller.startExtraction();
  controller.calls = input.extractionCalls;
  let calls = input.extractionCalls;
  let rounds = 0;
  const started = input.session.toolCalls.length;
  const planningRecovery: NonNullable<PipelineCheckpoint["planningRecovery"]> = [];
  const revisions: NonNullable<PipelineCheckpoint["revisions"]> = [];
  let failure: PipelineCheckpoint["failure"];
  const save = async (limitation?: string) => {
    await input.checkpoint?.({
      revisions: structuredClone(revisions),
      extraction: input.extraction,
      planningRecovery, failure,
      controller: controller.snapshot(),
      claims: Array.from(input.session.recorded.values()).map(c => ({ id: c.id, claim: c.claim, status: c.status, evidenceIds: c.evidenceToolCallIds ?? [] })),
      outputs: input.session.toolCalls.map(c => ({ id: c.index, tool: c.name,
        sha256: createHash("sha256").update(c.result).digest("hex"), error: c.error })),
      logbook: renderAcceptedLogbook(Array.from(input.session.recorded.values()), input.session.toolCalls, [limitation, input.extraction && describeExtractionCoverage(input.extraction)].filter(Boolean).join("\n\n")),
    });
  };
  try {
    for (const initial of Array.from(input.session.recorded.values())) {
      controller.beginClaim(initial);
      while (input.session.recorded.get(initial.id)?.status === "pending") {
        if (calls >= input.options.maxToolCalls || Date.now() >= input.options.deadlineMs)
          throw new Error("System-enforced global reproduction budget exhausted.");
        const phase = controller.phase;
        const recovery = phase === "planning" ? new PlanningRecovery() : undefined;
        const stageStartCalls = calls;
        let stageCalls = 0;
        let executionNavigationCalls = 0;
        const executionOutputs = new Set<string>();
        let repeatedExecutionOutputs = 0;
        let recoveryRecord: (typeof planningRecovery)[number] | undefined;
        const activeInstruction = () => recovery
          ? recovery.instruction(Math.max(0, 12 - stageCalls), Math.max(0, input.options.maxToolCalls - stageStartCalls - stageCalls), Boolean(input.session.questioning))
          : phase === "execution"
            ? `EXECUTION: claim ${initial.id}. Follow the accepted plan. ${executionNavigationCalls >= 6
              ? "Navigation allowance reached. Write or run the claim-specific analysis; if you cannot safely proceed, submit_for_assessment so assessment can request a bounded plan revision. Repeated command output is not progress; after repeated outputs, submit_for_assessment is required. Do not invent missing materials or results."
              : "Inspect only what the accepted experiment needs, then write/run it. Do not repeat directory orientation."} Only captured experimental output can support a result. Result recording and final logbooks belong to later stages.`
            : `ASSESSMENT: claim ${initial.id}. ${stageCalls >= 4
              ? "Evidence browsing is closed. Use record_result only with evidence already obtained; otherwise request_plan_revision for missing experiments. Never turn source-code inspection into a measured result."
              : "Inspect only the evidence needed to assess this claim. If no experiment was performed, request_plan_revision rather than repeatedly reading source code."} No source re-extraction. Follow the supplied claim/plan packet.`;
        const current = input.session.recorded.get(initial.id)!;
        const revision = [...revisions].reverse().find(r => r.claimId === initial.id);
        const packet = JSON.stringify({ stage: phase, claim: current, plan: controller.plans.get(initial.id),
          revision,
          executionEvidence: executionEvidenceIndex(input.session.toolCalls),
          materials: Array.from(input.shippedPaths),
          evidence: input.session.toolCalls.filter(c => ["run_command", "read_file", "list_files"].includes(c.name))
            // Navigation references, not duplicate canonical evidence. This packet
            // survives compaction intact, so large excerpts otherwise consume the
            // entire input allowance before the next stage can make its first call.
            .slice(-3).map(c => ({ id: c.index, tool: c.name, excerpt: c.result.slice(0, 400),
              omitted: c.result.length > 400, retrieve: `read_tool_result tool_call_id=${c.index}` })),
          questioning: input.session.questioning?.judgeContext(),
          // The judge summary deliberately clips/omits adaptation instructions.
          // Execution needs the exact authorized contract, protected with the packet.
          adaptationContract: input.session.questioning?.assessment ?? null,
          instruction: phase === "planning" ? "Inspect relevant shipped materials, assess suitability for qP, then submit_plan."
            : phase === "execution" ? `Perform the planned experiment. For rerun evidence, launch a standalone planned script. ${input.session.questioning ? "For qP use python materials/analysis.py with the real planned filename; omit working_directory because the sealed snapshot determines it." : "For P use python /work/materials/analysis.py with the real planned filename, and working_directory=/work/materials if required."} Never wrap the script in cd, chaining, pipes, tee or redirection: stdout/stderr are retained automatically and its own exit status is required. Retrieve old outputs rather than repeat commands. Then submit_for_assessment.`
              : "Inspect existing outputs and record_result for this claim only with exact numbered evidence; request_plan_revision only if more experiments are needed.",
        });
        await save();
        let commandInFlight = false;
        const stageTools = [...input.tools, ...controls]
          .filter(t => controller.allowedTools.includes(t.name))
          .map(t => {
            if (phase === "execution" && t.name === "run_command") return {
              ...t, parameters: { ...t.parameters, properties: {
                ...t.parameters.properties as Record<string, unknown>,
                repeat_reason: { type: "string", minLength: 1, maxLength: 1000,
                  description: "Why a fresh execution is needed if this exact command already succeeded. Otherwise retrieve its original output." },
              } },
            };
            if (phase !== "assessment" || t.name !== "record_result") return t;
            const method = controller.plans.get(initial.id)?.method;
            // Extraction owns source identity and reported values. Assessment
            // must not ask the model to reconstruct those immutable fields.
            const updateFields = new Set(["id", "status", "reproduced_value", "evidence", "notes", "method",
              "evidence_tool_call_ids", "evidence_excerpt", "blocker_kind", "raw_input_tool_call_id", "raw_input_path"]);
            const properties = Object.fromEntries(Object.entries(t.parameters.properties as Record<string, unknown>)
              .filter(([key]) => updateFields.has(key)));
            properties.status = { type: "string", enum: ["verified", "falsified", "toy", "inconclusive"] };
            return {
              ...t,
              description: `Assess the existing claim ${initial.id} using exact captured evidence. Claim text, original_value and source provenance are already registered and immutable: omit them, do not re-extract or resubmit them. Explicitly provide method. The accepted plan method is ${method}. If the experiment used another method, request_plan_revision first; never relabel an experiment to satisfy the plan.`,
              parameters: {
                ...t.parameters,
                properties,
                additionalProperties: false,
                required: ["id", "status", "method"],
              },
            };
          });
        const outcome = await runToolLoop(input.config, `${input.instructions}\n\nApplication-owned workflow: follow ONLY the current stage packet and permitted tools. Claims have already been extracted; do not register new claims or manage source identifiers. Stage control replaces any older workflow instructions, but all custom scientific instructions and qP safety gates remain binding.`, packet,
          stageTools,
          async (name, args) => {
            controller.charge(name);
            if (phase === "assessment" && stageCalls >= 4
              && !["record_result", "request_plan_revision"].includes(name))
              return "Refused: assessment browsing allowance reached. Record only an evidence-backed result, or request_plan_revision. Missing evidence is not a fabricated blocker or a verdict.";
            if (phase === "execution" && repeatedExecutionOutputs >= 2 && name !== "submit_for_assessment")
              return "Refused: repeated execution output without progress. Submit_for_assessment; assessment may request a bounded plan revision. No scientific result is inferred.";
            if (phase === "execution" && executionNavigationCalls >= 6
              && ["read_file", "read_tool_result", "list_files"].includes(name))
              return "Refused: execution navigation allowance reached. Write/run the accepted analysis, or submit_for_assessment for a bounded plan revision. No scientific result is inferred.";
            if (name === "submit_plan") {
              if (revision && args.method !== revision.method)
                return `Refused: this revision requested method=${revision.method} because: ${revision.reason}. Submit that scientific method; do not repeat the superseded ${revision.previousPlan?.method} plan or describe a fallback only in rationale. No result is accepted by this plan change.`;
              if (input.session.questioning && !input.session.questioning.assessment) return "Refused: qP requires assess_suitability before committing an experiment plan.";
              controller.acceptPlan(args as unknown as ExperimentPlan, input.shippedPaths);
              await save();
              return "Plan accepted; application will start the next stage.";
            }
            if (name === "submit_for_assessment") { controller.assess(); await save(); return "Execution stage ended."; }
            if (name === "request_plan_revision") {
              controller.revisePlan();
              revisions.push({ claimId: initial.id, reason: args.reason as string,
                method: args.method as ExperimentPlan["method"],
                previousPlan: structuredClone(controller.plans.get(initial.id)) });
              await save();
              return "Planning revision authorized; the reason and requested method will be carried into the next stage. Existing evidence remains available; do not rerun merely to retrieve it.";
            }
            if (name === "record_result" && (args.id !== initial.id || args.status === "pending"))
              return "Refused: finalize only the application's current claim; extraction is closed.";
            if (name === "record_result" && args.method !== "blocked"
              && args.method !== controller.plans.get(initial.id)?.method) {
              const expected = controller.plans.get(initial.id)?.method;
              if (args.method === undefined)
                return `Refused: missing scientific method. Explicitly supply method=${expected} only if that is what was actually executed; otherwise request_plan_revision.`;
              const received = ["rerun", "raw-data-rederived", "toy"].includes(String(args.method)) ? args.method : "invalid";
              return `Refused: scientific method differs from the accepted plan (received=${received}; planned=${expected}). Use request_plan_revision before changing methods. Never relabel the actual experiment just to satisfy this gate.`;
            }
            if (name === "record_result" && args.method === "rerun") {
              const plan = controller.plans.get(initial.id)!;
              const issue = rerunEvidenceIssue(input.session.toolCalls, plan.materialPaths, args);
              if (issue) return `Refused: the exact measurement excerpt and reproduced value must come from the SAME cited successful standalone planned source-entrypoint execution. ${issue}`;
            }
            if (name === "run_command") {
              const plan = controller.plans.get(initial.id);
              if (plan?.method === "rerun") {
                const refusal = rerunLaunchRefusal(String(args.command ?? ""), plan.materialPaths, Boolean(input.session.questioning));
                if (refusal) return refusal;
                const repeat = repeatExecutionRefusal(input.session.toolCalls, plan.materialPaths, args);
                if (repeat) return repeat;
              }
              controller.commandDispatched();
              commandInFlight = true;
              // Persist BEFORE dispatch. A crash here is deliberately ambiguous.
              await save();
            }
            const result = await input.execute(name, args);
            if (commandInFlight) { controller.commandReturned(); commandInFlight = false; }
            return result;
          }, {
            ...input.options,
            getRequiredTool: () => phase === "planning" && stageCalls >= 8
              ? input.session.questioning && !input.session.questioning.assessment
                ? "assess_suitability" : "submit_plan"
              : phase === "execution" && repeatedExecutionOutputs >= 2 ? "submit_for_assessment" : undefined,
            getAvailableTools: () => phase === "execution" && executionNavigationCalls >= 6
              ? controller.allowedTools.filter(name => ["write_file", "run_command", "setup_environment", "submit_for_assessment"].includes(name))
              : phase === "assessment" && stageCalls >= 4
                ? ["record_result", "request_plan_revision"]
              : controller.allowedTools,
            getArgumentRepair: () => activeInstruction(),
            transformToolResult: (name, result, index) => {
              // Legacy single-loop browsing hints are not stage contracts.
              // Preserve actual tool responses; this controller owns recovery.
              if (!recovery) return result;
              recovery.observe(name, result, index, stageCalls + 1);
              return result;
            },
            onOutcome: event => input.options.onOutcome?.({
              ...event, round: rounds + event.round, callCount: stageStartCalls + event.callCount,
              phase, phaseCallCount: event.callCount,
              stopReason: phase === "planning" && event.stopReason === "tool-budget"
                && stageStartCalls + event.callCount < input.options.maxToolCalls
                ? "planning-allowance" : event.stopReason,
            }),
            onRequestPrepared: request => {
              const messages = request.messages as Array<{ content?: unknown }>;
              if (!messages.some(m => m.content === packet)) throw new ContextBudgetError("The current claim/plan packet did not survive request fitting; refusing a contextless stage request.");
              void input.options.onOutcome?.({ kind: "context", round: rounds, callCount: stageStartCalls + stageCalls,
                phase, phaseCallCount: stageCalls,
                requestedInputTokens: estimateRequestTokens(request) });
            },
            maxToolCalls: Math.min(controller.remainingStageCalls, input.options.maxToolCalls - calls),
            toolCallIndexOffset: input.session.toolCalls.length,
            getStallReason: () => commandInFlight ? "Command completion unknown; automatic re-execution forbidden." : null,
            isStageComplete: () => controller.phase !== phase || input.session.recorded.get(initial.id)?.status !== "pending",
            onPrematureStop: () => `${activeInstruction()} Stage is incomplete; use declared tools, not prose.`,
            maxPrematureStopRecoveries: 1,
            getRecoveryProgress: undefined,
            contextProtection: {
              ...input.options.contextProtection,
              preserveLatestToolBatch: true,
              resizeRecentToolOutput: (result, bytes) => {
                const index = result.match(/^\[Tool call #(\d+)\]\n/)?.[1];
                if (!index) return undefined;
                const args = { tool_call_id: Number(index), offset: 0, max_chars: 6000 };
                const page = input.session.readToolResult(args);
                return input.session.resizeRetrieval("read_tool_result", args, page, bytes);
              },
              getState: (maxBytes = 2500) => {
                const state = { phase: controller.phase, claimId: initial.id,
                  calls: stageStartCalls + stageCalls, stageCalls, planning: recovery?.state(),
                  recentExecution: phase === "execution" ? input.session.toolCalls
                    .filter(call => call.name === "run_command" || call.name === "write_file")
                    .slice(-2).map(call => ({
                      id: call.index, tool: call.name, error: call.error,
                      action: String(call.args.command ?? call.args.path ?? "").slice(0, 120),
                      excerpt: executionRecoveryExcerpt(call),
                      retrieve: `read_tool_result tool_call_id=${call.index}`,
                    })) : [] };
                while (Buffer.byteLength(JSON.stringify(JSON.stringify(state))) > maxBytes
                  && state.planning?.inspected.length) state.planning.inspected.shift();
                while (Buffer.byteLength(JSON.stringify(JSON.stringify(state))) > maxBytes
                  && state.recentExecution.length) {
                  if (state.recentExecution.length > 1) state.recentExecution.shift();
                  else {
                    const latest = state.recentExecution[0];
                    if (latest.excerpt.length) latest.excerpt = latest.excerpt.slice(0, Math.floor(latest.excerpt.length / 2));
                    else if (latest.action.length) latest.action = "";
                    else break; // Keep the authoritative original evidence ID.
                  }
                }
                return JSON.stringify(state);
              },
              getActiveInstruction: activeInstruction,
              compactUserMessage: packet,
              resizeRetrieval: (name, args, result, bytes) => input.session.resizeRetrieval(name, args, result, bytes),
            },
            onToolCall: async record => {
              stageCalls++;
              if (phase === "execution") {
                if (["read_file", "read_tool_result", "list_files"].includes(record.name)) executionNavigationCalls++;
                else if (record.name === "write_file" && !record.error && !record.result.startsWith("Refused:")) {
                  executionNavigationCalls = 0;
                  executionOutputs.clear();
                  repeatedExecutionOutputs = 0;
                } else if (record.name === "run_command" && !record.error && !record.result.startsWith("Refused:")) {
                  // Execution status/duration is not scientific progress. Compare
                  // actual output, not shell syntax or the presence of a command.
                  const normalized = record.result.replace(/^(exit code -?\d+) \([\d.]+s\)/, "$1");
                  const hash = createHash("sha256").update(normalized).digest("hex");
                  if (executionOutputs.has(hash)) {
                    repeatedExecutionOutputs++;
                    executionNavigationCalls = Math.max(6, executionNavigationCalls);
                  } else {
                    executionOutputs.add(hash);
                    executionNavigationCalls = 0;
                  }
                }
              }
              if (recovery?.firstStallCall !== undefined && !recoveryRecord) {
                recoveryRecord = { claimId: initial.id, firstStallCall: recovery.firstStallCall,
                  aggregateCall: stageStartCalls + recovery.firstStallCall, outcome: "repairing" };
                planningRecovery.push(recoveryRecord);
              }
              if (recoveryRecord && controller.phase !== phase) recoveryRecord.outcome = "plan-accepted";
              await input.options.onToolCall?.(record);
              await save();
            },
          });
        rounds += outcome.rounds;
        calls += outcome.toolCalls.length;
        // qP's blocked assessment is a limitation, never fabricated execution.
        if (input.session.questioning?.finalizeBlockedClaims(Array.from(input.session.recorded.values()))) {
          controller.suitabilityBlocked();
          break;
        }
        if ((Date.now() >= input.options.deadlineMs || calls >= input.options.maxToolCalls)
          && Array.from(input.session.recorded.values()).some(c => c.status === "pending"))
          throw new Error("Pipeline stopped at the enforced global resource limit; unfinished claims are not scientific results.");
        if (controller.phase === phase && input.session.recorded.get(initial.id)?.status === "pending") {
          if (recoveryRecord) recoveryRecord.outcome = "unresolved";
          const reason = recovery ? `planning-stall (${outcome.stoppedBy === "tool-budget" ? "local planning allowance exhausted, not global budget" : outcome.stoppedBy})` : outcome.stoppedBy;
          failure = { phase, phaseCalls: stageCalls, aggregateCalls: calls, reason };
          throw new Error(`Pipeline ${phase} failed for ${initial.id}: ${reason}; accepted evidence retained.`);
        }
      }
      if (Array.from(input.session.recorded.values()).every(c => c.status !== "pending")) break;
    }
    controller.judge(Array.from(input.session.recorded.values()));
    await save();
    return { content: renderAcceptedLogbook(Array.from(input.session.recorded.values()), input.session.toolCalls),
      toolCalls: input.session.toolCalls.slice(started), rounds, stoppedBy: "model",
      completeReport: async () => { controller.report(); await save(); controller.complete(); await save(); } };
  } catch (error) {
    const failedPhase = controller.phase;
    failure ??= { phase: failedPhase, phaseCalls: controller.snapshot().phaseCalls,
      aggregateCalls: controller.calls,
      reason: Date.now() >= input.options.deadlineMs ? "global deadline"
        : controller.calls >= input.options.maxToolCalls ? "global tool budget"
          : "stage exception; no automatic replay" };
    controller.fail();
    try { await save(`Pipeline failed during ${failedPhase}${failure ? `: ${failure.reason}` : ""}; unfinished claims remain unresolved. No automatic command replay.`); }
    catch { /* Preserve the original failure when checkpoint storage is unavailable. */ }
    throw error;
  }
}