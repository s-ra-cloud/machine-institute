import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ToolCallRecord } from "./model-service";
import { REPRODUCTION_BLOCKERS, REPRODUCTION_METHODS, VERDICTS, type RecordedResult } from "./prompts/reproduce";
import { ReproductionContextStore } from "./reproduction-context-store";
import type { QuestioningState } from "./reproduction-questioning";

type ClaimValidator = (results: RecordedResult[], calls: readonly ToolCallRecord[]) => string[];
const evidenceTools = new Set(["run_command", "read_file", "list_files"]);
const serializedBytes = (value: string) => Buffer.byteLength(JSON.stringify(value), "utf8");
// Leave 200 serialized bytes for the caller's separate recovery instruction.
const ACTIVE_INSTRUCTION_BYTES = 800;
const unicodePrefix = (text: string, length: number): string => {
  const prefix = text.slice(0, length);
  // Never split a supplementary Unicode character at an excerpt boundary.
  return /[\uD800-\uDBFF]$/.test(prefix) && /[\uDC00-\uDFFF]/.test(text.charAt(length))
    ? prefix.slice(0, -1) : prefix;
};
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
  questioning?: QuestioningState;
  readonly recorded = new Map<string, RecordedResult>();
  readonly toolCalls: ToolCallRecord[] = [];
  private drafts = new Map<string, RecordedResult>();
  private rejected = new Map<string, string[]>();
  private capturedOutput: string | undefined;
  private progressKeys = new Set<string>();
  private completedIds = new Set<string>();
  private acceptedStateChanges = 0;
  private contexts = new ReproductionContextStore();
  private activeIndexRef: string | undefined;
  private sourceGrounding?: { paperPath: string; paperText: string };
  private materialGrounding?: { inventoryPath: string; shippedPaths: Set<string>; readmePaths: Set<string> };
  private generatedPaths = new Set<string>();

  constructor(
    private validate: ClaimValidator,
    private onValidation?: (issues: string[]) => void,
  ) {}

  configureSourceGrounding(input: { paperPath: string; paperText: string }): void {
    this.sourceGrounding = { paperPath: input.paperPath, paperText: input.paperText };
  }

  /** A host-side canonical read, before sandbox allocation, with run-wide ID. */
  registerExtractedClaim(input: { claim: string; source_quote: string; original_value?: string; required_material?: string;
    packet: { start: number; end: number; text: string } }): void {
    if (!this.sourceGrounding || this.sourceGrounding.paperText.slice(input.packet.start, input.packet.end) !== input.packet.text)
      throw new Error("Extraction packet does not match canonical source.");
    const index = this.toolCalls.length + 1;
    this.observeToolCall({ index, name: "read_file", args: { path: this.sourceGrounding.paperPath, offset: input.packet.start },
      result: `Verified file: ${this.sourceGrounding.paperPath}\nReturned characters: ${input.packet.start}-${input.packet.end} of ${this.sourceGrounding.paperText.length}\n---\n${input.packet.text}`,
      durationMs: 0, error: false });
    const response = this.recordResult({ id: `R${this.recorded.size + 1}`, claim: input.claim,
      status: "pending", source_quote: input.source_quote, source_location: `characters ${input.packet.start}-${input.packet.end}`,
      source_tool_call_id: index, original_value: input.original_value, required_material: input.required_material });
    if (!response.startsWith("Registered ")) throw new Error(`Extraction registration failed: ${response}`);
  }

  configureMaterialGrounding(input: {
    inventoryPath: string;
    shippedPaths: readonly string[];
    readmePaths?: readonly string[];
  }): void {
    this.materialGrounding = {
      inventoryPath: input.inventoryPath,
      shippedPaths: new Set(input.shippedPaths.map(path => posix.normalize(path))),
      readmePaths: new Set((input.readmePaths || []).map(path => posix.normalize(path))),
    };
  }

  noteGeneratedPath(path: string): void {
    this.generatedPaths.add(posix.normalize(path));
  }

  /**
   * Refuse only an unambiguous, direct Python script invocation. Commands with
   * shell syntax are deliberately left to bash; this is not a shell parser.
   */
  validateCommand(command: string): string | undefined {
    if (!this.materialGrounding || /[|;&><`$()]/.test(command)) return undefined;
    const match = command.trim().match(/^python(?:3)?(?:\s+-u)?\s+((?:\/work\/)?[A-Za-z0-9_./-]+\.py)(?:\s+[^|;&><`]*)?$/);
    if (!match) return undefined;
    const path = posix.normalize(match[1].startsWith("/") ? match[1] : posix.join("/work", match[1]));
    if (this.materialGrounding.shippedPaths.has(path) || this.generatedPaths.has(path)) return undefined;
    return `Refused: ${path} is not a verified shipped or generated script. Inspect /work/MATERIALS_INDEX.md and the shipped README/files, or create the script with write_file before executing it. A guessed nonexistent path is not evidence of a missing scientific material.`;
  }

  private reportValidation(issues: string[]): void {
    try { this.onValidation?.([...issues]); } catch { /* Observability must not alter accepted state. */ }
  }

  private acceptedStateForRepair(args: Record<string, unknown>): string {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    const accepted = this.recorded.get(id);
    if (!accepted) {
      return "No accepted claim was changed. Recover existing identities with read_reproduction_context before updating a pending claim; do not guess an id or register it again.";
    }
    const ref = this.snapshotClaim(id, "accepted").ref;
    return `Accepted id=${JSON.stringify(id)} remains ${accepted.status}; recover its exact claim with read_reproduction_context(ref="${ref}"). Correct the named fields and update this same id; do not register it again.`;
  }

  get progress(): number {
    return this.acceptedStateChanges + this.progressKeys.size + this.completedIds.size
      + (this.questioning?.assessment ? 1 : 0) + (this.questioning?.changes.length ?? 0);
  }

  captureOutput(name: string, result: string): void {
    this.capturedOutput = evidenceTools.has(name) ? result : undefined;
  }

  observeToolCall(record: ToolCallRecord): void {
    const full = { ...record, result: this.capturedOutput ?? record.result };
    this.capturedOutput = undefined;
    this.toolCalls.push(full);
    if (!full.error && full.name === "read_file" && /\.py$/i.test(String(full.args.path || ""))
      && /^Verified file:/m.test(full.result)) {
      // A successful explicit inspection proves a script generated by an
      // earlier shell command now exists, without attempting to parse shell.
      this.generatedPaths.add(posix.normalize(String(full.args.path)));
    }
    if (!full.error && full.name === "run_command" && !/^(?:Refused:|Tool budget exhausted|Deadline exhausted)/.test(full.result)) {
      // Only execution advances recovery. Unique reads, listings, and archive
      // retrievals are orientation, not scientific progress.
      const output = full.result.replace(/^(exit code \S+|TIMED OUT) \([\d.]+s\)/, "$1");
      const command = String(full.args.command ?? "").replace(/\s+/g, " ").trim();
      const key = createHash("sha256").update(`${command}\n${output}`).digest("hex");
      this.progressKeys.add(key);
    }
  }

  recordResult(args: Record<string, unknown>): string {
    const stringFields = ["id", "claim", "status", "original_value", "reproduced_value", "evidence", "notes", "method", "blocker_kind", "evidence_excerpt", "raw_input_path", "source_quote", "source_location", "required_material"];
    const typeErrors = stringFields.filter(key => args[key] !== undefined && typeof args[key] !== "string")
      .map(key => `${key} must be a string`);
    if (args.evidence_tool_call_ids !== undefined && (!Array.isArray(args.evidence_tool_call_ids)
      || !args.evidence_tool_call_ids.every(id => typeof id === "number" && Number.isSafeInteger(id)))) {
      typeErrors.push("evidence_tool_call_ids must be an array of integers");
    }
    if (args.raw_input_tool_call_id !== undefined
      && (typeof args.raw_input_tool_call_id !== "number" || !Number.isSafeInteger(args.raw_input_tool_call_id))) {
      typeErrors.push("raw_input_tool_call_id must be an integer");
    }
    if (args.source_tool_call_id !== undefined
      && (typeof args.source_tool_call_id !== "number" || !Number.isSafeInteger(args.source_tool_call_id))) {
      typeErrors.push("source_tool_call_id must be an integer");
    }
    if (typeErrors.length) {
      this.reportValidation(typeErrors);
      return `Refused: ${typeErrors.join("; ")}. ${this.acceptedStateForRepair(args)}`;
    }
    const id = String(args.id || "").trim();
    const previous = this.recorded.get(id);
    const claim = String(args.claim ?? previous?.claim ?? "").trim();
    const status = args.status;
    const missing = [
      ...(!id ? ["id is required and must be a nonempty string"] : []),
      ...(!claim ? [
        previous
          ? "claim must be nonempty when supplied on an update; omit claim to preserve the accepted claim"
          : "claim is required and must be nonempty for a new result",
      ] : []),
    ];
    if (missing.length) {
      this.reportValidation(missing);
      return `Refused: ${missing.join("; ")}. ${this.acceptedStateForRepair(args)}`;
    }
    if (typeof status !== "string" || (status !== "pending" && !(VERDICTS as readonly string[]).includes(status))) {
      const issues = ["status must be pending, verified, falsified, toy, or inconclusive"];
      this.reportValidation(issues);
      return `Refused: ${issues[0]}. ${this.acceptedStateForRepair(args)}`;
    }
    if (!previous && status !== "pending" && this.sourceGrounding) {
      const issues = ["a new source-grounded claim must first be registered pending with source_quote, source_location, and source_tool_call_id"];
      this.reportValidation(issues);
      return `Refused new claim ${id}: ${issues[0]}. No claim was registered; final-first submission cannot bypass paper-source validation.`;
    }
    if (status === "pending") {
      if (previous) {
        const ref = this.snapshotClaim(id, "accepted").ref;
        return `Unchanged: ${id} remains ${previous.status}; an existing result cannot be reset by registering it again. Read accepted state with read_reproduction_context(ref="${ref}"). ${
          previous.status === "pending"
            ? "Next: perform the claim-specific experiment or inspect its real blocker, recover original evidence with read_tool_result, then update this same id with a non-pending status, method, evidence_tool_call_ids and exact evidence_excerpt. Do not register this claim again."
            : "This claim is already finalized; work on other pending claims or return the final logbook."
        }`;
      }
      const sourceQuote = typeof args.source_quote === "string" ? args.source_quote.trim() : "";
      const sourceLocation = typeof args.source_location === "string" ? args.source_location.trim() : "";
      const sourceToolCallId = args.source_tool_call_id as number | undefined;
      if (this.sourceGrounding) {
        const sourceCall = this.toolCalls.find(call =>
          call.index === sourceToolCallId
          && call.name === "read_file"
          && !call.error
          && String(call.args.path || "") === this.sourceGrounding!.paperPath
          && call.result.includes(sourceQuote),
        );
        const substantial = sourceQuote.length >= 24 && sourceQuote.split(/\s+/).length >= 5;
        const canonicalQuote = this.sourceGrounding.paperText.includes(sourceQuote);
        const returnedRange = sourceCall?.result.match(/^Returned characters:\s*(\d+)-(\d+)\s+of\s+\d+$/m);
        const pageStart = returnedRange ? Number(returnedRange[1]) : -1;
        const pageEnd = returnedRange ? Number(returnedRange[2]) : -1;
        const quoteStart = this.sourceGrounding.paperText.indexOf(sourceQuote, Math.max(0, pageStart));
        const verifiedLocation = sourceLocation === `characters ${pageStart}-${pageEnd}`
          && quoteStart >= pageStart && quoteStart + sourceQuote.length <= pageEnd;
        const verbatimClaim = sourceQuote.includes(claim);
        const originalValue = args.original_value == null ? "" : String(args.original_value).trim();
        const sourceIssues = [
          ...(!substantial ? ["source_quote must be a substantial exact paper quotation (at least 24 characters and 5 words)"] : []),
          ...(!sourceCall ? [`source_tool_call_id must cite a prior read_file of ${this.sourceGrounding.paperPath} containing source_quote`] : []),
          ...(!canonicalQuote ? ["source_quote does not occur exactly in the canonical paper"] : []),
          ...(!verifiedLocation ? ["source_location must copy the cited read_file page's verified \"characters START-END\" range containing source_quote"] : []),
          ...(!verbatimClaim ? ["claim must be a verbatim statement contained in source_quote; paraphrase is not source verification"] : []),
          ...(originalValue && !sourceQuote.includes(originalValue) ? ["original_value must occur verbatim in source_quote"] : []),
        ];
        if (sourceIssues.length) {
          this.reportValidation(sourceIssues);
          return `Refused new claim ${id}: ${sourceIssues.join("; ")}. No claim was registered; read the canonical paper and quote it exactly rather than guessing.`;
        }
      }
      this.recorded.set(id, {
        id, claim, status,
        originalValue: args.original_value == null ? undefined : String(args.original_value),
        sourceQuote: sourceQuote || undefined,
        sourceLocation: sourceLocation || undefined,
        sourceToolCallId,
        requiredMaterial: typeof args.required_material === "string" ? args.required_material.trim() || undefined : undefined,
      });
      this.acceptedStateChanges++;
      this.snapshotClaim(id, "accepted");
      return `Registered ${id} as pending. ${this.summary()}`;
    }

    const base = this.drafts.get(id) ?? previous;
    const stringField = (key: string, old?: string) => args[key] === undefined ? old : String(args[key]);
    const groundedOriginalValue = previous?.sourceQuote ? previous.originalValue : undefined;
    const candidate: RecordedResult = {
      ...base, id, claim, status: status as RecordedResult["status"],
      originalValue: previous?.sourceQuote
        ? groundedOriginalValue
        : stringField("original_value", base?.originalValue),
      reproducedValue: stringField("reproduced_value", base?.reproducedValue),
      evidence: stringField("evidence", base?.evidence),
      notes: stringField("notes", base?.notes),
      method: stringField("method", base?.method) as RecordedResult["method"],
      blockerKind: stringField("blocker_kind", base?.blockerKind) as RecordedResult["blockerKind"],
      evidenceExcerpt: stringField("evidence_excerpt", base?.evidenceExcerpt),
      evidenceToolCallIds: args.evidence_tool_call_ids === undefined
        ? base?.evidenceToolCallIds
        : args.evidence_tool_call_ids as number[],
      rawInputPath: stringField("raw_input_path", base?.rawInputPath),
      rawInputToolCallId: args.raw_input_tool_call_id === undefined ? base?.rawInputToolCallId : args.raw_input_tool_call_id as number,
      sourceQuote: previous?.sourceQuote ?? base?.sourceQuote,
      sourceLocation: previous?.sourceLocation ?? base?.sourceLocation,
      sourceToolCallId: previous?.sourceToolCallId ?? base?.sourceToolCallId,
      requiredMaterial: stringField("required_material", base?.requiredMaterial),
    };
    const issues: string[] = [];
    if (previous && args.claim !== undefined && claim !== previous.claim) {
      issues.push(`${id} cannot replace its source-grounded claim on update`);
    }
    if (previous?.sourceQuote && args.original_value !== undefined
      && String(args.original_value) !== (previous.originalValue ?? "")) {
      issues.push(`${id} cannot replace its source-grounded original_value on update`);
    }
    if (!(REPRODUCTION_METHODS as readonly unknown[]).includes(candidate.method)) issues.push(`${id} has an invalid reproduction method`);
    if (candidate.blockerKind && !(REPRODUCTION_BLOCKERS as readonly unknown[]).includes(candidate.blockerKind)) issues.push(`${id} has an invalid blocker kind`);
    if (candidate.method === "blocked" && candidate.blockerKind === "missing-material" && this.materialGrounding) {
      const required = candidate.requiredMaterial?.trim() || "";
      if (!required || !candidate.sourceQuote?.toLocaleLowerCase().includes(required.toLocaleLowerCase())) {
        issues.push(`${id} missing-material blocker must name required_material using wording present in its verified paper source_quote`);
      }
      const inspected = new Set((candidate.evidenceToolCallIds || []).map(index =>
        this.toolCalls.find(call => call.index === index && call.name === "read_file"),
      ).filter(Boolean).map(call => posix.normalize(String(call!.args.path || ""))));
      const requiredInspections = [this.materialGrounding.inventoryPath, ...Array.from(this.materialGrounding.readmePaths)];
      if (requiredInspections.some(path => !inspected.has(path))) {
        issues.push(`${id} missing-material blocker must cite read_file inspection of the shipped material inventory and README provenance`);
      }
    }
    if ((candidate.evidenceToolCallIds ?? []).some(index => !Number.isInteger(index) || !this.toolCalls.some(c => c.index === index && evidenceTools.has(c.name)))) {
      issues.push(`${id} evidence IDs must name prior command/file checks, not future calls or cached-output retrievals`);
    }
    issues.push(...this.validate([candidate], this.toolCalls));
    if (issues.length) {
      this.reportValidation(issues);
      this.drafts.set(id, candidate);
      this.rejected.set(id, issues);
      // A rejected first submission must not make the claim disappear.
      if (!previous) this.recorded.set(id, { id, claim, status: "pending", originalValue: candidate.originalValue });
      this.snapshotClaim(id, "rejected", candidate, issues);
      return `Refused finalization of ${id}: ${issues.join("; ")}. Accepted state remains ${previous?.status ?? "pending"}. Use read_tool_result with the original tool_call_id to recover exact evidence; do not rerun an expensive experiment just to retrieve output. Resubmit record_result with corrected fields. ${this.acceptedStateForRepair(args)} ${this.summary()}`;
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

  /**
   * Small, authoritative next action that survives transcript compaction.
   * It intentionally describes only accepted state and never invents claim
   * identities, values, evidence, or missing record_result fields.
   * Navigation is subordinate and included whole only if the composed string
   * fits 800 JSON-serialized UTF-8 bytes (reserving caller recovery space).
   */
  activeInstruction(navigation?: string): string {
    const results = Array.from(this.recorded.values());
    const pending = results.filter(result => result.status === "pending");
    let action: string;
    if (this.questioning) {
      const q = this.questioning;
      const decision = q.assessment?.decision;
      const next = !decision
        ? "Inspect paper, inventory and materials; register claims; call assess_suitability before execution."
        : decision === "blocked"
          ? "Assessment records no defensible analysis; write/execute disabled. Report the recorded limitation, then return all four logbook sections."
          : decision === "adapt"
            ? "Only planned working-copy edits are allowed; apply every planned adaptation before execution. Adapted results are separate from original reproduction; return all four logbook sections."
            : "Use suitable code unchanged (scientific edits disabled). Continue claim-specific work, then return all four logbook sections.";
      // Never inline an unbounded limitation; qp:metadata retains it exactly.
      action = `qP phase: ${decision ?? "assessment (inspection only; write/execute disabled)"}. Full authoritative metadata: read_reproduction_context(ref="qp:metadata"). Page referenced source/output with ref="qp:blob:SHA256". ${q.limitation ? "Limitation recorded: write/execute/setup disabled; report it without inventing inputs. " : ""}${q.limitation && decision ? "Report the recorded limitation, then return all four logbook sections." : next}`;
    } else {
      const commands = this.toolCalls.filter(call =>
        call.name === "run_command"
        && !call.error
        && !/^(?:Refused:|Tool budget exhausted|Deadline exhausted)/.test(call.result),
      );
      if (results.length === 0) {
        action = "LATEST ACTION — EXTRACT: no claims are accepted. Search targeted sections of /work/paper.md for actual core quantitative claims, then register them pending. Do not repeat the first page, invent claims, return a plan, or return an archive notice.";
      } else if (pending.length > 0 && commands.length === 0) {
        action = `LATEST ACTION — PREPARE/EXECUTE: ${pending.length} accepted claim(s) remain pending and no command has run. Inspect the relevant script/data, then run the claim-specific experiment; if genuinely impossible, inspect the real blocker. Do not re-register claims, return a plan, or return an archive notice.`;
      } else if (pending.length > 0) {
        action = `LATEST ACTION — ASSESS/RECORD: command output exists and ${pending.length} accepted claim(s) remain pending. First assess whether output supports the relevant claim or a real blocker. Record only supported outcomes with exact original evidence; otherwise prepare/run the missing claim experiment. Reuse completed outputs; do not fabricate fields, return a plan, or return an archive notice.`;
      } else {
        action = "LATEST ACTION — REPORT: every accepted claim is finalized. Retrieve archived claim details or evidence if needed, then return the required final logbook from accepted state and cited evidence. Do not rerun experiments, invent values, return a plan, or return an archive/retrieval notice.";
      }
    }
    if (pending.length) action = this.withPendingGuidance(action, pending);
    const withNavigation = `${action}\nSubordinate navigation (after the action above): ${navigation}`;
    return navigation && serializedBytes(withNavigation) <= ACTIVE_INSTRUCTION_BYTES ? withNavigation : action;
  }

  private withPendingGuidance(action: string, pending: RecordedResult[]): string {
    const claim = pending[0];
    const ref = this.snapshotClaim(claim.id, "accepted").ref;
    // An identity is either exact or explicitly omitted, never an excerpt.
    const id = serializedBytes(JSON.stringify(claim.id)) <= 100
      ? `id=${JSON.stringify(claim.id)}` : "id omitted; recover exact id from ref";
    const source = claim.sourceToolCallId === undefined
      ? "source_tool_call_id not recorded; recover provenance, do not guess"
      : `source_tool_call_id=${claim.sourceToolCallId} (original paper read)`;
    const retrieval = `Full accepted state: read_reproduction_context(ref="${ref}").`;
    const other = pending.length > 1 ? " Other pending claims: read_reproduction_context (paged index)." : "";
    const render = (text: string, excerpt: boolean) =>
      `${action}\nPending ${id}; ${source}; claim${excerpt ? " excerpt" : ""}=${JSON.stringify(text)}${excerpt ? " [excerpt; omitted text in ref]" : ""}. ${retrieval}${other} Never guess values.`;
    const full = render(claim.claim, false);
    if (serializedBytes(full) <= ACTIVE_INSTRUCTION_BYTES) return full;
    // Binary search only works when the empty envelope itself fits. Preserve
    // phase gates and exact identity/provenance (or their immutable ref), not
    // optional index hints or an empty excerpt, when fixed overhead is large.
    if (serializedBytes(render("", true)) > ACTIVE_INSTRUCTION_BYTES) {
      const compact = `${action}\nPending ${id}; ${source}; claim omitted; ${retrieval} Never guess values.`;
      if (serializedBytes(compact) <= ACTIVE_INSTRUCTION_BYTES) return compact;
      const referenced = `${action}\nPending id/claim/source omitted; recover exact accepted state: read_reproduction_context(ref="${ref}"). Never guess values.`;
      if (serializedBytes(referenced) <= ACTIVE_INSTRUCTION_BYTES) return referenced;
      // Never silently truncate authoritative gates or return an oversized
      // instruction if a future action template outgrows the hard envelope.
      throw new Error("Authoritative reproduction action and claim reference exceed the active instruction byte limit.");
    }
    let low = 0;
    let high = claim.claim.length;
    while (low < high) {
      const length = Math.ceil((low + high) / 2);
      if (serializedBytes(render(unicodePrefix(claim.claim, length), true)) <= ACTIVE_INSTRUCTION_BYTES) low = length;
      else high = length - 1;
    }
    return render(unicodePrefix(claim.claim, low), true);
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
    // Dynamic content-addressed retrieval: never archive a new full provenance
    // payload on every turn. Source strings remain solely in the blob store.
    const qpText = this.questioning && ref === "qp:metadata" ? JSON.stringify(this.questioning.metadata())
      : this.questioning && ref?.startsWith("qp:blob:") ? this.questioning.readBlob(ref.slice("qp:blob:".length)) : undefined;
    const entry = qpText !== undefined ? { ref, key: ref, text: qpText } : this.contexts.get(ref);
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