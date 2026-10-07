import type { RecordedResult } from "./prompts/reproduce";
import type { ToolCallRecord } from "./model-service";
import { isSupportedRawInputPath } from "./reproduction-stage-evidence";

export type ReproductionPhase = "source" | "extraction" | "planning" | "execution" | "assessment" | "judging" | "reporting" | "failed" | "complete";
export interface ExperimentPlan {
  claimId: string;
  method: "rerun" | "raw-data-rederived" | "toy" | "blocked";
  materialPaths: string[];
  measurement: string;
  rationale: string;
  rawInputs?: Array<{ path: string; readToolCallId: number }>;
  relatedClaims?: Array<{ claimId: string; measurement: string }>;
}
const phaseTools: Record<ReproductionPhase, readonly string[]> = {
  source: [], extraction: ["submit_claims"],
  planning: ["read_file", "list_files", "read_tool_result", "assess_suitability", "submit_plan", "setup_environment"],
  execution: ["read_file", "list_files", "read_tool_result", "write_file", "run_command", "setup_environment", "submit_for_assessment"],
  assessment: ["read_tool_result", "read_file", "record_result", "request_plan_revision"],
  judging: [], reporting: [], failed: [], complete: [],
};
const limits: Record<ReproductionPhase, number> = {
  source: 0, extraction: 18, planning: 12, execution: 30, assessment: 8,
  judging: 0, reporting: 0, failed: 0, complete: 0,
};

/**
 * Application-owned transitions; no model-provided phase, counter, or claim ID
 * can reset budgets. Scientific validators still own claim acceptance.
 */
export class ReproductionController {
  phase: ReproductionPhase = "source";
  readonly plans = new Map<string, ExperimentPlan>();
  readonly milestones: Array<{ phase: ReproductionPhase; calls: number }> = [];
  calls = 0;
  private phaseCalls = 0;
  private revisions = new Map<string, number>();
  private claimId?: string;
  private awaitingCommand = false;
  private sharedAssessmentReady = new Set<string>();
  private activeExperiment?: number;
  private sharedExperiments: Array<{ claimIds: string[]; readyForAssessment: boolean }> = [];

  constructor(readonly deadline: number, readonly maxCalls = 100) {}
  private enter(phase: ReproductionPhase) {
    this.phase = phase;
    this.phaseCalls = 0;
    this.milestones.push({ phase, calls: this.calls });
  }
  startExtraction() {
    if (this.phase !== "source") throw new Error("Source preparation has already ended.");
    this.enter("extraction");
  }
  beginClaim(claim: RecordedResult) {
    if (!["extraction", "assessment"].includes(this.phase) || this.awaitingCommand)
      throw new Error("Cannot start a claim in the current phase.");
    if (claim.status !== "pending" || this.claimId === claim.id) throw new Error("Expected a new pending claim.");
    this.claimId = claim.id;
    this.activeExperiment = undefined;
    this.enter(this.plans.has(claim.id) && this.sharedAssessmentReady.has(claim.id) ? "assessment" : "planning");
  }
  get activeClaimId() { return this.claimId; }
  get allowedTools() { return phaseTools[this.phase]; }
  get remainingStageCalls() { return Math.max(0, limits[this.phase] - this.phaseCalls); }
  charge(name: string, now = Date.now()) {
    if (now >= this.deadline) throw new Error("System-enforced deadline exhaustion");
    if (this.calls >= this.maxCalls) throw new Error("System-enforced tool-call budget exhaustion");
    // Invalid actions consume allowance too; refusal loops cannot renew it.
    this.calls++;
    this.phaseCalls++;
    if (this.phaseCalls > limits[this.phase]) throw new Error(`${this.phase} allowance exhausted`);
    if (!this.allowedTools.includes(name)) throw new Error(`${name} is unavailable during ${this.phase}`);
    if (this.awaitingCommand) throw new Error("Command completion is unknown; automatic re-execution is forbidden.");
  }
  acceptPlan(plan: ExperimentPlan, shippedPaths: ReadonlySet<string>, registered: readonly RecordedResult[] = [],
    evidence: readonly Pick<ToolCallRecord, "index" | "name" | "args" | "result" | "error">[] = []) {
    if (this.phase !== "planning" || plan.claimId !== this.claimId) throw new Error("Plan must belong to the current pending claim.");
    if (!["rerun", "raw-data-rederived", "toy", "blocked"].includes(plan.method)
      || typeof plan.measurement !== "string" || !plan.measurement.trim() || plan.measurement.length > 2000
      || typeof plan.rationale !== "string" || !plan.rationale.trim() || plan.rationale.length > 2000
      || !Array.isArray(plan.materialPaths) || plan.materialPaths.length > 30
      || plan.materialPaths.some(p => typeof p !== "string" || !shippedPaths.has(p))
      || (plan.method !== "blocked" && !plan.materialPaths.length)) throw new Error("Plan requires bounded measurement, rationale and verified shipped material paths.");
    if (plan.method === "raw-data-rederived") {
      if (!Array.isArray(plan.rawInputs) || !plan.rawInputs.length || plan.rawInputs.length > 30
        || plan.rawInputs.some(raw => !raw || typeof raw.path !== "string" || !isSupportedRawInputPath(raw.path) || !plan.materialPaths.includes(raw.path)
          || !Number.isSafeInteger(raw.readToolCallId)
          || !evidence.some(call => call.index === raw.readToolCallId && call.name === "read_file"
            && call.args.path === raw.path && !call.error && !call.result.startsWith("Refused:"))))
        throw new Error("Raw-data re-derivation requires rawInputs naming inspected shipped inputs: path and original readToolCallId. Include these paths in materialPaths. A script or a guess about future output is not evidence of available raw observations. Inspect the input first or choose the actual method; precomputed summaries are not raw observations.");
    }
    const related = plan.relatedClaims ?? [];
    if (!Array.isArray(related) || related.length > 11)
      throw new Error("A shared experiment may include at most eleven additional claims.");
    const ids = new Set([plan.claimId]);
    // Validate the entire group before changing state. A bad sibling must not
    // partially enroll claims or overwrite an earlier experiment's contract.
    for (const member of related) {
      if (!member || typeof member.claimId !== "string" || ids.has(member.claimId)
        || this.plans.has(member.claimId)
        || !registered.some(c => c.id === member.claimId && c.status === "pending")
        || typeof member.measurement !== "string" || !member.measurement.trim() || member.measurement.length > 2000)
        throw new Error("Shared claims must be distinct, registered, pending, unplanned, and have individual measurements.");
      ids.add(member.claimId);
    }
    this.plans.set(plan.claimId, structuredClone(plan));
    for (const member of related) this.plans.set(member.claimId, {
      claimId: member.claimId, measurement: member.measurement, method: plan.method,
      materialPaths: [...plan.materialPaths], rationale: plan.rationale,
      ...(plan.rawInputs ? { rawInputs: structuredClone(plan.rawInputs) } : {}),
    });
    this.sharedExperiments.push({ claimIds: Array.from(ids), readyForAssessment: plan.method === "blocked" });
    this.activeExperiment = this.sharedExperiments.length - 1;
    if (plan.method === "blocked") for (const id of Array.from(ids)) this.sharedAssessmentReady.add(id);
    this.enter(plan.method === "blocked" ? "assessment" : "execution");
  }
  commandDispatched() {
    if (this.phase !== "execution" || this.awaitingCommand) throw new Error("Execution is not authorized.");
    this.awaitingCommand = true;
  }
  commandReturned() {
    if (!this.awaitingCommand) throw new Error("No outstanding command.");
    this.awaitingCommand = false;
  }
  assess() {
    if (this.phase !== "execution" || this.awaitingCommand) throw new Error("Cannot assess an unfinished execution.");
    if (this.activeExperiment !== undefined) {
      const group = this.sharedExperiments[this.activeExperiment];
      group.readyForAssessment = true;
      for (const id of group.claimIds) this.sharedAssessmentReady.add(id);
    }
    this.enter("assessment");
  }
  revisePlan() {
    if (this.phase !== "assessment" || !this.claimId) throw new Error("Plan revision is unavailable.");
    const count = this.revisions.get(this.claimId) ?? 0;
    if (count >= 2) throw new Error("Claim plan revision allowance exhausted.");
    this.revisions.set(this.claimId, count + 1);
    // Repair only this claim; other group members retain their original plan
    // and must still independently validate the shared experiment's evidence.
    this.sharedAssessmentReady.delete(this.claimId);
    this.activeExperiment = undefined;
    this.enter("planning");
  }
  judge(claims: readonly RecordedResult[]) {
    if (this.phase !== "assessment" || !claims.length || claims.some(c => c.status === "pending") || this.awaitingCommand)
      throw new Error("Cannot judge unfinished claims.");
    this.enter("judging");
  }
  report() {
    if (this.phase !== "judging") throw new Error("Independent judging must precede reporting.");
    this.enter("reporting");
  }
  complete() {
    if (this.phase !== "reporting") throw new Error("Report has not been prepared.");
    this.enter("complete");
  }
  fail() { this.enter("failed"); }
  suitabilityBlocked() {
    if (!["planning", "execution", "assessment"].includes(this.phase) || this.awaitingCommand)
      throw new Error("Cannot close suitability assessment in this phase.");
    this.enter("assessment");
  }
  snapshot() {
    return { version: 1, phase: this.phase, calls: this.calls, phaseCalls: this.phaseCalls,
      activeClaimId: this.claimId, commandCompletionUnknown: this.awaitingCommand,
      sharedExperiments: structuredClone(this.sharedExperiments),
      plans: Array.from(this.plans.values()), milestones: [...this.milestones] };
  }
}

/** Deterministic scaffold; model prose is never required for retaining results. */
export function renderAcceptedLogbook(claims: readonly RecordedResult[], calls: readonly ToolCallRecord[], limitation?: string): string {
  const text = (s: string) => s.replace(/[<>]/g, c => c === "<" ? "&lt;" : "&gt;");
  return [
    "## Claims",
    claims.length ? claims.map(c => `- ${text(c.id)}: ${text(c.claim)}\n  Accepted status: ${c.status}; method: ${c.method ?? "not established"}.`).join("\n") : "No claims accepted.",
    "## Reproduction Log",
    calls.filter(c => c.name === "run_command").map(c => `- Command #${c.index}: ${c.error ? "tool failure" : "output captured"}; execution alone is not scientific verification.`).join("\n") || "No commands executed.",
    "## Discrepancies",
    claims.filter(c => c.status === "falsified").map(c => `- ${text(c.id)}: ${text(c.evidence ?? "See accepted evidence record.")}`).join("\n") || "No accepted falsification recorded. This is not proof of agreement.",
    "## Limitations",
    limitation ? text(limitation) : "Accepted statuses are reproducer proposals until independently judged. Supplied results, toy analyses and adaptations do not establish original-result verification.",
    ...claims.filter(c => c.status === "pending" || c.status === "inconclusive" || c.status === "toy")
      .map(c => `- ${text(c.id)}: ${text(c.evidence ?? "Claim not independently verified.")}`),
  ].join("\n\n");
}