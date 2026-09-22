import { posix } from "node:path";
import type { ToolCallRecord, ToolSpec } from "./model-service";
import type { RecordedResult, ClaimVerdict } from "./prompts/reproduce";
import { QP_DEPENDENCIES } from "./reproduction-isolation";
import { QuestioningBlobStore, QuestioningProvenanceLimitError, QUESTIONING_PROVENANCE_LIMITS, serializedBytes, type QuestioningProvenanceRecord } from "./reproduction-provenance-store";

const clip = (text: string, length: number) => text.length <= length ? text : `${text.slice(0, length)} [excerpt; full text in provenance]`;
export interface SuitabilityAssessment {
  research_question: string;
  question_quote: string;
  decision: "suitable" | "adapt" | "blocked";
  rationale: string;
  claim_ids: string[];
  evidence: Array<{ tool_call_id: number; excerpt: string }>;
  intended_changes: string;
  comparability: string;
  planned_changes?: Array<{ path: string; reason: string; claim_ids: string[] }>;
}
export const QUESTIONING_TOOL: ToolSpec = {
  name: "assess_suitability",
  description: "Commit evidence-grounded question-to-code assessment before any write or execution. Immutable once accepted. Inspect paper, inventory, code and data first. JSON assessment must contain research_question, question_quote (exact paper quote), decision (suitable/adapt/blocked), rationale, claim_ids, evidence [{tool_call_id,excerpt}], intended_changes, comparability. adapt additionally requires planned_changes [{path:'/work/working/...',reason,claim_ids}]; only these paths may be edited. blocked honestly records missing materials; no arbitrary execution is available in assessment.",
  parameters: { type: "object", properties: { assessment: { type: "string", description: "JSON assessment object" } }, required: ["assessment"] },
};
export const QUESTIONING_SETUP_TOOL: ToolSpec = {
  name: "setup_environment",
  description: "Available during inspection: install fixed, approved binary scientific packages without arbitrary commands, source builds, imports or scientific execution. Packages install to /work/python-packages, separate from protected materials. This is setup, never scientific evidence.",
  parameters: { type: "object", properties: { packages: { type: "array", items: { type: "string", enum: ["numpy", "scipy", "pandas", "scikit-learn", "statsmodels"] } } }, required: ["packages"] },
};
export function questioningSetupCommand(packages: unknown): string[] | undefined {
  const approved: Record<string, string> = { numpy: "numpy==2.2.6", scipy: "scipy==1.15.3", pandas: "pandas==2.2.3", "scikit-learn": "scikit-learn==1.6.1", statsmodels: "statsmodels==0.14.4" };
  if (!Array.isArray(packages) || !packages.length || packages.length > 5 || packages.some(p => typeof p !== "string" || !Object.hasOwn(approved, p))) return undefined;
  return ["python", "-I", "-m", "pip", "--isolated", "install", "--index-url", "https://pypi.org/simple",
    "--disable-pip-version-check", "--no-input", "--no-cache-dir", "--only-binary=:all:", "--no-deps", "--target", QP_DEPENDENCIES, ...packages.map(p => approved[p])];
}

/** Authoritative phase gate, deliberately independent of shell syntax. */
export class QuestioningState {
  assessment?: SuitabilityAssessment;
  originals: Record<string, string> = {};
  changes: Array<{ path: string; originalPath?: string; beforeHash?: string; afterHash: string; reason: string; claimIds: string[] }> = [];
  executions: Array<{ command: string; snapshot: string; files: Record<string, string>; status: "prepared" | "executed"; argv?: string[]; entrypointSha256?: string; dependencyHashes?: unknown[]; outputHash?: string }> = [];
  private independentAssessmentPreview = "Not independently assessed.";
  independentAssessmentHash?: string;
  get independentAssessment() { return this.independentAssessmentPreview; }
  set independentAssessment(value: string) {
    this.independentAssessmentPreview = clip(value, 8000);
    try { this.independentAssessmentHash = this.putBlob(value); }
    catch (error) { if (!(error instanceof QuestioningProvenanceLimitError)) throw error; }
  }
  dependencyManifest: unknown[] = [];
  dependencyManifestHash?: string;
  limitation?: string;
  readonly blobStore = new QuestioningBlobStore();
  private metadataUsed = 64 * 1024; // Reserve bounded assessment/final-summary fields.
  private working: Record<string, string> = {};

  private reserveMetadata(bytes: number) {
    if (this.metadataUsed + bytes > QUESTIONING_PROVENANCE_LIMITS.metadataBytes)
      this.limit("path/hash metadata exceeds its 2 MiB budget");
    this.metadataUsed += bytes;
  }
  private limit(detail: string): never {
    const error = new QuestioningProvenanceLimitError(detail);
    this.limitation = error.message;
    throw error;
  }
  private putBlob(content: string): string {
    try { return this.blobStore.put(content); }
    catch (error) {
      if (error instanceof QuestioningProvenanceLimitError) this.limitation = error.message;
      throw error;
    }
  }
  readBlob(sha256: string): string | undefined { return this.blobStore.read(sha256); }
  addOriginal(path: string, content: string) {
    if (path.length > 1024 || Object.prototype.hasOwnProperty.call(this.originals, path))
      this.limit("duplicate or oversized original path");
    this.reserveMetadata(serializedBytes(path) + 256);
    const sha256 = this.putBlob(content);
    this.originals[path] = sha256;
    this.working[path] = sha256;
  }
  gate(tool: string): string | undefined {
    if (this.limitation && ["run_command", "write_file", "setup_environment"].includes(tool)) return `Refused: ${this.limitation}`;
    if (tool === "setup_environment" && this.executions.length) return "Refused: dependencies are frozen after the first scientific execution.";
    if (["write_file", "run_command"].includes(tool) && !this.assessment)
      return "Refused: qP assessment phase permits inspection only. Call assess_suitability with inspected evidence before writes or arbitrary execution.";
    if (["write_file", "run_command"].includes(tool) && this.assessment?.decision === "blocked")
      return "Refused: assessment records no defensible analysis. Report the limitation without executing or inventing inputs.";
    if (tool === "run_command" && this.assessment?.decision === "adapt"
      && this.assessment.planned_changes?.some(p => {
        const original = "/work/" + p.path.slice("/work/working/".length);
        return !this.working[original] || this.working[original] === this.originals[original];
      }))
      return "Refused: apply every planned adaptation to its working copy before execution.";
    if (tool === "write_file" && this.assessment?.decision === "suitable")
      return "Refused: suitable code must be used unchanged. No scientific edits were authorized by this assessment.";
  }
  assess(raw: unknown, calls: readonly ToolCallRecord[], claims: RecordedResult[]): string {
    if (this.assessment) return "Refused: assessment already committed.";
    let a: SuitabilityAssessment;
    try { a = JSON.parse(String(raw)); } catch { return "Refused: assessment must be valid JSON."; }
    if (!a || !["suitable", "adapt", "blocked"].includes(a.decision)
      || !["research_question", "question_quote", "rationale", "intended_changes", "comparability"].every(k => typeof (a as any)[k] === "string" && (a as any)[k].trim())
      || !Array.isArray(a.claim_ids) || !a.claim_ids.length || a.claim_ids.some(id => !claims.some(c => c.id === id))
      || !Array.isArray(a.evidence) || !a.evidence.length)
      return "Refused: complete structured assessment and registered affected claims required.";
    const cited = a.evidence.map(e => calls.find(c => c.index === e.tool_call_id && !c.error && ["read_file", "list_files"].includes(c.name) && typeof e.excerpt === "string" && e.excerpt.length >= 24 && c.result.includes(e.excerpt)));
    if (cited.some(c => !c)) return "Refused: each evidence excerpt must quote a prior successful inspection.";
    if (a.question_quote.length < 24 || !cited.some(c => c!.name === "read_file" && c!.args.path === "/work/paper.md" && c!.result.includes(a.question_quote)))
      return "Refused: question_quote must be grounded in a cited paper read.";
    if (!cited.some(c => c!.args.path === "/work/MATERIALS_INDEX.md"))
      return "Refused: cite the inspected materials inventory, including missing materials.";
    const materialPaths = Object.keys(this.originals).filter(p => p !== "/work/paper.md" && p !== "/work/MATERIALS_INDEX.md");
    if (a.decision !== "blocked" && (!materialPaths.length || !cited.some(c => c!.name === "read_file" && materialPaths.includes(String(c!.args.path)))))
      return "Refused: inspect shipped code/data before declaring a defensible analysis.";
    if (a.decision === "adapt" && (!Array.isArray(a.planned_changes) || !a.planned_changes.length || a.planned_changes.some(c =>
      !c || typeof c.path !== "string" || !c.path.startsWith("/work/working/materials/") || posix.normalize(c.path) !== c.path
      || typeof c.reason !== "string" || c.reason.trim().length < 20
      || !Array.isArray(c.claim_ids) || !c.claim_ids.length || c.claim_ids.some(id => !a.claim_ids.includes(id)))))
      return "Refused: adapt requires claim-linked planned_changes with canonical /work/working/materials/ paths and scientific reasons.";
    if (serializedBytes(a) > 16000) return "Refused: assessment exceeds 16000 serialized bytes; cite concise evidence.";
    this.assessment = a;
    return `Assessment committed: ${a.decision}. ${a.decision === "blocked" ? "Record concrete blockers." : "Execution now available on isolated working snapshots."}`;
  }
  write(path: string, content: string, reason: unknown): string | undefined {
    const refusal = this.gate("write_file");
    if (refusal) return refusal;
    if (posix.normalize(path) !== path || !path.startsWith("/work/working/"))
      return "Refused: qP writes are restricted to /work/working/. Originals and execution snapshots are protected.";
    const plan = this.assessment!.planned_changes?.find(c => c.path === path);
    if (!plan) return "Refused: this file is not authorized by the assessment's planned_changes.";
    if (typeof reason !== "string" || reason.trim().length < 20 || reason.length > 2000 || path.length > 1024) return "Refused: provide a bounded path and scientific reason (20–2000 characters).";
    const originalPath = "/work/" + path.slice("/work/working/".length);
    const beforeHash = this.working[originalPath];
    try {
      this.reserveMetadata(serializedBytes({ path, originalPath, beforeHash, reason, claimIds: plan.claim_ids }) + 512);
      const afterHash = this.putBlob(content);
      this.changes.push({ path, originalPath: this.originals[originalPath] ? originalPath : undefined, beforeHash, afterHash, reason, claimIds: plan.claim_ids });
      this.working[originalPath] = afterHash;
    } catch (error) {
      if (error instanceof QuestioningProvenanceLimitError) return `Refused: ${error.message}`;
      throw error;
    }
  }
  snapshot(command: string) {
    if (command.length > 8000 || this.executions.length >= 100) this.limit("execution command/count exceeds bounded runtime limits");
    this.ensureExecutionOutputCapacity();
    const snapshot = `/work/qp-executions/run-${this.executions.length + 1}`;
    // Check before constructing a new path table, and never rehash/re-copy source.
    const pathsBytes = Object.keys(this.working).reduce((n, p) => n + serializedBytes(p.replace("/work/", snapshot + "/")) + 70, 2);
    this.reserveMetadata(pathsBytes + serializedBytes(command) * 2 + 2048);
    const files = Object.fromEntries(Object.entries(this.working).map(([p, sha256]) => [p.replace("/work/", snapshot + "/"), sha256]));
    const execution: QuestioningState["executions"][number] = { command, snapshot, files, status: "prepared" };
    this.executions.push(execution);
    return execution;
  }
  ensureExecutionOutputCapacity() {
    if (this.blobStore.remainingBytes < QUESTIONING_PROVENANCE_LIMITS.executionOutputReserveBytes)
      this.limit("insufficient capacity to retain the next execution's captured output");
  }
  recordExecutionOutput(execution: QuestioningState["executions"][number], output: string) {
    execution.outputHash = this.putBlob(output);
  }
  setDependencyManifest(manifest: unknown[]) {
    const full = JSON.stringify(manifest);
    const summaries = manifest.map((entry: any) => ({ root: entry.root, sha256: entry.sha256, files: entry.files, bytes: entry.bytes }));
    this.reserveMetadata(serializedBytes(summaries) + 256);
    this.dependencyManifestHash = this.putBlob(full);
    this.dependencyManifest = summaries;
  }
  readKnownSource(path: string): string | undefined {
    if (path.startsWith("/work/working/")) return this.readBlob(this.working[path.replace("/work/working/", "/work/")]);
    if (this.originals[path]) return this.readBlob(this.originals[path]);
    for (const execution of this.executions) if (execution.files[path]) return this.readBlob(execution.files[path]);
    return undefined;
  }
  listKnownSources(path: string): string[] {
    const paths = [...Object.keys(this.originals), ...Object.keys(this.working).map(p => p.replace("/work/", "/work/working/")),
      ...this.executions.flatMap(e => Object.keys(e.files))];
    const prefix = path.replace(/\/$/, "") + "/";
    return Array.from(new Set(paths.filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length).split("/")[0]))).sort();
  }
  executionArgv(command: string): string[] | undefined {
    // This is not the assessment gate: gate() rejects ALL commands first.
    // After assessment, scientific source must be an inspectable snapshot file,
    // not shell inline code that would bypass claim-linked change provenance.
    const tokens = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s"']+/g);
    if (!tokens || tokens.join(" ").replace(/\s+/g, " ").trim() !== command.replace(/\s+/g, " ").trim()) return undefined;
    let argv: string[];
    try { argv = tokens.map(t => t.startsWith('"') ? JSON.parse(t) : t.startsWith("'") ? t.slice(1, -1) : t); } catch { return undefined; }
    if (!["python", "python3", "bash", "sh", "node", "Rscript", "julia"].includes(argv[0]) || argv.length < 2) return undefined;
    const path = argv[1].replace(/^\.\//, "");
    if (path.startsWith("/") || posix.normalize(path) !== path || !path.startsWith("materials/") || !Object.prototype.hasOwnProperty.call(this.working, `/work/${path}`)) return undefined;
    return [argv[0], path, ...argv.slice(2)];
  }
  judgeContext() {
    const a = this.assessment;
    const result = {
      assessment: a ? { research_question: clip(a.research_question, 1000), decision: a.decision, rationale: clip(a.rationale, 1600),
        comparability: clip(a.comparability, 1000), claim_ids: a.claim_ids.slice(0, 20).map(id => clip(id, 100)),
        evidence: a.evidence.slice(0, 8).map(e => ({ tool_call_id: e.tool_call_id, excerpt: clip(e.excerpt, 240) })) } : null,
      limitation: this.limitation,
      totals: { changes: this.changes.length, executions: this.executions.length, sources: Object.keys(this.originals).length },
      changes: this.changes.slice(0, 10).map(c => ({ path: clip(c.path, 160), beforeHash: c.beforeHash, afterHash: c.afterHash, reason: clip(c.reason, 240),
        beforeExcerpt: clip(this.readBlob(c.beforeHash ?? "") ?? "", 600), afterExcerpt: clip(this.readBlob(c.afterHash) ?? "", 600) })),
      executions: this.executions.slice(-5).map(e => ({ command: clip(e.command, 240), status: e.status, snapshot: e.snapshot,
        entrypointSha256: e.entrypointSha256, outputHash: e.outputHash, files: Object.keys(e.files).length })),
      notice: "Bounded excerpts, not a full manifest. Omitted source/change text is not independent validation; report any resulting uncertainty.",
    };
    while (serializedBytes(result) > 16000 && result.changes.length) result.changes.pop();
    while (serializedBytes(result) > 16000 && result.executions.length) result.executions.shift();
    while (serializedBytes(result) > 16000 && result.assessment?.evidence.length) result.assessment.evidence.pop();
    if (serializedBytes(result) > 16000 && result.assessment) {
      result.assessment.research_question = clip(result.assessment.research_question, 500);
      result.assessment.rationale = clip(result.assessment.rationale, 1000);
      result.assessment.comparability = clip(result.assessment.comparability, 500);
      result.assessment.claim_ids = result.assessment.claim_ids.slice(0, 5);
    }
    return JSON.stringify(result);
  }
  constrainOriginalVerdicts(results: ClaimVerdict[]): ClaimVerdict[] {
    if (!this.limitation && this.assessment?.decision === "suitable" && !this.changes.length) return results;
    return results.map(r => ({ ...r, verdict: "inconclusive", evidence: `Original-result comparability not established. Adapted analysis is separate. ${r.evidence || ""}` }));
  }
  finalizeBlockedClaims(claims: RecordedResult[]): boolean {
    const a = this.assessment;
    if (!a || (a.decision !== "blocked" && !this.limitation) || !claims.length || claims.some(c => !a.claim_ids.includes(c.id))) return false;
    for (const claim of claims) {
      // This is an explicit suitability limitation, not scientific execution
      // evidence or a fabricated missing-file/command-error classification.
      Object.assign(claim, { status: "inconclusive", method: "blocked", blockerKind: undefined,
        reproducedValue: undefined, evidence: `qP limitation (not scientific execution evidence): ${this.limitation ?? a.rationale}`,
        evidenceToolCallIds: a.evidence.map(e => e.tool_call_id), evidenceExcerpt: a.evidence[0].excerpt });
    }
    return true;
  }
  metadata() {
    return { schemaVersion: 2 as const, persona: "qP" as const, assessment: this.assessment ?? null,
      originals: this.originals, changes: this.changes, executions: this.executions, blobIndex: this.blobStore.index,
      dependencyManifest: this.dependencyManifest, dependencyManifestHash: this.dependencyManifestHash, limitation: this.limitation,
      isolation: { credentialsProvisioned: false, environment: "env -i with explicit allowlist", hostProc: "not mounted", scientificNetwork: "disabled", mutableState: "fresh output directory and private tmp/home/dev per execution", dependencies: "read-only mounts; setup frozen after first execution" },
      independentAssessment: this.independentAssessment, independentAssessmentHash: this.independentAssessmentHash };
  }
  json() {
    const metadata = this.metadata();
    // Check the cheap, source-free metadata before serializing the bounded blobs.
    if (serializedBytes(metadata) + this.blobStore.serializedBytes + 32 > QUESTIONING_PROVENANCE_LIMITS.persistedBytes)
      this.limit("persisted payload would exceed 32 MiB");
    const record: QuestioningProvenanceRecord = { ...metadata, blobs: this.blobStore.blobs };
    const json = JSON.stringify(record);
    if (Buffer.byteLength(json, "utf8") > QUESTIONING_PROVENANCE_LIMITS.persistedBytes) this.limit("persisted payload exceeds 32 MiB");
    return json;
  }
  markdown() {
    const a = this.assessment;
    const lines = ["## qP — Questioning Reproducer", "### Suitability assessment",
      a ? `**Research question:** ${clip(a.research_question, 1000)}\n\n**Decision:** ${a.decision}\n\n${clip(a.rationale, 1800)}\n\n**Comparability:** ${clip(a.comparability, 1000)}` : "Assessment was not completed. No scientific execution was authorized.",
      ...(this.limitation ? [`**Resource limitation:** ${this.limitation}`] : []),
      "### Adaptations and execution provenance",
      "Full original/modified source and captured outputs are preserved once as SHA-256-addressed blobs. Inspect them through this run's paginated provenance endpoint and metadata download; this report intentionally embeds no source payload.",
      `**Original source manifest** (${Object.keys(this.originals).length} files; first 20 shown):`,
      ...Object.entries(this.originals).slice(0, 20).map(([path, sha]) => `- \`${clip(path, 160)}\` — \`${sha}\``),
      `**Changes** (${this.changes.length}; first 20 shown):`,
      ...this.changes.slice(0, 20).map(c => `- \`${clip(c.path, 160)}\`: ${clip(c.reason, 180)} Before: \`${c.beforeHash ?? "new file"}\`; after: \`${c.afterHash}\`.`),
      `**Execution manifest** (${this.executions.length}; last 20 shown):`,
      ...this.executions.slice(-20).map(e => `- \`${e.snapshot}\` — ${e.status}; entrypoint \`${e.entrypointSha256 ?? "not launched"}\`; output \`${e.outputHash ?? "not captured"}\`.`),
      ...(this.dependencyManifestHash ? [`**Dependency manifest blob:** \`${this.dependencyManifestHash}\`.`] : []),
      "### Independent assessment of adapted analysis", clip(this.independentAssessment, 4000),
      "Adapted execution alone never verifies or falsifies the original paper's result. Truncated manifest listings are explicitly indicated above; the metadata download retains all hash references."];
    const markdown = lines.join("\n\n");
    if (Buffer.byteLength(markdown, "utf8") <= 32768) return markdown;
    return Buffer.from(markdown, "utf8").subarray(0, 32500).toString("utf8")
      + "\n\n[Bounded report excerpt. Download provenance metadata and page referenced blobs for complete records.]";
  }
}