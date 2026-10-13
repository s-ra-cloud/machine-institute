import type { ToolCallRecord } from "./model-service";
import { isPlannedEntrypoint } from "./reproduction-entrypoint";

type EvidenceCall = Pick<ToolCallRecord, "index" | "name" | "args" | "result" | "error">;

/**
 * Whitespace-insensitive excerpt location. Models copying a table or a wrapped line collapse runs of
 * spaces and newlines; that changes no content, so it must not turn a real quote into a refusal.
 * Returns raw offsets into `output` so callers can show the surrounding context.
 */
export function findExcerpt(output: string, excerpt: string): { start: number; end: number } | undefined {
  const wanted = excerpt.trim();
  if (!wanted) return undefined;
  const exact = output.indexOf(wanted);
  if (exact >= 0) return { start: exact, end: exact + wanted.length };
  const normalizedOutput = normalizeWhitespace(output);
  const position = normalizedOutput.text.indexOf(normalizeWhitespace(wanted).text);
  if (position < 0) return undefined;
  const length = normalizeWhitespace(wanted).text.length;
  return { start: normalizedOutput.offsets[position], end: normalizedOutput.offsets[position + length - 1] + 1 };
}

export function containsExcerpt(output: string, excerpt: string): boolean {
  return findExcerpt(output, excerpt) !== undefined;
}

/** Tell the model where its quote stops matching, so the next attempt is a correction rather than a blind retry. */
export function excerptMismatchHint(output: string, excerpt: string): string {
  const wanted = normalizeWhitespace(excerpt.trim()).text;
  const haystack = normalizeWhitespace(output).text;
  const minimum = 12;
  if (wanted.length < minimum) return `The excerpt is too short to locate; quote at least ${minimum} characters.`;
  // Longest prefix of the excerpt that occurs somewhere in the output (containment is monotone in prefix length).
  let low = 0;
  let high = wanted.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (haystack.includes(wanted.slice(0, mid))) low = mid; else high = mid - 1;
  }
  if (low < minimum) return `No ${minimum}-character run from the start of the excerpt occurs in the cited output; it is paraphrased or taken from a different tool call. Copy one distinctive line verbatim from the output.`;
  const at = haystack.indexOf(wanted.slice(0, low));
  const quote = (text: string) => JSON.stringify(text);
  return `The excerpt matches the output through ${quote(wanted.slice(Math.max(0, low - 40), low))}, then diverges: the output continues ${quote(haystack.slice(at + low, at + low + 60))} but the excerpt continues ${quote(wanted.slice(low, low + 60))}.`;
}

function normalizeWhitespace(text: string): { text: string; offsets: number[] } {
  let normalized = "";
  const offsets: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (/\s/.test(char)) { pendingSpace = normalized.length > 0; continue; }
    if (pendingSpace) { normalized += " "; offsets.push(i - 1); pendingSpace = false; }
    normalized += char;
    offsets.push(i);
  }
  return { text: normalized, offsets };
}

/** File-format eligibility only; this does not prove data are raw observations. */
export function isSupportedRawInputPath(path: string): boolean {
  return /\.(?:csv|tsv|jsonl?|parquet|arrow|npy|npz|pt|pkl|pickle)$/i.test(path);
}

/** Completeness of a shared handoff, not validation of a scientific verdict. */
export function sharedMeasurementIssue(ids: string[], value: unknown, calls: readonly EvidenceCall[], rerunPaths?: string[]): string | undefined {
  if (ids.length < 2) return;
  if (!Array.isArray(value) || value.length !== ids.length)
    return "Account for every grouped claim in measurements: cite its original successful evidence_tool_call_id, or state a limitation for its missing measurement. Do not transcribe output in this handoff.";
  const eligible = calls.filter(c => c.name === "run_command" && !c.error && /^exit code 0\b/.test(c.result)
    && (!rerunPaths || isPlannedEntrypoint(String(c.args.command ?? ""), rerunPaths)));
  const references = eligible.slice(-12).map(c => c.index).join(", ") || "none";
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || !ids.includes(item.claimId) || seen.has(item.claimId))
      return "Measurement entries must name each grouped claim exactly once.";
    seen.add(item.claimId);
    if (typeof item.limitation === "string" && item.limitation.trim() && item.limitation.length <= 2000) continue;
    const call = eligible.find(c => c.index === item.evidence_tool_call_id);
    if (!call) {
      const cited = calls.find(c => c.index === item.evidence_tool_call_id);
      const reason = !cited ? "unknown original tool ID" : cited.name !== "run_command"
        ? `${cited.name} is not an execution` : cited.error || !/^exit code 0\b/.test(cited.result)
          ? "execution did not succeed" : "not a standalone planned source execution";
      const supplied = Number.isSafeInteger(item.evidence_tool_call_id) ? item.evidence_tool_call_id : "missing or invalid";
      return `Claim ${item.claimId}: ${reason} (supplied ID: ${supplied}). Eligible original execution IDs: ${references}. Cite one only if it covers this measurement, otherwise state a limitation. Reading or manually reprinting an output is not a new source experiment.`;
    }
    // Legacy callers can still supply a quote, but normal stage handoffs use
    // original execution references only. Exact quotes belong to assessment.
    if (item.evidence_excerpt !== undefined && (typeof item.evidence_excerpt !== "string" || item.evidence_excerpt.trim().length < 8
      || item.evidence_excerpt.length > 2000 || !call.result.includes(item.evidence_excerpt))
    ) return `Claim ${item.claimId}: the supplied quote differs from original execution #${call.index}. Omit evidence_excerpt and hand off the original execution ID instead. Exact quotation and scientific validation remain required during assessment.`;
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
  const matching = sources.filter(call => excerpt.length >= 4 && containsExcerpt(call.result, excerpt));
  if (!matching.length) return `evidence_excerpt must be copied exactly from one cited successful source execution (#${sources.map(call => call.index).join(", #")}); do not paraphrase or combine outputs. ${excerptMismatchHint(sources[sources.length - 1].result, excerpt)} Retrieve the measurement page with read_tool_result if needed.`;
  const value = typeof args.reproduced_value === "string" ? args.reproduced_value.trim() : "";
  if (!value || !excerpt.includes(value)) return "reproduced_value must occur literally inside evidence_excerpt. Copy the observed measurement text without rounding, relabelling or joining separated values; explain comparisons in notes.";
}
