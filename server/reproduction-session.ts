import { createHash } from "node:crypto";
import type { ToolCallRecord } from "./model-service";
import { REPRODUCTION_BLOCKERS, REPRODUCTION_METHODS, VERDICTS, type RecordedResult } from "./prompts/reproduce";
import { ReproductionContextStore } from "./reproduction-context-store";

type ClaimValidator = (results: RecordedResult[], calls: readonly ToolCallRecord[]) => string[];
const evidenceTools = new Set(["run_command", "read_file", "list_files"]);
const serializedBytes = (value: string) => Buffer.byteLength(JSON.stringify(value), "utf8");
const finiteInteger = (value: unknown, fallback: number): number => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
};
const compactMetadata = (value: string, maxSerializedBytes = 80): string => {
  if (serializedBytes(JSON.stringify(value)) <= maxSerializedBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    if (serializedBytes(JSON.stringify(value.slice(0, length))) <= maxSerializedBytes) low = length;
    else high = length - 1;
  }
  return value.slice(0, low);
};

function boundedPage(
  text: string,
  offset: number,
  requested: number,
  limit: number,
  envelope: (chunk: string, end: number) => string,
): string {
  const start = Math.min(text.length, Math.max(0, Math.floor(offset) || 0));
  let low = 0;
  let high = Math.min(Math.max(0, requested), text.length - start);
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    const rendered = envelope(text.slice(start, start + length), start + length);
    if (serializedBytes(rendered) <= limit) low = length;
    else high = length - 1;
  }
  let rendered = envelope(text.slice(start, start + low), start + low);
  // Extremely long metadata must not be able to violate the hard response bound.
  if (serializedBytes(rendered) > limit) {
    rendered = JSON.stringify({ error: "Response metadata exceeds the byte limit.", offset: start });
  }
  return rendered;
}

function resizeChunk(
  chunk: string,
  limit: number,
  render: (shortened: string) => string,
): string | undefined {
  if (!chunk.length || !Number.isFinite(limit) || limit < 1) return undefined;
  let low = 1;
  let high = chunk.length;
  let best: string | undefined;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const candidate = render(chunk.slice(0, length));
    if (serializedBytes(candidate) <= limit) {
      best = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  return best;
}

/** Run-local evidence and accepted claims, independent of the model's compacted context. */
export class ReproductionSession {
  readonly recorded = new Map<string, RecordedResult>();
  readonly toolCalls: ToolCallRecord[] = [];
  private drafts = new Map<string, RecordedResult>();
  private rejected = new Map<string, string[]>();
  private capturedOutput: string | undefined;
  private progressKeys = new Set<string>();
  private completedIds = new Set<string>();
  private contexts = new ReproductionContextStore();
  private activeIndexRef: string | undefined;

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
      this.snapshotClaim(id, "accepted");
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
      this.snapshotClaim(id, "rejected", candidate, issues);
      return `Refused finalization of ${id}: ${issues.join("; ")}. Accepted state remains ${previous?.status ?? "pending"}. Use read_tool_result with the original tool_call_id to recover exact evidence; do not rerun an expensive experiment just to retrieve output. Resubmit record_result with corrected fields. ${this.summary()}`;
    }
    this.recorded.set(id, candidate);
    this.drafts.delete(id);
    this.rejected.delete(id);
    this.completedIds.add(id);
    this.snapshotClaim(id, "accepted");
    return `Recorded ${id} as ${status}; evidence validated. ${this.summary()}`;
  }

  summary(): string {
    return `Registered results: ${Array.from(this.recorded.values()).map(r => `${r.id}=${r.status}`).join(", ")}.`;
  }

  contextState(maxBytes = 2500): string {
    const limit = Math.max(4, finiteInteger(maxBytes, 2500));
    const claims = Array.from(this.recorded.values()).map(result => {
      const ref = this.snapshotClaim(result.id, "accepted").ref;
      const issues = this.rejected.get(result.id);
      return {
        id: Buffer.byteLength(result.id, "utf8") <= 100 ? result.id : undefined,
        status: result.status,
        ref,
        repair: issues?.length ? issues.join("; ").slice(0, 180) : undefined,
      };
    });
    claims.sort((a, b) => Number(Boolean(b.repair || b.status === "pending")) - Number(Boolean(a.repair || a.status === "pending")));
    const included: typeof claims = [];
    let output = "{}";
    for (const claim of claims) {
      const candidate = {
        authoritative: true,
        totals: {
          claims: claims.length,
          pending: claims.filter(c => c.status === "pending").length,
          repair: claims.filter(c => c.repair).length,
          shown: included.length + 1,
          omitted: claims.length - included.length - 1,
        },
        claims: [...included, claim],
        retrieval: "read_reproduction_context({ref}) for full immutable state; omit ref for the complete paged index",
      };
      const rendered = JSON.stringify(candidate);
      if (serializedBytes(rendered) > limit) break;
      included.push(claim);
      output = rendered;
    }
    if (!included.length) {
      const minimal = JSON.stringify({ totals: { claims: claims.length }, retrieval: "read_reproduction_context" });
      output = serializedBytes(minimal) <= limit ? minimal : "{}";
    }
    return output;
  }

  archiveContext(key: string, text: string): string {
    const entry = this.contexts.archive(String(key), String(text));
    return JSON.stringify({
      notice: "Archived unchanged; not scientific evidence.",
      ref: entry.ref,
      read: `read_reproduction_context({ref:"${entry.ref}"})`,
    });
  }

  readContext(args: Record<string, unknown>): string {
    let ref = args.ref === undefined ? undefined : String(args.ref);
    const offset = Math.max(0, finiteInteger(args.offset, 0));
    if (!ref) {
      if (offset === 0 || !this.activeIndexRef) {
        for (const id of Array.from(this.recorded.keys())) this.snapshotClaim(id, "accepted");
        const lines = this.contexts.list()
          .filter(entry => !entry.key.startsWith("context-index:"))
          .map(entry => `[${entry.ref}] ${entry.key} (${entry.text.length} characters)`);
        const index = lines.join("\n") || "No reproduction context has been archived.";
        this.activeIndexRef = this.contexts.archive(`context-index:${this.contexts.list().length}`, index).ref;
      }
      ref = this.activeIndexRef;
    }
    const entry = this.contexts.get(ref);
    if (!entry) return JSON.stringify({ error: "Refused: ref must identify archived reproduction context." });
    const requested = Math.min(8000, Math.max(1, finiteInteger(args.max_chars, 6000)));
    return boundedPage(entry.text, offset, requested, 6000, (chunk, end) => JSON.stringify({
      ref: entry.ref,
      key: compactMetadata(entry.key),
      offset: Math.min(entry.text.length, offset),
      end,
      total_chars: entry.text.length,
      next_offset: end < entry.text.length ? end : null,
      text: chunk,
      notice: "Retrieval only; this is not scientifically valid evidence.",
      read_next: end < entry.text.length
        ? `read_reproduction_context({ref:"${entry.ref}",offset:${end},max_chars:${requested}})`
        : null,
    }));
  }

  resizeRetrieval(
    name: string,
    _args: Record<string, unknown>,
    originalResult: string,
    maxBytes: number,
  ): string | undefined {
    const limit = finiteInteger(maxBytes, 0);
    if (name === "read_reproduction_context") {
      let page: Record<string, unknown>;
      try {
        page = JSON.parse(originalResult);
      } catch {
        return undefined;
      }
      const ref = typeof page.ref === "string" ? page.ref : undefined;
      const key = typeof page.key === "string" ? page.key : undefined;
      const text = typeof page.text === "string" ? page.text : undefined;
      const offset = Number(page.offset);
      const end = Number(page.end);
      const total = Number(page.total_chars);
      if (!ref || key === undefined || text === undefined
        || !Number.isInteger(offset) || !Number.isInteger(end) || !Number.isInteger(total)
        || offset < 0 || end < offset || total < end || text.length !== end - offset) return undefined;
      return resizeChunk(text, limit, shortened => {
        const newEnd = offset + shortened.length;
        return JSON.stringify({
          ref,
          key,
          offset,
          end: newEnd,
          total_chars: total,
          next_offset: newEnd < total ? newEnd : null,
          text: shortened,
          notice: "Retrieval only; this is not scientifically valid evidence.",
          read_next: newEnd < total
            ? `read_reproduction_context({ref:"${ref}",offset:${newEnd},max_chars:6000})`
            : null,
        });
      });
    }

    if (name !== "read_tool_result") return undefined;
    const evidence = originalResult.match(
      /^Original evidence tool call #(\d+) \(([^)\n]+)\); characters (\d+)-(\d+) of (\d+)\. Cite #\1, not this retrieval call\. Sandbox capture elision markers mean uncaptured output; inspect saved output files for those portions\.\n/,
    );
    if (evidence) {
      const start = Number(evidence[3]);
      const oldEnd = Number(evidence[4]);
      const total = Number(evidence[5]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(oldEnd)
        || !Number.isSafeInteger(total) || start < 0 || oldEnd < start || total < oldEnd) return undefined;
      let chunk = originalResult.slice(evidence[0].length);
      const footer = `\n[Use offset=${oldEnd} to continue.]`;
      if (oldEnd < total && chunk.endsWith(footer)) chunk = chunk.slice(0, -footer.length);
      if (chunk.length !== oldEnd - start) return undefined;
      return resizeChunk(chunk, limit, shortened => {
        const newEnd = start + shortened.length;
        return `Original evidence tool call #${evidence[1]} (${evidence[2]}); characters ${start}-${newEnd} of ${total}. Cite #${evidence[1]}, not this retrieval call. Sandbox capture elision markers mean uncaptured output; inspect saved output files for those portions.\n${shortened}${newEnd < total ? `\n[Use offset=${newEnd} to continue.]` : ""}`;
      });
    }

    const index = originalResult.match(/^Evidence index characters (\d+)-(\d+) of (\d+)\.\n/);
    if (!index) return undefined;
    const start = Number(index[1]);
    const oldEnd = Number(index[2]);
    const total = Number(index[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(oldEnd)
      || !Number.isSafeInteger(total) || start < 0 || oldEnd < start || total < oldEnd) return undefined;
    let chunk = originalResult.slice(index[0].length);
    const footer = `\n[Use read_tool_result offset=${oldEnd} to continue evidence index.]`;
    if (oldEnd < total && chunk.endsWith(footer)) chunk = chunk.slice(0, -footer.length);
    if (chunk.length !== oldEnd - start) return undefined;
    return resizeChunk(chunk, limit, shortened => {
      const newEnd = start + shortened.length;
      return `Evidence index characters ${start}-${newEnd} of ${total}.\n${shortened}${newEnd < total ? `\n[Use read_tool_result offset=${newEnd} to continue evidence index.]` : ""}`;
    });
  }

  private snapshotClaim(
    id: string,
    kind: "accepted" | "rejected",
    submitted?: RecordedResult,
    issues?: string[],
  ) {
    const text = JSON.stringify({
      claimId: id,
      kind,
      accepted: this.recorded.get(id),
      draft: submitted ?? this.drafts.get(id),
      issues: issues ?? this.rejected.get(id),
    });
    return this.contexts.archive(`claim:${id}:${kind}`, text);
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
      const index = this.toolCalls.filter(c => evidenceTools.has(c.name))
        .map(c => `[${c.index}] ${c.name} ${String(c.args.command ?? c.args.path ?? "").replace(/\s+/g, " ").slice(0, 70)}`)
        .join("\n") || "No prior evidence tools have run.";
      const offset = Math.max(0, finiteInteger(args.offset, 0));
      const requested = Math.min(8000, Math.max(1, finiteInteger(args.max_chars, 6000)));
      return boundedPage(index, offset, requested, 6000, (chunk, end) =>
        `Evidence index characters ${Math.min(offset, index.length)}-${end} of ${index.length}.\n${chunk}${end < index.length ? `\n[Use read_tool_result offset=${end} to continue evidence index.]` : ""}`);
    }
    const id = Number(args.tool_call_id);
    const call = this.toolCalls.find(c => c.index === id && evidenceTools.has(c.name));
    if (!Number.isInteger(id) || !call) return "Refused: tool_call_id must identify a prior command/file check.";
    const offset = Math.max(0, finiteInteger(args.offset, 0));
    const max = Math.min(8000, Math.max(1, finiteInteger(args.max_chars, 6000)));
    return boundedPage(call.result, offset, max, 6000, (chunk, end) =>
      `Original evidence tool call #${id} (${call.name}); characters ${Math.min(offset, call.result.length)}-${end} of ${call.result.length}. Cite #${id}, not this retrieval call. Sandbox capture elision markers mean uncaptured output; inspect saved output files for those portions.\n${chunk}${end < call.result.length ? `\n[Use offset=${end} to continue.]` : ""}`);
  }
}