import { generateWithConfig, runToolLoop, type ModelProviderConfig, type ToolSpec, type ToolCallRecord } from "./model-service";
import { loadPaperContext } from "./ethics-review";
import { fetchContributionMaterials, materialSandboxPath, formatMaterialsInventory } from "./fs-materials";
import { ReproductionSandbox, isModalConfigured, type GpuType } from "./modal-sandbox";
import {
  VERDICTS,
  parseJudgeOutput,
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
  type Verdict,
} from "./prompts/reproduce";
import { deriveContributionKeywords } from "./prompts/peer-review";

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
const JUDGE_TRANSCRIPT_CHARS = 150_000;
const JUDGE_TOOL_RESULT_CHARS = 3_000;

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
}

const TOOLS: ToolSpec[] = [
  {
    name: "list_files",
    description: "List the files in a directory inside the sandbox (e.g. /work, /work/materials, /work/results).",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "read_file",
    description: "Read a text file from the sandbox. Large files are truncated; use offset to page through them.",
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
        status: { type: "string", enum: ["pending", "verified", "falsified", "toy", "inconclusive"] },
        original_value: { type: "string" },
        reproduced_value: { type: "string" },
        evidence: { type: "string", description: "Which commands, files, and outputs support this status." },
        notes: { type: "string" },
      },
      required: ["id", "claim", "status"],
    },
  },
];

function fmtExec(r: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }): string {
  const status = r.timedOut ? "TIMED OUT" : `exit code ${r.exitCode ?? "unknown"}`;
  return `${status} (${(r.durationMs / 1000).toFixed(1)}s)\n--- stdout ---\n${r.stdout || "(empty)"}\n--- stderr ---\n${r.stderr || "(empty)"}`;
}

export async function runReproduction(opts: RunReproductionOptions): Promise<ReproductionOutput> {
  const startTime = Date.now();
  const { projectId, journalId, initiativeDocId, initiativeSlug, journalDisplayName, documentId, paperTitle, modelConfig, judgeModelConfig, gpu, emitEvent } = opts;

  if (!isModalConfigured()) {
    throw new Error("Reproduction sandboxes are not configured (MODAL_TOKEN_ID / MODAL_TOKEN_SECRET missing).");
  }

  await emitEvent("reproduction-init", `Starting reproduction of "${paperTitle || documentId}" in ${journalDisplayName} on a ${gpu} sandbox.`);

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
  const sandbox = await ReproductionSandbox.create({ gpu, timeoutMs: REPRODUCTION_BUDGET.sandboxTimeoutMs, env });
  await emitEvent("reproduction-sandbox", `Sandbox ${sandbox.sandboxId} ready.`);

  const recorded = new Map<string, RecordedResult>();
  let toolLoopResult: Awaited<ReturnType<typeof runToolLoop>> | null = null;
  let gpuInfo = "(not probed)";

  try {
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
    await emitEvent("reproduction-upload", `Uploaded the paper and ${uploaded} material file(s) into the sandbox.`);

    const probe = await sandbox.exec(["bash", "-lc", "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>&1 | head -n 3; python -c 'import torch, transformers; print(\"torch\", torch.__version__, \"cuda\", torch.cuda.is_available(), \"transformers\", transformers.__version__)' 2>&1"], { timeoutMs: 120_000 });
    gpuInfo = (probe.stdout || probe.stderr || "").trim() || "(no output)";
    await emitEvent("reproduction-gpu", `Sandbox environment: ${gpuInfo.replace(/\s+/g, " ").slice(0, 300)}`);

    const execute = async (name: string, args: Record<string, unknown>): Promise<string> => {
      switch (name) {
        case "list_files": {
          const path = String(args.path || "/work");
          const entries = await sandbox.listFiles(path);
          if (entries.length === 0) return `(empty directory or not found: ${path})`;
          return entries.map(e => `${e.isDir ? "d " : "f "}${e.name}${e.size !== undefined ? ` (${e.size} B)` : ""}`).join("\n");
        }
        case "read_file": {
          const path = String(args.path || "");
          const max = Math.min(Math.max(Number(args.max_chars) || 12_000, 200), 40_000);
          const offset = Math.max(Number(args.offset) || 0, 0);
          const text = await sandbox.readText(path);
          const slice = text.slice(offset, offset + max);
          const more = offset + max < text.length ? `\n\n[... ${text.length - offset - max} more chars; total ${text.length}. Use offset=${offset + max} to continue ...]` : "";
          return `${slice}${more}`;
        }
        case "write_file": {
          const path = String(args.path || "");
          if (!path.startsWith("/work")) return "Refused: files may only be written under /work.";
          await sandbox.writeText(path, String(args.content ?? ""));
          return `Wrote ${String(args.content ?? "").length} chars to ${path}.`;
        }
        case "run_command": {
          const command = String(args.command || "");
          if (!command.trim()) return "Refused: empty command.";
          const requested = (Number(args.timeout_seconds) || 600) * 1000;
          const timeoutMs = Math.min(Math.max(requested, 5_000), REPRODUCTION_BUDGET.perCommandMs);
          const result = await sandbox.exec(["bash", "-lc", command], { timeoutMs });
          return fmtExec(result);
        }
        case "record_result": {
          const id = String(args.id || "").trim();
          const claim = String(args.claim || "").trim();
          const statusRaw = String(args.status || "").toLowerCase().trim();
          if (!id || !claim) return "Refused: id and claim are required.";
          const status: RecordedResult["status"] = statusRaw === "pending" || (VERDICTS as readonly string[]).includes(statusRaw)
            ? (statusRaw as Verdict | "pending")
            : "pending";
          const prev = recorded.get(id);
          recorded.set(id, {
            id,
            claim,
            status,
            originalValue: args.original_value !== undefined ? String(args.original_value) : prev?.originalValue,
            reproducedValue: args.reproduced_value !== undefined ? String(args.reproduced_value) : prev?.reproducedValue,
            evidence: args.evidence !== undefined ? String(args.evidence) : prev?.evidence,
            notes: args.notes !== undefined ? String(args.notes) : prev?.notes,
          });
          const summary = Array.from(recorded.values()).map(r => `${r.id}=${r.status}`).join(", ");
          return `Recorded ${id} as ${status}. Registered results: ${summary}.`;
        }
        default:
          return `Unknown tool: ${name}`;
      }
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
    toolLoopResult = await runToolLoop(modelConfig, opts.reproducerPrompt, userMessage, TOOLS, execute, {
      maxToolCalls: REPRODUCTION_BUDGET.maxToolCalls,
      deadlineMs: startTime + REPRODUCTION_BUDGET.wallClockMs,
      maxTokens: 8000,
      temperature: 0.2,
      onToolCall: async (rec: ToolCallRecord) => {
        if (rec.name === "run_command") {
          const cmd = String(rec.args.command || "").replace(/\s+/g, " ").slice(0, 140);
          const firstLine = rec.result.split("\n")[0];
          await emitEvent("reproduction-run", `[${rec.index}/${REPRODUCTION_BUDGET.maxToolCalls}] ${cmd} → ${firstLine}`);
        } else if (rec.name === "record_result") {
          await emitEvent("reproduction-record", `[${rec.index}/${REPRODUCTION_BUDGET.maxToolCalls}] ${rec.args.id}: ${rec.args.status} — ${String(rec.args.claim || "").slice(0, 120)}`);
        } else if (rec.index % 10 === 0) {
          await emitEvent("reproduction-progress", `${rec.index} tool calls used (${Math.round((Date.now() - startTime) / 60000)} min elapsed).`);
        }
      },
    });
    await emitEvent("reproduction-agent", `Agent finished after ${toolLoopResult.toolCalls.length} tool call(s) (${toolLoopResult.stoppedBy}); logbook ${toolLoopResult.content.length} chars.`);
  } finally {
    await sandbox.terminate();
    await emitEvent("reproduction-sandbox", `Sandbox ${sandbox.sandboxId} terminated.`);
  }

  const logbook = toolLoopResult.content;
  const toolCalls = toolLoopResult.toolCalls;
  const recordedList = Array.from(recorded.values());

  // Judge pass: a separate model grades the logbook against the raw tool outputs.
  await emitEvent("reproduction-judge", `Judge (${judgeModelConfig.modelName || judgeModelConfig.provider}) grading ${recordedList.length} recorded result(s)...`);
  let transcript = "";
  for (const t of toolCalls) {
    const argsText = t.name === "run_command" ? String(t.args.command || "") : JSON.stringify(t.args);
    const block = `### [${t.index}] ${t.name}: ${argsText.slice(0, 500)}\n${t.result.slice(0, JUDGE_TOOL_RESULT_CHARS)}${t.result.length > JUDGE_TOOL_RESULT_CHARS ? "\n[... truncated ...]" : ""}\n\n`;
    if (transcript.length + block.length > JUDGE_TRANSCRIPT_CHARS) {
      transcript += `[... ${toolCalls.length - t.index + 1} further tool call(s) omitted for length ...]\n`;
      break;
    }
    transcript += block;
  }
  const judgeInput = [
    `# PAPER`,
    `**Title:** ${title}`,
    `**Abstract:** ${abstract || "(none)"}`,
    ``,
    `# AGENT'S RECORDED RESULTS (proposals, not verdicts)`,
    recordedList.length ? JSON.stringify(recordedList, null, 2) : "(the agent registered no results)",
    ``,
    `# AGENT'S LOGBOOK`,
    logbook || "(no logbook produced)",
    ``,
    `# TOOL TRANSCRIPT (commands and outputs)`,
    transcript || "(no tools were called)",
  ].join("\n");

  let judgeSummary = "";
  let results: ClaimVerdict[] = [];
  try {
    const judged = await generateWithConfig(judgeModelConfig, opts.judgePrompt, judgeInput, { maxTokens: 6000, temperature: 0.1 });
    const parsed = parseJudgeOutput(judged.content);
    judgeSummary = parsed.summary;
    results = parsed.results;
  } catch (err) {
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
