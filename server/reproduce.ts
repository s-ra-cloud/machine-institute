import { getContextWindow, runToolLoop, type ModelProviderConfig, type ToolSpec, type ToolCallRecord } from "./model-service";
import { loadPaperContext } from "./ethics-review";
import { fetchContributionMaterials, materialSandboxPath, formatMaterialsInventory } from "./fs-materials";
import { ReproductionSandbox, isModalConfigured, type GpuType } from "./modal-sandbox";
import {
  verdictsFromRecordedResults,
  countVerdicts,
  deriveOverallVerdict,
  buildReproductionTitle,
  buildReproductionAbstract,
  buildReproductionMarkdown,
  previewToolResult,
  type RecordedResult,
  type ClaimVerdict,
  type OverallVerdict,
  type VerdictCounts,
  REPRODUCTION_METHODS,
  REPRODUCTION_BLOCKERS,
  buildEffectiveReproducerPrompt,
} from "./prompts/reproduce";
import { deriveContributionKeywords } from "./prompts/peer-review";
import { ReproductionSession } from "./reproduction-session";
import { ContextBudgetError, isContextOverflow, RequestContextBudget } from "./llm-context";
import { runBoundedReproductionJudge } from "./reproduction-judge";
import { ACTIVE_INSTRUCTION_MAX_BYTES, describeToolContext, RUNTIME_CONTEXT_HEADROOM } from "./tool-context";
import { ReproductionDiagnostics, attachReproductionFailureDiagnostics, type ReproductionFailureDiagnostics } from "./reproduction-diagnostics";

// "Generous" budget: close to what the ICML hackathon agents were given.
export const REPRODUCTION_BUDGET = {
  maxToolCalls: 100,
  wallClockMs: 2 * 60 * 60 * 1000,
  perCommandMs: 15 * 60 * 1000,
  // The sandbox outlives the agent loop so the judge never races a teardown.
  sandboxTimeoutMs: 2 * 60 * 60 * 1000 + 20 * 60 * 1000,
};

const PAPER_INLINE_CHARS = 15_000;
const README_INLINE_CHARS = 12_000;
// Consecutive no-progress stops, not a lifetime limit on finishing more claims.
const MAX_PREMATURE_STOP_RECOVERIES = 2;
const REQUIRED_LOGBOOK_SECTIONS = [
  "## Claims",
  "## Reproduction Log",
  "## Discrepancies",
  "## Limitations",
] as const;

export interface ReproductionOutput {
  markdown: string;
  logbook: string;
  title: string;
  abstract: string;
  overall: OverallVerdict;
  results: ClaimVerdict[];
  counts: VerdictCounts;
  keywords: string[];
  toolCallCount: number;
  sandboxId: string | null;
  durationSeconds: number;
  paperUsed: { title: string; authors: string; date: string; documentId: string };
  judgeSummary: string;
  stoppedBy: string;
  materials: { text: number; binary: number };
}

export interface RunReproductionOptions {
  reproductionId: string;
  projectId: string;
  journalId: string;
  initiativeDocId: string;
  initiativeSlug: string;
  journalDisplayName: string;
  documentId: string;
  paperTitle?: string | null;
  reproducerPrompt: string;
  judgePrompt: string;
  modelConfig: ModelProviderConfig;
  judgeModelConfig: ModelProviderConfig;
  gpu: GpuType;
  emitEvent: (phase: string, message: string) => Promise<void>;
  /** Run-local handoff for subsequent background-handler failures; never public. */
  onDiagnostics?: (snapshot: ReproductionFailureDiagnostics) => void;
}

export const NO_USABLE_REPRODUCTION_EVIDENCE =
  "The reproduction agent produced no usable execution evidence: it did not run any commands or record reproduced values or supporting evidence.";

export function hasUsableReproductionEvidence(input: {
  recordedResults: RecordedResult[];
  toolCalls: readonly {
    name: string;
    args?: Record<string, unknown>;
    result?: string;
  }[];
}): boolean {
  const hasExecution = input.toolCalls.some(call => {
    if (call.name !== "run_command") return false;
    const command = String(call.args?.command || "").trim();
    const result = call.result || "";
    return Boolean(command)
      && !result.startsWith("Refused: empty command")
      && !result.startsWith("Tool budget exhausted");
  });
  const hasRecordedEvidence = input.recordedResults.some(result =>
    Boolean(result.reproducedValue?.trim() || result.evidence?.trim()),
  );
  return hasExecution || hasRecordedEvidence;
}

export function getReproductionClaimIssues(input: {
  recordedResults: RecordedResult[];
  toolCalls: readonly {
    name: string;
    index?: number;
    args?: Record<string, unknown>;
    result?: string;
  }[];
  budgetExhausted?: boolean;
}): string[] {
  const issues: string[] = [];
  if (input.recordedResults.length === 0) {
    issues.push("no core results have been registered");
  }
  const pending = input.recordedResults.filter(result => result.status === "pending");
  if (pending.length > 0) {
    issues.push(`${pending.length} result${pending.length === 1 ? " is" : "s are"} still pending (${pending.map(result => result.id).join(", ")})`);
  }
  const unsupported = input.recordedResults.filter(result =>
    result.status !== "pending"
    && !result.reproducedValue?.trim()
    && !result.evidence?.trim(),
  );
  if (unsupported.length > 0) {
    issues.push(`${unsupported.length} finalized result${unsupported.length === 1 ? " has" : "s have"} no reproduced value or supporting evidence (${unsupported.map(result => result.id).join(", ")})`);
  }
  const finalized = input.recordedResults.filter(result => result.status !== "pending");
  for (const result of finalized) {
    const systemBudgetBlocker = Boolean(input.budgetExhausted
      && result.method === "blocked" && result.blockerKind === "budget"
      && /System-enforced (?:deadline|tool-call budget) exhaustion/.test(result.evidence || ""));
    if (!result.method) {
      issues.push(`${result.id} has no reproduction method`);
      continue;
    }
    const referencedCalls = (result.evidenceToolCallIds || [])
      .map(id => input.toolCalls.find((call, offset) => (call.index ?? offset + 1) === id))
      .filter((call): call is NonNullable<typeof call> =>
        Boolean(call) && ["run_command", "read_file", "list_files"].includes(call!.name),
      );
    if (referencedCalls.length === 0 && !systemBudgetBlocker) {
      issues.push(`${result.id} does not cite any valid evidence tool calls`);
      continue;
    }
    const evidenceExcerpt = result.evidenceExcerpt?.trim() || "";
    const genericExcerpt = /^(?:exit code \d+|timed out|success|failed|error)$/i.test(evidenceExcerpt);
    const excerptCalls = evidenceExcerpt.length >= 4 && !genericExcerpt
      ? referencedCalls.filter(call => (call.result || "").includes(evidenceExcerpt))
      : [];
    if (result.method === "rerun" || result.method === "raw-data-rederived" || result.method === "toy") {
      const successfulCommand = excerptCalls.some(call =>
        call.name === "run_command"
        && Boolean(String(call.args?.command || "").trim())
        && /^exit code 0\b/.test(call.result || ""),
      );
      if (!successfulCommand) {
        issues.push(`${result.id} method ${result.method} does not quote evidence from a cited successful command`);
      }
      const reproducedValue = result.reproducedValue?.trim() || "";
      if (!reproducedValue || !evidenceExcerpt.includes(reproducedValue)) {
        issues.push(`${result.id} ${result.status} result does not include its reproduced value in the evidence excerpt`);
      }
      if (result.method === "toy" && result.status !== "toy") {
        issues.push(`${result.id} uses toy method with non-toy status ${result.status}`);
      }
      if (result.status === "toy" && result.method !== "toy") {
        issues.push(`${result.id} has toy status without toy method`);
      }
      if (result.method === "raw-data-rederived") {
        const rawPath = result.rawInputPath?.trim() || "";
        const rawCall = input.toolCalls.find((call, offset) =>
          (call.index ?? offset + 1) === result.rawInputToolCallId
          && call.name === "read_file"
          && String(call.args?.path || "") === rawPath,
        );
        const rawExtension = /\.(?:csv|tsv|jsonl?|parquet|arrow|npy|npz|pt|pkl|pickle)$/i.test(rawPath);
        const computationNamesInput = referencedCalls.some(call =>
          call.name === "run_command"
          && (
            String(call.args?.command || "").includes(rawPath)
            || (call.result || "").includes(rawPath)
          ),
        );
        if (!rawCall || !rawExtension || !computationNamesInput) {
          issues.push(`${result.id} raw-data re-derivation is not tied to a specific raw input read and computation`);
        }
      }
    }
    if (result.method === "blocked") {
      const explanation = `${result.evidence || ""} ${result.notes || ""}`;
      const citesPrematureResourceLimit =
        /\b(?:ran out of time|not enough time|due to time|time (?:limit|constraint)|prohibitive runtime|runtime (?:limit|constraint)|budget (?:limit|constraint|exhausted)|remaining budget)\b/i
          .test(explanation);
      if (!input.budgetExhausted && citesPrematureResourceLimit) {
        issues.push(`${result.id} cites time or budget as a blocker while useful budget remains`);
      }
      if (result.status !== "inconclusive") {
        issues.push(`${result.id} uses blocked method with non-inconclusive status ${result.status}`);
      }
      const blockerOutput = excerptCalls.map(call => call.result || "").join("\n");
      const blockerMatches = result.blockerKind === "oom"
        ? /\b(?:out of memory|oom)\b/i.test(blockerOutput) && /\b(?:out of memory|oom|memory)\b/i.test(explanation)
        : result.blockerKind === "missing-material"
          ? /\b(?:empty directory or not found|no such file|not found|missing)\b/i.test(blockerOutput)
            && /\b(?:not shipped|no such file|not found|missing|unavailable)\b/i.test(explanation)
          : result.blockerKind === "timeout"
            ? /\b(?:timed out|timeout)\b/i.test(blockerOutput) && /\b(?:timed out|timeout)\b/i.test(explanation)
            : result.blockerKind === "command-error"
              ? /^(?:exit code (?!0\b)|Tool error:)/m.test(blockerOutput)
                && /\b(?:error|failed|failure|syntax|dependency|exception)\b/i.test(explanation)
              : false;
      const citedBlocker = excerptCalls.some(call => {
        const output = call.result || "";
        if (call.name === "run_command") {
          return /^(?:TIMED OUT|exit code (?!0\b)|Tool error:)/m.test(output)
            || /\b(?:out of memory|oom|no such file|not found|missing|permission denied|killed)\b/i.test(output);
        }
        return /\b(?:empty directory or not found|no such file|not found|missing)\b/i.test(output);
      });
      if ((!citedBlocker || !blockerMatches) && !systemBudgetBlocker) {
        issues.push(`${result.id} blocker category and evidence excerpt do not match cited tool output`);
      }
    }
  }
  return issues;
}

export function getReproductionCompletionIssues(input: Parameters<typeof getReproductionClaimIssues>[0] & { logbook: string }): string[] {
  const issues = getReproductionClaimIssues(input);
  if (!hasUsableReproductionEvidence(input)) {
    issues.push("no command execution or recorded reproduction evidence exists");
  }
  const logbookLines = input.logbook.split(/\r?\n/);
  if (
    /(?:Archived unchanged|Retrieval only; this is not scientifically valid evidence)/i.test(input.logbook)
    && !REQUIRED_LOGBOOK_SECTIONS.some(section => logbookLines.some(line => line.trim() === section))
  ) {
    issues.push("the final response is only an archive/retrieval notice, not a reproduction logbook");
  }
  const missingSections = REQUIRED_LOGBOOK_SECTIONS.filter(section => {
    const start = logbookLines.findIndex(line => line.trim() === section);
    if (start < 0) return true;
    const nextHeadingOffset = logbookLines
      .slice(start + 1)
      .findIndex(line => /^##\s+\S/.test(line.trim()));
    const end = nextHeadingOffset < 0
      ? logbookLines.length
      : start + 1 + nextHeadingOffset;
    return !logbookLines.slice(start + 1, end).join("\n").trim();
  });
  if (missingSections.length > 0) {
    issues.push(`the final logbook is missing: ${missingSections.join(", ")}`);
  }
  return issues;
}

export function buildReproductionContinuation(input: {
  recordedResults: RecordedResult[];
  toolCalls: readonly {
    name: string;
    index?: number;
    args?: Record<string, unknown>;
    result?: string;
  }[];
  logbook: string;
  budgetExhausted?: boolean;
}): string | null {
  const issues = getReproductionCompletionIssues(input);
  if (issues.length === 0) return null;
  return [
    "You attempted to finish before completing the reproduction.",
    `Unmet requirements: ${issues.join("; ")}.`,
    "Continue using the available tools now. Perform the reproduction work, then update every result with a valid method and the numbered evidence_tool_call_ids shown in prior tool outputs. Return the complete four-section markdown logbook only after every claim was rerun, independently re-derived, toy-tested, or concretely blocked. Do not stop again until these requirements are satisfied.",
  ].join(" ");
}

export function finalizeBudgetExhaustedResults(input: {
  recordedResults: RecordedResult[];
  toolCalls: readonly ToolCallRecord[];
  stoppedBy: string;
}): void {
  if (input.stoppedBy !== "deadline" && input.stoppedBy !== "tool-budget") return;
  const reason = input.stoppedBy === "deadline"
    ? "System-enforced deadline exhaustion"
    : "System-enforced tool-call budget exhaustion";
  for (const result of input.recordedResults) {
    if (result.status !== "pending") continue;
    result.status = "inconclusive";
    result.method = "blocked";
    result.blockerKind = "budget";
    // This is system evidence, not scientific evidence from an unrelated command.
    result.evidenceToolCallIds = [];
    result.evidence = `${reason} prevented further claim-specific testing.`;
    result.notes = [result.notes, "Finalized deterministically after the agent reached the enforced resource limit."]
      .filter(Boolean)
      .join(" ");
  }
}

const TOOLS: ToolSpec[] = [
  {
    name: "read_reproduction_context",
    description: "Read archived claim state, rejected submissions, drafts, or repair instructions. Omit ref for the paged index. These are context, NOT scientific evidence; cite original command/file IDs via read_tool_result.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Stable reference from the state or archive index." },
        offset: { type: "integer", description: "Character offset; follow the returned continuation offset." },
        max_chars: { type: "integer", description: "Requested page length, further limited by serialized byte size." },
      },
    },
  },
  {
    name: "read_tool_result",
    description: "Retrieve an earlier command/file output without rerunning it, even after context compaction. Omit tool_call_id to list prior evidence IDs. Cite the ORIGINAL evidence ID in record_result.",
    parameters: {
      type: "object",
      properties: {
        tool_call_id: { type: "integer" },
        offset: { type: "integer" },
        max_chars: { type: "integer", description: "Up to 8000 characters per page." },
      },
    },
  },
  {
    name: "list_files",
    description: "List the files in a directory inside the sandbox (e.g. /work, /work/materials, /work/results).",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "read_file",
    description: "Read a text file from the sandbox. Returns verified path and canonical character-range metadata. Large files are truncated; use offset to page through them.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        max_chars: { type: "integer", description: "Maximum characters to return (default 12000)." },
        offset: { type: "integer", description: "Character offset to start from (default 0)." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file in the sandbox (e.g. a patched copy of a script, or a helper script).",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  {
    name: "run_command",
    description: "Run a bash command in the sandbox (working directory /work) and return its exit code, stdout and stderr. The GPU is available; HF_TOKEN is set. Commands are killed at timeout_seconds (max 900).",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_seconds: { type: "integer", description: "Kill the command after this many seconds (default 600, max 900)." },
      },
      required: ["command"],
    },
  },
  {
    name: "record_result",
    description: "Register or update one of the paper's core results and its reproduction status. Call once per result with status 'pending' during extraction, then again with the final status. Every result must end with a non-pending status.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Short id such as R1, R2." },
        claim: { type: "string", description: "The result as stated in the paper, including the reported number(s)." },
        source_quote: { type: "string", description: "Required for a new claim: substantial exact quotation from canonical /work/paper.md." },
        source_location: { type: "string", description: 'Required for a new claim: cited page range "characters START-END" copied from read_file metadata.' },
        source_tool_call_id: { type: "integer", description: "Required for a new claim: prior read_file call on /work/paper.md containing source_quote." },
        required_material: { type: "string", description: "For missing-material: paper wording, present in source_quote, naming the scientifically required material." },
        status: { type: "string", enum: ["pending", "verified", "falsified", "toy", "inconclusive"] },
        original_value: { type: "string" },
        reproduced_value: { type: "string" },
        evidence: { type: "string", description: "Which commands, files, and outputs support this status." },
        notes: { type: "string" },
        method: { type: "string", enum: [...REPRODUCTION_METHODS], description: "How this result was tested: rerun, raw-data-rederived, toy, or blocked." },
        evidence_tool_call_ids: {
          type: "array",
          items: { type: "integer" },
          description: "Numbers of prior tool calls that prove this method and result.",
        },
        evidence_excerpt: { type: "string", description: "An exact distinctive quote from a cited tool result that proves this claim's outcome or blocker." },
        blocker_kind: { type: "string", enum: [...REPRODUCTION_BLOCKERS], description: "Required only for blocked: oom, missing-material, command-error, timeout, or budget." },
        raw_input_tool_call_id: { type: "integer", description: "For raw-data-rederived, the read_file tool call number that opened the raw data." },
        raw_input_path: { type: "string", description: "For raw-data-rederived, the exact raw data path opened and used by the computation." },
      },
      required: ["id", "status"],
    },
  },
];

function fmtExec(r: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }): string {
  const status = r.timedOut ? "TIMED OUT" : `exit code ${r.exitCode ?? "unknown"}`;
  return `${status} (${(r.durationMs / 1000).toFixed(1)}s)\n--- stdout ---\n${r.stdout || "(empty)"}\n--- stderr ---\n${r.stderr || "(empty)"}`;
}

export async function runReproduction(opts: RunReproductionOptions): Promise<ReproductionOutput> {
  const diagnostics = new ReproductionDiagnostics();
  try {
    const result = await runReproductionWithDiagnostics(opts, diagnostics);
    try { opts.onDiagnostics?.(diagnostics.snapshot()); } catch { /* best effort */ }
    return result;
  } catch (error) {
    try {
      if (error instanceof ContextBudgetError) diagnostics.stop("context-budget");
    } catch { /* Capture failure must not replace the original error. */ }
    attachReproductionFailureDiagnostics(error, diagnostics);
    throw error;
  }
}

async function runReproductionWithDiagnostics(opts: RunReproductionOptions, diagnostics: ReproductionDiagnostics): Promise<ReproductionOutput> {
  const startTime = Date.now();
  const { projectId, journalId, initiativeDocId, initiativeSlug, journalDisplayName, documentId, paperTitle, modelConfig, judgeModelConfig, gpu, emitEvent } = opts;
  const effectivePrompt = buildEffectiveReproducerPrompt(opts.reproducerPrompt);
  // Fixed input must leave room for bounded state and a useful retrieval page,
  // not merely fit an empty first turn before booting a paid sandbox.
  const instructionBudget = new RequestContextBudget(modelConfig, 8000, "reproduction instructions", getContextWindow(modelConfig));
  const fixedRequest = {
    model: modelConfig.modelName,
    messages: [{ role: "system", content: effectivePrompt }],
    tools: TOOLS.map(tool => ({ type: "function", function: tool })),
    max_tokens: 8000,
    temperature: 0.2,
    tool_choice: "auto",
  };
  const requiredStartupBudget = instructionBudget.estimate(fixedRequest) + RUNTIME_CONTEXT_HEADROOM;
  if (requiredStartupBudget > instructionBudget.inputLimit) {
    throw new ContextBudgetError(
      `Reproduction fixed instructions and tool schemas leave insufficient runtime state/retrieval headroom before sandbox startup (${instructionBudget.diagnostic(fixedRequest)}, runtime_headroom=${RUNTIME_CONTEXT_HEADROOM}; ${describeToolContext(fixedRequest)}). Shorten custom scientific instructions; mandatory tool contracts and output allowances cannot be removed.`,
    );
  }
  new RequestContextBudget(judgeModelConfig, 6000, "judge instructions", getContextWindow(judgeModelConfig)).assertFits({
    model: judgeModelConfig.modelName,
    messages: [{ role: "system", content: opts.judgePrompt }],
    max_tokens: 6000,
  });

  if (!isModalConfigured()) {
    throw new Error("Reproduction sandboxes are not configured (MODAL_TOKEN_ID / MODAL_TOKEN_SECRET missing).");
  }

  await emitEvent("reproduction-init", `Starting reproduction of "${paperTitle || documentId}" in ${journalDisplayName} on a ${gpu} sandbox.`);

  diagnostics.stage("materials");
  const ctx = await loadPaperContext({ projectId, documentId, initiativeDocId, initiativeSlug, paperTitle: paperTitle || undefined, emitEvent, eventPrefix: "reproduction" });
  const { title, authors, date, abstract, url, fullText, fsAbstracts } = ctx;

  await emitEvent("reproduction-materials", "Fetching supplementary materials (README, scripts, raw results, notebooks) from Future Science...");
  const materials = await fetchContributionMaterials(documentId);
  await emitEvent("reproduction-materials", `Materials found: ${materials.textFileCount} text file(s), ${materials.binaryFileCount} binary file(s)${materials.readme ? ", README present" : ", no README"}.`);

  await emitEvent("reproduction-sandbox", `Booting Modal ${gpu} sandbox (image build is cached after the first run)...`);
  const env: Record<string, string> = { PYTHONUNBUFFERED: "1", MPLBACKEND: "Agg", TOKENIZERS_PARALLELISM: "false" };
  const hfToken = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN;
  if (hfToken) {
    env.HF_TOKEN = hfToken;
    env.HUGGING_FACE_HUB_TOKEN = hfToken;
  } else {
    await emitEvent("reproduction-sandbox", "Warning: HF_TOKEN is not configured — gated Hugging Face models (e.g. Llama 3) will not be downloadable.");
  }
  diagnostics.stage("sandbox");
  const sandbox = await ReproductionSandbox.create({ gpu, timeoutMs: REPRODUCTION_BUDGET.sandboxTimeoutMs, env });

  const session = new ReproductionSession(
    (recordedResults, toolCalls) => getReproductionClaimIssues({ recordedResults, toolCalls, budgetExhausted: false }),
    issues => {
      try { diagnostics.observe({ kind: "claim-validation", toolName: "record_result", validationErrors: issues }); } catch { /* best effort */ }
    },
  );
  const recorded = session.recorded;
  let toolLoopResult: Awaited<ReturnType<typeof runToolLoop>> | null = null;
  let logbook = "";
  let gpuInfo = "(not probed)";
  let executionFailed = false;

  try {
    await emitEvent("reproduction-sandbox", `Sandbox ${sandbox.sandboxId} ready.`);
    const paperText = materials.paperMarkdown || fullText || `# ${title}\n\n${abstract}`;
    await sandbox.writeText("/work/paper.md", paperText);
    let uploaded = 0;
    for (const f of materials.files) {
      if (f.kind !== "text" || !f.text || f.source === "paper") continue;
      await sandbox.writeText(materialSandboxPath(f), f.text);
      uploaded++;
    }
    const inventory = formatMaterialsInventory(materials);
    await sandbox.writeText("/work/MATERIALS_INDEX.md", `# Shipped materials for "${title}"\n\n${inventory}\n`);
    const shippedPaths = materials.files
      .filter(file => file.kind === "text" && file.source !== "paper" && Boolean(file.text))
      .map(file => materialSandboxPath(file));
    const readmePaths = shippedPaths.filter(path => /(?:^|\/)readme(?:\.[^/]*)?$/i.test(path));
    session.configureSourceGrounding({ paperPath: "/work/paper.md", paperText });
    session.configureMaterialGrounding({
      inventoryPath: "/work/MATERIALS_INDEX.md",
      shippedPaths,
      readmePaths,
    });
    await emitEvent("reproduction-upload", `Uploaded the paper and ${uploaded} material file(s) into the sandbox.`);

    const probe = await sandbox.exec(["bash", "-lc", "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>&1 | head -n 3; python -c 'import torch, transformers; print(\"torch\", torch.__version__, \"cuda\", torch.cuda.is_available(), \"transformers\", transformers.__version__)' 2>&1"], { timeoutMs: 120_000 });
    gpuInfo = (probe.stdout || probe.stderr || "").trim() || "(no output)";
    await emitEvent("reproduction-gpu", `Sandbox environment: ${gpuInfo.replace(/\s+/g, " ").slice(0, 300)}`);

    const executeTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
      switch (name) {
        case "read_reproduction_context":
          return session.readContext(args);
        case "read_tool_result":
          return session.readToolResult(args);
        case "list_files": {
          const path = String(args.path || "/work");
          const entries = await sandbox.listFiles(path);
          if (entries.length === 0) return `Verified directory: ${path}\n(empty directory or not found)`;
          return `Verified directory: ${path}\n${entries.map(e => `${e.isDir ? "d " : "f "}${e.name}${e.size !== undefined ? ` (${e.size} B)` : ""}`).join("\n")}`;
        }
        case "read_file": {
          const path = String(args.path || "");
          const max = Math.min(Math.max(Number(args.max_chars) || 12_000, 200), 40_000);
          const offset = Math.max(Number(args.offset) || 0, 0);
          const text = await sandbox.readText(path);
          const slice = text.slice(offset, offset + max);
          const more = offset + max < text.length ? `\n\n[... ${text.length - offset - max} more chars; total ${text.length}. Use offset=${offset + max} to continue ...]` : "";
          return `Verified file: ${path}\nReturned characters: ${offset}-${offset + slice.length} of ${text.length}\n---\n${slice}${more}`;
        }
        case "write_file": {
          const path = String(args.path || "");
          if (!path.startsWith("/work")) return "Refused: files may only be written under /work.";
          await sandbox.writeText(path, String(args.content ?? ""));
          session.noteGeneratedPath(path);
          return `Wrote ${String(args.content ?? "").length} chars to ${path}.`;
        }
        case "run_command": {
          const command = String(args.command || "");
          if (!command.trim()) return "Refused: empty command.";
          const refusal = session.validateCommand(command);
          if (refusal) return refusal;
          const requested = (Number(args.timeout_seconds) || 600) * 1000;
          const remainingMs = startTime + REPRODUCTION_BUDGET.wallClockMs - Date.now();
          if (remainingMs <= 0) return "Deadline exhausted — command was not executed.";
          const timeoutMs = Math.min(Math.max(requested, 5_000), REPRODUCTION_BUDGET.perCommandMs, remainingMs);
          const result = await sandbox.exec(["bash", "-lc", command], { timeoutMs });
          return fmtExec(result);
        }
        case "record_result": {
          return session.recordResult(args);
        }
        default:
          return `Unknown tool: ${name}`;
      }
    };
    const execute = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const output = await executeTool(name, args);
      session.captureOutput(name, output);
      return output;
    };

    const userMessage = [
      `# TARGET PAPER`,
      ``,
      `**Title:** ${title}`,
      `**Authors:** ${authors}`,
      `**Date:** ${date}`,
      `**Journal:** ${journalDisplayName}`,
      `**URL:** ${url}`,
      ``,
      `## Abstract`,
      abstract || "(no abstract available)",
      ``,
      `## Paper text (first ${PAPER_INLINE_CHARS} chars; full text is at /work/paper.md, ${paperText.length} chars)`,
      paperText.slice(0, PAPER_INLINE_CHARS),
      ``,
      `---`,
      ``,
      `# SHIPPED MATERIALS (uploaded to the sandbox; index also at /work/MATERIALS_INDEX.md)`,
      ``,
      inventory,
      ``,
      materials.readme ? `## README\n${materials.readme.slice(0, README_INLINE_CHARS)}${materials.readme.length > README_INLINE_CHARS ? "\n[... README truncated; read the full file in the sandbox ...]" : ""}` : `## README\n(none shipped)`,
      ``,
      `---`,
      ``,
      `# SANDBOX`,
      ``,
      `Environment probe:\n${gpuInfo}`,
      ``,
      `Budget: ${REPRODUCTION_BUDGET.maxToolCalls} tool calls, ${Math.round(REPRODUCTION_BUDGET.wallClockMs / 60000)} minutes wall-clock, ${Math.round(REPRODUCTION_BUDGET.perCommandMs / 60000)} minutes per command. Write outputs under /work/results or /work/outputs.`,
      ``,
      `Begin with step 1 (EXTRACT): register the paper's core results with record_result, then reproduce them.`,
    ].join("\n");

    await emitEvent("reproduction-agent", `Reproduction agent (${modelConfig.modelName || modelConfig.provider}) started; budget ${REPRODUCTION_BUDGET.maxToolCalls} tool calls / ${Math.round(REPRODUCTION_BUDGET.wallClockMs / 60000)} min.`);
    diagnostics.stage("tool-loop");
    const compactUserMessage = [
      "Target paper and scientific goals are unchanged.",
      "Inline paper, abstract and README omitted to fit the request. Read the full paper at /work/paper.md and the complete material inventory at /work/MATERIALS_INDEX.md; shipped files are already uploaded.",
      `Budget unchanged: ${REPRODUCTION_BUDGET.maxToolCalls} tool calls, ${REPRODUCTION_BUDGET.wallClockMs / 60000} minutes wall-clock.`,
      "Extract all core claims, reproduce using shipped materials, and finalize every claim with validated evidence. Retrieve prior output by original ID with read_tool_result instead of repeating experiments.",
    ].join("\n");
    const protectedInputFloor = instructionBudget.estimate({
      ...fixedRequest,
      messages: [
        { role: "system", content: effectivePrompt },
        { role: "user", content: compactUserMessage },
        { role: "user", content: "x".repeat(600) },
        { role: "user", content: "x".repeat(ACTIVE_INSTRUCTION_MAX_BYTES) },
      ],
    });
    toolLoopResult = await runToolLoop(modelConfig, effectivePrompt, userMessage, TOOLS, execute, {
      onOutcome: event => { try { diagnostics.observe(event); } catch { /* best effort */ } },
      getArgumentRepair: () => [
        "Current accepted claim state (not an inferred correction):",
        session.contextState(2500),
        "Supply the exact intended id and required fields explicitly. Do not register an already-pending claim again. For a pending claim, perform the claim-specific experiment or demonstrate a real blocker, retrieve existing evidence without rerunning it, then update record_result with a final status and validated evidence. Use read_reproduction_context for omitted full claim identities.",
      ].join("\n"),
      maxToolCalls: REPRODUCTION_BUDGET.maxToolCalls,
      deadlineMs: startTime + REPRODUCTION_BUDGET.wallClockMs,
      maxTokens: 8000,
      protectedInputFloor,
      temperature: 0.2,
      numberToolResults: true,
      allowResourceStopFallback: true,
      contextProtection: {
        getState: maxBytes => session.contextState(maxBytes),
        getActiveInstruction: () => session.activeInstruction(),
        archiveContext: (key, text) => session.archiveContext(key, text),
        resizeRetrieval: (name, args, result, maxBytes) => session.resizeRetrieval(name, args, result, maxBytes),
        compactUserMessage,
        onDiagnostic: message => emitEvent("reproduction-context", message),
      },
      elidedToolOutputMessage: "[Earlier output elided. Use read_tool_result with the original tool call ID; do not rerun the experiment to retrieve it.]",
      getRecoveryProgress: () => session.progress,
      onToolCall: async (rec: ToolCallRecord) => {
        session.observeToolCall(rec);
        if (rec.name === "run_command") {
          const cmd = String(rec.args.command || "").replace(/\s+/g, " ").slice(0, 140);
          const firstLine = rec.result.split("\n")[0];
          await emitEvent("reproduction-run", `[${rec.index}/${REPRODUCTION_BUDGET.maxToolCalls}] ${cmd} → ${firstLine}`);
        } else if (rec.name === "record_result") {
          await emitEvent("reproduction-record", `[${rec.index}/${REPRODUCTION_BUDGET.maxToolCalls}] ${rec.result.slice(0, 500)}`);
        } else if (rec.index % 10 === 0) {
          await emitEvent("reproduction-progress", `${rec.index} tool calls used (${Math.round((Date.now() - startTime) / 60000)} min elapsed).`);
        }
      },
      onPrematureStop: (assistantText) => {
        const continuation = buildReproductionContinuation({
          recordedResults: Array.from(recorded.values()),
          toolCalls: session.toolCalls,
          logbook: assistantText,
          budgetExhausted: false,
        });
        return continuation ? `${session.activeInstruction()}\n${continuation}\n${session.repairContext()}` : null;
      },
      maxPrematureStopRecoveries: MAX_PREMATURE_STOP_RECOVERIES,
    });
    diagnostics.stop(toolLoopResult.stoppedBy);
    diagnostics.stage("completion");
    await emitEvent("reproduction-agent", `Agent finished after ${toolLoopResult.toolCalls.length} tool call(s) (${toolLoopResult.stoppedBy}); logbook ${toolLoopResult.content.length} chars.`);
    const recordedResults = Array.from(recorded.values());
    const budgetExhausted = toolLoopResult.stoppedBy === "deadline" || toolLoopResult.stoppedBy === "tool-budget";
    finalizeBudgetExhaustedResults({ recordedResults, toolCalls: session.toolCalls, stoppedBy: toolLoopResult.stoppedBy });
    logbook = toolLoopResult.content;
    if (budgetExhausted) {
      const states = recordedResults.map(r => `${r.id}: ${r.status} — ${r.evidence || r.reproducedValue || "No result obtained."}`).join("\n");
      // Tools are unavailable at a hard stop. Never depend on one more model call
      // to synchronize pending claims or manufacture a scientific result.
      if (getReproductionCompletionIssues({ recordedResults, toolCalls: session.toolCalls, logbook, budgetExhausted })
        .some(issue => issue.startsWith("the final logbook is missing"))) {
        logbook = `## Claims\n${states || "No claims registered."}\n\n## Reproduction Log\nSystem-generated resource-stop summary. ${session.toolCalls.filter(t => t.name === "run_command").length} command calls recorded; see the tool transcript for actual outputs.\n\n## Discrepancies\nNo additional conclusions inferred at the resource limit.\n\n## Limitations\nSystem-enforced ${toolLoopResult.stoppedBy} exhaustion. Unfinished claims remain inconclusive.`;
      } else {
        logbook += `\n\n## System-enforced final claim states\nThese accepted states supersede any unaccepted proposed statuses in the agent logbook:\n${states}`;
      }
    }
    const completionIssues = getReproductionCompletionIssues({
      recordedResults, toolCalls: session.toolCalls, logbook, budgetExhausted,
    });
    if (completionIssues.length) {
      try { diagnostics.observe({ kind: "completion-validation", validationErrors: completionIssues }); } catch { /* best effort */ }
      throw new Error(`The reproduction agent stopped before completing required work (${toolLoopResult.stoppedBy}): ${completionIssues.join("; ")}.`);
    }
  } catch (error) {
    executionFailed = true;
    throw error;
  } finally {
    try { diagnostics.claims(recorded.values()); } catch { /* best effort */ }
    try {
      await sandbox.terminate();
      await emitEvent("reproduction-sandbox", `Sandbox ${sandbox.sandboxId} terminated.`);
    } catch (cleanupError) {
      try { diagnostics.observe({ kind: "cleanup-failed" }); } catch { /* best effort */ }
      if (!executionFailed) {
        diagnostics.stop("cleanup-failed");
        throw cleanupError;
      }
    }
  }

  const toolCalls = session.toolCalls;
  const recordedList = Array.from(recorded.values());

  // Judge pass: a separate model grades the logbook against the raw tool outputs.
  diagnostics.stage("judge");
  await emitEvent("reproduction-judge", `Judge (${judgeModelConfig.modelName || judgeModelConfig.provider}) grading ${recordedList.length} recorded result(s)...`);
  let judgeSummary = "";
  let results: ClaimVerdict[] = [];
  try {
    const judged = await runBoundedReproductionJudge({
      config: judgeModelConfig, prompt: opts.judgePrompt, title, abstract, logbook,
      recordedResults: recordedList, toolCalls,
      onDiagnostic: message => emitEvent("reproduction-context", message),
    });
    judgeSummary = judged.summary;
    results = judged.results;
  } catch (err) {
    // An ungradable context must never become a self-certified reproduction.
    if (err instanceof ContextBudgetError || isContextOverflow(err)) throw err;
    await emitEvent("reproduction-judge", `Judge call failed (${err instanceof Error ? err.message : String(err)}); falling back to the agent's own statuses.`);
  }
  if (results.length === 0) {
    results = verdictsFromRecordedResults(recordedList);
    if (!judgeSummary) judgeSummary = "The judge did not return a parseable grading; verdicts below are the agent's own recorded statuses (pending → inconclusive).";
  } else {
    // Any recorded claim the judge skipped still gets a row, as inconclusive.
    const judgedIds = new Set(results.map(r => r.id));
    for (const r of recordedList) {
      if (!judgedIds.has(r.id)) results.push({ id: r.id, claim: r.claim, verdict: "inconclusive", originalValue: r.originalValue, reproducedValue: r.reproducedValue, evidence: r.evidence });
    }
  }

  diagnostics.stage("report");
  const overall = deriveOverallVerdict(results);
  const counts = countVerdicts(results);
  await emitEvent("reproduction-judge", `Verdicts: ${counts.verified} verified, ${counts.falsified} falsified, ${counts.toy} toy, ${counts.inconclusive} inconclusive → overall ${overall}.`);

  const environment = {
    gpu,
    image: sandbox.image,
    reproducerModel: modelConfig.modelName || modelConfig.provider,
    judgeModel: judgeModelConfig.modelName || judgeModelConfig.provider,
    maxToolCalls: REPRODUCTION_BUDGET.maxToolCalls,
    wallClockMinutes: Math.round(REPRODUCTION_BUDGET.wallClockMs / 60000),
    perCommandMinutes: Math.round(REPRODUCTION_BUDGET.perCommandMs / 60000),
  };
  const markdown = buildReproductionMarkdown({
    paperTitle: title,
    paperAuthors: authors,
    paperDate: date,
    paperUrl: url,
    journalDisplayName,
    overall,
    results,
    judgeSummary,
    logbook,
    materialsInventory: formatMaterialsInventory(materials),
    materialsCounts: { text: materials.textFileCount, binary: materials.binaryFileCount },
    environment,
    toolCalls: toolCalls.map(t => ({ index: t.index, name: t.name, args: t.args, durationMs: t.durationMs, error: t.error, resultPreview: previewToolResult(t.result) })),
    stoppedBy: toolLoopResult.stoppedBy,
    sandboxAvailable: true,
  });

  const paperKeywords = fsAbstracts.find(a => a.documentId === documentId)?.keywords ?? [];
  const keywords = deriveContributionKeywords({
    paperKeywords,
    paperTitle: title,
    categoryTag: "reproduction",
    fallbacks: ["reproducibility", "ai research", "replication"],
  });

  return {
    markdown,
    logbook,
    title: buildReproductionTitle(title),
    abstract: buildReproductionAbstract({ paperTitle: title, overall, counts, summary: judgeSummary, gpu, realExecution: true }),
    overall,
    results,
    counts,
    keywords,
    toolCallCount: toolCalls.length,
    sandboxId: sandbox.sandboxId,
    durationSeconds: Math.round((Date.now() - startTime) / 1000),
    paperUsed: { title, authors, date, documentId },
    judgeSummary,
    stoppedBy: toolLoopResult.stoppedBy,
    materials: { text: materials.textFileCount, binary: materials.binaryFileCount },
  };
}
