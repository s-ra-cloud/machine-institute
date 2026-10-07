import type { ToolCallRecord } from "./model-service";
import { isPlannedEntrypoint } from "./reproduction-entrypoint";

type EvidenceCall = Pick<ToolCallRecord, "index" | "name" | "args" | "result" | "error">;

/** File-format eligibility only; this does not prove data are raw observations. */
export function isSupportedRawInputPath(path: string): boolean {
  return /\.(?:csv|tsv|jsonl?|parquet|arrow|npy|npz|pt|pkl|pickle)$/i.test(path);
}

/** Completeness of a shared handoff, not validation of a scientific verdict. */
export function sharedMeasurementIssue(ids: string[], value: unknown, calls: readonly EvidenceCall[]): string | undefined {
  if (ids.length < 2) return;
  if (!Array.isArray(value) || value.length !== ids.length)
    return "Account for every grouped claim in measurements: cite a command's exact evidence_excerpt and evidence_tool_call_id, or state a limitation for its missing measurement.";
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || !ids.includes(item.claimId) || seen.has(item.claimId))
      return "Measurement entries must name each grouped claim exactly once.";
    seen.add(item.claimId);
    if (typeof item.limitation === "string" && item.limitation.trim() && item.limitation.length <= 2000) continue;
    const call = calls.find(c => c.index === item.evidence_tool_call_id && c.name === "run_command"
      && !c.error && /^exit code 0\b/.test(c.result));
    if (!call || typeof item.evidence_excerpt !== "string" || item.evidence_excerpt.trim().length < 8
      || item.evidence_excerpt.length > 2000 || !call.result.includes(item.evidence_excerpt))
      return `Claim ${item.claimId} needs an exact excerpt from a captured successful command, or an explicit missing-measurement limitation. File reads alone are not an experiment.`;
  }
}

/** A reuse hint, never a cached execution result or a scientific verdict. */
export function repeatExecutionRefusal(calls: readonly EvidenceCall[], paths: string[], args: Record<string, unknown>): string | undefined {
  if (typeof args.repeat_reason === "string" && args.repeat_reason.trim()) return;
  const command = String(args.command ?? "").trim();
  if (!isPlannedEntrypoint(command, paths)) return;
  const previous = [...calls].reverse().find(call => call.name === "run_command" && !call.error
    && /^exit code 0\b/.test(call.result)
    && String(call.args.command ?? "").trim() === command
    && (call.args.working_directory ?? "/work") === (args.working_directory ?? "/work"));
  if (!previous) return;
  return `Refused duplicate execution: this command already succeeded in original tool call #${previous.index}. Use read_tool_result tool_call_id=${previous.index} to inspect whether that output covers this claim, then submit_for_assessment if sufficient. This does not verify the claim or assert unchanged inputs. If a fresh experiment is necessary (changed code/inputs, independent repetition, or missing measurements), resubmit run_command with repeat_reason explaining why. Never relabel retrieved output as a new execution.`;
}

/** Navigation only: original tool results remain the authoritative evidence. */
export function executionEvidenceIndex(calls: readonly EvidenceCall[]) {
  return calls.filter(call => call.name === "run_command").slice(-12).map(call => ({
    id: call.index,
    command: String(call.args.command ?? "").slice(0, 180),
    status: call.result.split("\n", 1)[0].slice(0, 120),
    successful: !call.error && /^exit code 0\b/.test(call.result),
    characters: call.result.length,
    retrieve: { tool_call_id: call.index, offset: 0, max_chars: 2000 },
    retrieveTail: { tool_call_id: call.index, offset: Math.max(0, call.result.length - 2000), max_chars: 2000 },
  }));
}

export function executionRecoveryExcerpt(call: EvidenceCall): string {
  // Long stdout must not hide the traceback at the end of a failed command.
  return call.name === "run_command" && !/^exit code 0\b/.test(call.result)
    ? `${call.result.split("\n", 1)[0].slice(0, 80)}\n${call.result.slice(-300)}`
    : call.result.slice(0, 400);
}

/** Explain the first unmet condition without relaxing the same-execution check. */
export function rerunEvidenceIssue(calls: readonly EvidenceCall[], paths: string[], args: Record<string, unknown>): string | undefined {
  const ids = Array.isArray(args.evidence_tool_call_ids) ? args.evidence_tool_call_ids : [];
  const cited = calls.filter(call => call.name === "run_command" && ids.includes(call.index));
  if (!cited.length) return "Cite the original run_command ID, not a read_file or read_tool_result ID. Use executionEvidence in the stage packet.";
  const successful = cited.filter(call => !call.error && /^exit code 0\b/.test(call.result));
  if (!successful.length) return "The cited executions did not succeed. Retrieve their error tails; request_plan_revision to repair and rerun, or report only an evidenced blocker. Do not relabel a failed run as successful.";
  const sources = successful.filter(call => isPlannedEntrypoint(String(call.args.command ?? ""), paths));
  if (!sources.length) return "The cited successful command is not a standalone planned source entrypoint. A CSV display or setup command is not a rerun.";
  const excerpt = typeof args.evidence_excerpt === "string" ? args.evidence_excerpt.trim() : "";
  const matching = sources.filter(call => excerpt.length >= 4 && call.result.includes(excerpt));
  if (!matching.length) return "evidence_excerpt must be copied exactly from one cited successful source execution. Retrieve its measurement page; do not paraphrase, combine outputs or change whitespace.";
  const value = typeof args.reproduced_value === "string" ? args.reproduced_value.trim() : "";
  if (!value || !excerpt.includes(value)) return "reproduced_value must occur literally inside evidence_excerpt. Copy the observed measurement text without rounding, relabelling or joining separated values; explain comparisons in notes.";
}
