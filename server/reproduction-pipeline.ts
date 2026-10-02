import { createHash } from "node:crypto";
import { runToolLoop, type ModelProviderConfig, type ToolSpec, type ToolLoopOptions, type ToolLoopResult } from "./model-service";
import { ReproductionController, renderAcceptedLogbook, type ExperimentPlan } from "./reproduction-controller";
import type { ReproductionSession } from "./reproduction-session";
import { ContextBudgetError, estimateRequestTokens } from "./llm-context";

const controls: ToolSpec[] = [
  { name: "submit_plan", description: "Commit a claim-specific plan using actual shipped paths. Code controls the next stage; qP assessment is additionally required.",
    parameters: { type: "object", additionalProperties: false, required: ["claimId", "method", "materialPaths", "measurement", "rationale"],
      properties: { claimId: { type: "string" }, method: { type: "string", enum: ["rerun", "raw-data-rederived", "toy", "blocked"] },
        materialPaths: { type: "array", items: { type: "string" } }, measurement: { type: "string" }, rationale: { type: "string" } } } },
  { name: "submit_for_assessment", description: "Finish execution and assess the captured outputs. No verdict is granted by this transition.",
    parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "request_plan_revision", description: "Return to planning if existing evidence is insufficient. At most two revisions per claim, within the unchanged global budget.",
    parameters: { type: "object", properties: {}, additionalProperties: false } },
];
export interface PipelineCheckpoint {
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
  checkpoint?: (value: PipelineCheckpoint) => Promise<void>;
}): Promise<ToolLoopResult & { completeReport: () => Promise<void> }> {
  const controller = new ReproductionController(input.options.deadlineMs, input.options.maxToolCalls);
  controller.startExtraction();
  controller.calls = input.extractionCalls;
  let calls = input.extractionCalls;
  let rounds = 0;
  const started = input.session.toolCalls.length;
  const save = async (limitation?: string) => {
    await input.checkpoint?.({
      controller: controller.snapshot(),
      claims: Array.from(input.session.recorded.values()).map(c => ({ id: c.id, claim: c.claim, status: c.status, evidenceIds: c.evidenceToolCallIds ?? [] })),
      outputs: input.session.toolCalls.map(c => ({ id: c.index, tool: c.name,
        sha256: createHash("sha256").update(c.result).digest("hex"), error: c.error })),
      logbook: renderAcceptedLogbook(Array.from(input.session.recorded.values()), input.session.toolCalls, limitation),
    });
  };
  try {
    for (const initial of Array.from(input.session.recorded.values())) {
      controller.beginClaim(initial);
      while (input.session.recorded.get(initial.id)?.status === "pending") {
        if (calls >= input.options.maxToolCalls || Date.now() >= input.options.deadlineMs)
          throw new Error("System-enforced global reproduction budget exhausted.");
        const phase = controller.phase;
        const current = input.session.recorded.get(initial.id)!;
        const packet = JSON.stringify({ stage: phase, claim: current, plan: controller.plans.get(initial.id),
          materials: Array.from(input.shippedPaths),
          evidence: input.session.toolCalls.filter(c => ["run_command", "read_file", "list_files"].includes(c.name))
            .slice(-5).map(c => ({ id: c.index, tool: c.name, excerpt: c.result.slice(0, 1600),
              omitted: c.result.length > 1600, retrieve: `read_tool_result tool_call_id=${c.index}` })),
          questioning: input.session.questioning?.judgeContext(),
          // The judge summary deliberately clips/omits adaptation instructions.
          // Execution needs the exact authorized contract, protected with the packet.
          adaptationContract: input.session.questioning?.assessment ?? null,
          instruction: phase === "planning" ? "Inspect relevant shipped materials, assess suitability for qP, then submit_plan."
            : phase === "execution" ? "Perform the planned experiment. Retrieve old outputs rather than repeat commands. Then submit_for_assessment."
              : "Inspect existing outputs and record_result for this claim only with exact numbered evidence; request_plan_revision only if more experiments are needed.",
        });
        await save();
        let commandInFlight = false;
        const outcome = await runToolLoop(input.config, `${input.instructions}\n\nApplication-owned workflow: follow ONLY the current stage packet and permitted tools. Claims have already been extracted; do not register new claims or manage source identifiers. Stage control replaces any older workflow instructions, but all custom scientific instructions and qP safety gates remain binding.`, packet,
          [...input.tools, ...controls].filter(t => controller.allowedTools.includes(t.name)),
          async (name, args) => {
            controller.charge(name);
            if (name === "submit_plan") {
              if (input.session.questioning && !input.session.questioning.assessment) return "Refused: qP requires assess_suitability before committing an experiment plan.";
              controller.acceptPlan(args as unknown as ExperimentPlan, input.shippedPaths);
              await save();
              return "Plan accepted; application will start the next stage.";
            }
            if (name === "submit_for_assessment") { controller.assess(); await save(); return "Execution stage ended."; }
            if (name === "request_plan_revision") { controller.revisePlan(); await save(); return "Planning revision authorized."; }
            if (name === "record_result" && (args.id !== initial.id || args.status === "pending"))
              return "Refused: finalize only the application's current claim; extraction is closed.";
            if (name === "record_result" && args.method !== "blocked"
              && args.method !== controller.plans.get(initial.id)?.method)
              return "Refused: scientific method differs from the accepted plan. Request a bounded plan revision.";
            if (name === "record_result" && args.method === "rerun") {
              const plan = controller.plans.get(initial.id)!;
              const ids = Array.isArray(args.evidence_tool_call_ids) ? args.evidence_tool_call_ids : [];
              const entrypointEvidence = input.session.toolCalls.some(call => {
                const excerpt = typeof args.evidence_excerpt === "string" ? args.evidence_excerpt.trim() : "";
                const value = typeof args.reproduced_value === "string" ? args.reproduced_value.trim() : "";
                if (call.name !== "run_command" || !ids.includes(call.index) || call.error
                  || !/^exit code 0\b/.test(call.result) || excerpt.length < 4 || !value
                  || !excerpt.includes(value) || !call.result.includes(excerpt)) return false;
                const match = /^(?:python3?|bash|sh|node|Rscript|julia)\s+((?:\/work\/)?materials\/[^\s"';&|<>`$]+)(?:\s|$)/.exec(String(call.args.command ?? ""));
                const path = match?.[1].startsWith("/work/") ? match[1] : match ? `/work/${match[1]}` : "";
                // Shell chaining is not a single source-entrypoint execution:
                // its final exit code/output could belong to a CSV display.
                const standalone = !/[;&|<>`$\r\n]/.test(String(call.args.command ?? ""));
                return standalone && /\.(?:py|sh|js|mjs|r|jl)$/i.test(path) && plan.materialPaths.includes(path);
              });
              if (!entrypointEvidence) return "Refused: the exact measurement excerpt and reproduced value must come from the SAME cited successful standalone planned source-entrypoint execution. Failed scripts, unrelated successful commands and supplied CSV displays cannot be combined into rerun evidence. Use an inspected source file, or revise the method.";
            }
            if (name === "run_command") {
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
            onRequestPrepared: request => {
              const messages = request.messages as Array<{ content?: unknown }>;
              if (!messages.some(m => m.content === packet)) throw new ContextBudgetError("The current claim/plan packet did not survive request fitting; refusing a contextless stage request.");
              void input.options.onOutcome?.({ kind: "context", round: rounds, callCount: calls,
                requestedInputTokens: estimateRequestTokens(request) });
            },
            maxToolCalls: Math.min(controller.remainingStageCalls, input.options.maxToolCalls - calls),
            toolCallIndexOffset: input.session.toolCalls.length,
            getStallReason: () => commandInFlight ? "Command completion unknown; automatic re-execution forbidden." : null,
            isStageComplete: () => controller.phase !== phase || input.session.recorded.get(initial.id)?.status !== "pending",
            onPrematureStop: () => `Stage ${phase} is not complete. Use the stage's declared tools and exact current claim; do not return prose.`,
            maxPrematureStopRecoveries: 1,
            getRecoveryProgress: undefined,
            contextProtection: {
              getState: () => JSON.stringify({ phase: controller.phase, claimId: initial.id, calls }),
              getActiveInstruction: () => `Application stage: ${controller.phase}; claim ${initial.id}. No source re-extraction. Follow the supplied claim/plan packet.`,
              compactUserMessage: packet,
              resizeRetrieval: (name, args, result, bytes) => input.session.resizeRetrieval(name, args, result, bytes),
            },
            onToolCall: async record => {
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
        if (controller.phase === phase && input.session.recorded.get(initial.id)?.status === "pending")
          throw new Error(`Pipeline ${phase} failed for ${initial.id}: ${outcome.stoppedBy}; accepted evidence retained.`);
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
    controller.fail();
    try { await save(`Pipeline failed during ${failedPhase}; unfinished claims remain unresolved. No automatic command replay.`); }
    catch { /* Preserve the original failure when checkpoint storage is unavailable. */ }
    throw error;
  }
}