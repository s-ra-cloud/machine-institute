import { createHash } from "node:crypto";
import type { ToolCallRecord } from "./model-service";
import { REPRODUCTION_BLOCKERS, REPRODUCTION_METHODS, VERDICTS, type RecordedResult } from "./prompts/reproduce";

type ClaimValidator = (results: RecordedResult[], calls: readonly ToolCallRecord[]) => string[];
const evidenceTools = new Set(["run_command", "read_file", "list_files"]);

/** Run-local evidence and accepted claims, independent of the model's compacted context. */
export class ReproductionSession {
  readonly recorded = new Map<string, RecordedResult>();
  readonly toolCalls: ToolCallRecord[] = [];
  private drafts = new Map<string, RecordedResult>();
  private rejected = new Map<string, string[]>();
  private capturedOutput: string | undefined;
  private progressKeys = new Set<string>();
  private completedIds = new Set<string>();

  constructor(private validate: ClaimValidator) {}

  get progress(): number {
    return this.progressKeys.size + this.completedIds.size;
  }

  captureOutput(name: string, result: string): void {
    this.capturedOutput = evidenceTools.has(name) ? result : undefined;
  }

  observeToolCall(record: ToolCallRecord): void {
    const full = { ...record, result: this.capturedOutput ?? record.result };
    this.capturedOutput = undefined;
    this.toolCalls.push(full);
    if (evidenceTools.has(full.name) && !/^(?:Refused:|Tool budget exhausted|Deadline exhausted)/.test(full.result)) {
      // Timing changes and repeated reads/polls are not new scientific progress.
      const output = full.result.replace(/^(exit code \S+|TIMED OUT) \([\d.]+s\)/, "$1");
      const key = createHash("sha256").update(`${full.name}\n${output}`).digest("hex");
      this.progressKeys.add(key);
    }
  }

  recordResult(args: Record<string, unknown>): string {
    const id = String(args.id || "").trim();
    const previous = this.recorded.get(id);
    const claim = String(args.claim ?? previous?.claim ?? "").trim();
    const status = String(args.status ?? "").trim().toLowerCase();
    if (!id || !claim) return "Refused: id and claim are required for a new result.";
    if (status !== "pending" && !(VERDICTS as readonly string[]).includes(status)) {
      return "Refused: status must be pending, verified, falsified, toy, or inconclusive.";
    }
    if (status === "pending") {
      if (previous) return `Unchanged: ${id} remains ${previous.status}; an existing result cannot be reset by registering it again.`;
      this.recorded.set(id, { id, claim, status, originalValue: args.original_value == null ? undefined : String(args.original_value) });
      return `Registered ${id} as pending. ${this.summary()}`;
    }

    const base = this.drafts.get(id) ?? previous;
    const stringField = (key: string, old?: string) => args[key] === undefined ? old : String(args[key]);
    const candidate: RecordedResult = {
      ...base, id, claim, status: status as RecordedResult["status"],
      originalValue: stringField("original_value", base?.originalValue),
      reproducedValue: stringField("reproduced_value", base?.reproducedValue),
      evidence: stringField("evidence", base?.evidence),
      notes: stringField("notes", base?.notes),
      method: stringField("method", base?.method) as RecordedResult["method"],
      blockerKind: stringField("blocker_kind", base?.blockerKind) as RecordedResult["blockerKind"],
      evidenceExcerpt: stringField("evidence_excerpt", base?.evidenceExcerpt),
      evidenceToolCallIds: args.evidence_tool_call_ids === undefined
        ? base?.evidenceToolCallIds
        : Array.isArray(args.evidence_tool_call_ids) ? args.evidence_tool_call_ids.map(Number) : [],
      rawInputPath: stringField("raw_input_path", base?.rawInputPath),
      rawInputToolCallId: args.raw_input_tool_call_id === undefined ? base?.rawInputToolCallId : Number(args.raw_input_tool_call_id),
    };
    const issues: string[] = [];
    if (!(REPRODUCTION_METHODS as readonly unknown[]).includes(candidate.method)) issues.push(`${id} has an invalid reproduction method`);
    if (candidate.blockerKind && !(REPRODUCTION_BLOCKERS as readonly unknown[]).includes(candidate.blockerKind)) issues.push(`${id} has an invalid blocker kind`);
    if ((candidate.evidenceToolCallIds ?? []).some(index => !Number.isInteger(index) || !this.toolCalls.some(c => c.index === index && evidenceTools.has(c.name)))) {
      issues.push(`${id} evidence IDs must name prior command/file checks, not future calls or cached-output retrievals`);
    }
    issues.push(...this.validate([candidate], this.toolCalls));
    if (issues.length) {
      this.drafts.set(id, candidate);
      this.rejected.set(id, issues);
      // A rejected first submission must not make the claim disappear.
      if (!previous) this.recorded.set(id, { id, claim, status: "pending", originalValue: candidate.originalValue });
      return `Refused finalization of ${id}: ${issues.join("; ")}. Accepted state remains ${previous?.status ?? "pending"}. Use read_tool_result with the original tool_call_id to recover exact evidence; do not rerun an expensive experiment just to retrieve output. Resubmit record_result with corrected fields. ${this.summary()}`;
    }
    this.recorded.set(id, candidate);
    this.drafts.delete(id);
    this.rejected.delete(id);
    this.completedIds.add(id);
    return `Recorded ${id} as ${status}; evidence validated. ${this.summary()}`;
  }

  summary(): string {
    return `Registered results: ${Array.from(this.recorded.values()).map(r => `${r.id}=${r.status}`).join(", ")}.`;
  }

  contextState(): string {
    const claims = Array.from(this.recorded.values()).map(result => ({
      id: result.id, claim: result.claim, status: result.status, method: result.method,
      originalValue: result.originalValue, reproducedValue: result.reproducedValue,
      evidenceToolCallIds: result.evidenceToolCallIds, rawInputPath: result.rawInputPath,
      rawInputToolCallId: result.rawInputToolCallId, blockerKind: result.blockerKind,
      repairIssues: this.rejected.get(result.id),
      proposedEvidenceIds: this.drafts.get(result.id)?.evidenceToolCallIds,
    }));
    return `Current accepted claim states (authoritative; rejected submissions are not final):\n${JSON.stringify(claims)}\nAll original evidence remains in read_tool_result; omit tool_call_id to list original IDs. Repair the issues above without rerunning completed experiments for output.`;
  }

  repairContext(): string {
    const outstanding = Array.from(this.recorded.values()).filter(r => r.status === "pending");
    return [
      this.summary(),
      ...outstanding.map(r => `${r.id}: ${r.claim}. ${this.rejected.get(r.id)?.join("; ") || "Perform the claim-specific experiment or demonstrate a real blocker, then record_result."}`),
      "Recover existing evidence with read_tool_result (omit tool_call_id to list the evidence index). Cite the original ID, not the retrieval call. Never invent values or relabel untested work.",
    ].join("\n");
  }

  judgeEvidence(): string {
    return Array.from(this.recorded.values()).map(result => {
      const excerpt = result.evidenceExcerpt?.trim();
      const blocks = excerpt ? this.toolCalls.filter(call =>
        result.evidenceToolCallIds?.includes(call.index) && evidenceTools.has(call.name)
        && call.result.includes(excerpt),
      ).map(call => {
        const position = call.result.indexOf(excerpt);
        const slice = call.result.slice(Math.max(0, position - 250), position + excerpt.length + 250);
        return `Original tool #${call.index}: ${call.name} ${JSON.stringify(call.args)}\nOutput status: ${call.result.split("\n", 1)[0]}\n${slice}`;
      }) : [];
      return `### ${result.id} — original cited evidence\n${blocks.join("\n\n") || "No scientific output cited. See the structured result for the system-enforced resource limit."}`;
    }).join("\n\n");
  }

  readToolResult(args: Record<string, unknown>): string {
    if (args.tool_call_id === undefined) {
      return this.toolCalls.filter(c => evidenceTools.has(c.name))
        .map(c => `[${c.index}] ${c.name} ${String(c.args.command ?? c.args.path ?? "").replace(/\s+/g, " ").slice(0, 70)}`)
        .join("\n") || "No prior evidence tools have run.";
    }
    const id = Number(args.tool_call_id);
    const call = this.toolCalls.find(c => c.index === id && evidenceTools.has(c.name));
    if (!Number.isInteger(id) || !call) return "Refused: tool_call_id must identify a prior command/file check.";
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const max = Math.min(8000, Math.max(200, Math.floor(Number(args.max_chars) || 6000)));
    const end = Math.min(offset + max, call.result.length);
    return `Original evidence tool call #${id} (${call.name}); characters ${offset}-${end} of ${call.result.length}. Cite #${id}, not this retrieval call. Sandbox capture elision markers mean uncaptured output; inspect saved output files for those portions.\n${call.result.slice(offset, end)}${end < call.result.length ? `\n[Use offset=${end} to continue.]` : ""}`;
  }
}