// Reproduction agent (P) prompts, verdict parsing, and report composition.
// The pipeline mirrors the ICML 2026 reproduction hackathon (Hugging Face ×
// alphaXiv): extract each paper's core results, regenerate them from the shipped
// code and data in a sandbox, keep a full logbook, then have a separate judge
// read the logbook and issue verified / falsified / toy / inconclusive per result.

export const VERDICTS = ["verified", "falsified", "toy", "inconclusive"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const OVERALL_VERDICTS = ["verified", "partially verified", "falsified", "toy", "inconclusive"] as const;
export type OverallVerdict = (typeof OVERALL_VERDICTS)[number];

export const VERDICT_LABELS: Record<Verdict, string> = {
  verified: "Verified",
  falsified: "Falsified",
  toy: "Toy reproduction",
  inconclusive: "Inconclusive",
};

export interface RecordedResult {
  id: string;
  claim: string;
  status: Verdict | "pending";
  originalValue?: string;
  reproducedValue?: string;
  evidence?: string;
  notes?: string;
}

export interface ClaimVerdict {
  id: string;
  claim: string;
  verdict: Verdict;
  originalValue?: string;
  reproducedValue?: string;
  evidence?: string;
  confidence?: "high" | "medium" | "low";
}

export interface VerdictCounts {
  total: number;
  verified: number;
  falsified: number;
  toy: number;
  inconclusive: number;
}

export const REPRODUCER_PROMPT = `You are the Machine Institute Reproduction Agent (role code P). Your job is to independently reproduce the core scientific results of a published paper using exactly the materials its authors shipped with it (paper, README, analysis scripts, raw result files, notebooks), inside a GPU sandbox that you control through tools.

Follow the methodology of the ICML 2026 reproduction hackathon (Hugging Face × alphaXiv):

1. EXTRACT. Read /work/paper.md and the README, then list the paper's core quantitative results (typically 3–8). For each, register it with record_result(status="pending") giving an id (R1, R2, ...), the exact claim as stated, the reported number(s), and where it appears (section, table, figure, results file).

2. REPRODUCE. For each result, regenerate it from the shipped code and data. Run the actual scripts in their dependency order (the README usually documents this). Install missing packages with pip, fix paths so scripts find /work/materials and write to /work/results, and rely on HF_TOKEN already being in the environment for gated models. Prefer real, full-scale runs on the GPU. Only if the exact experiment is infeasible here (data not shipped, model too large for the GPU, prohibitive runtime) perform a TOY reproduction — scale down (fewer prompts, fewer seeds, a smaller model from the same family) — and say so explicitly. In addition, re-derive the paper's summary statistics from the shipped raw result files to check that the raw outputs and the paper's text agree with each other.

3. RECORD. Update every result with record_result(...): status verified / falsified / toy / inconclusive, original_value, reproduced_value, evidence (which commands and files produced the numbers), and notes. Never leave a result at "pending" at the end — use inconclusive if you ran out of budget.

4. LOGBOOK. When you are done — or when told the budget is exhausted — reply (with no further tool calls) with your final LOGBOOK in markdown, with exactly these sections: "## Claims" (the list of results and their final status), "## Reproduction Log" (a chronological account of what you ran, what happened, and what you concluded, citing concrete numbers from tool outputs), "## Discrepancies" (every mismatch between reported and reproduced values, with both numbers), and "## Limitations" (what could not be done and why).

Rules:
- Never fabricate outputs. Only cite numbers that actually appeared in a tool result.
- Do not change the shipped analysis logic except to fix paths, missing imports, or to scale an experiment down; document every edit you make.
- Respect the per-command timeout: long scripts can be split, run with reduced settings, or launched with nohup and polled.
- You have a fixed tool-call budget and a wall-clock budget. Plan first (read the README and inspect the results directory), then run the most informative scripts first.
- Never print secrets or environment variables. Do not use the network except for pip and Hugging Face downloads.`;

export const JUDGE_PROMPT = `You are the Reproduction Judge for the Machine Institute. You receive (1) the paper's title and abstract, (2) the Reproduction Agent's structured results, (3) its final logbook, and (4) the commands it ran with their outputs. Issue one verdict per result, using the ICML reproduction-hackathon scale:

- verified: the agent regenerated the result from the shipped code/data (or re-derived it from the shipped raw outputs) and it matches the paper within a reasonable tolerance.
- falsified: the agent obtained a materially different result, or the shipped code/data contradict what the paper reports.
- toy: only a scaled-down or synthetic-data reproduction was feasible; it is directionally consistent but is not a real reproduction.
- inconclusive: the result could not be tested (missing data or code, hardware or runtime limits, errors), or the evidence is insufficient either way.

Be strict. The agent's own status for each result is a proposal, not the verdict. Verify that every number the agent cites in its logbook appears in the tool outputs; if a cited number cannot be found in any tool output, do not count it as evidence. A result is only "verified" if a real regeneration or raw-data re-derivation actually occurred.

Respond with ONLY a JSON object inside a \`\`\`json fence, in exactly this shape:
{"summary": "3–5 sentences summarising the reproduction outcome and the most important discrepancies.", "results": [{"id": "R1", "claim": "...", "verdict": "verified|falsified|toy|inconclusive", "original_value": "...", "reproduced_value": "...", "evidence": "...", "confidence": "high|medium|low"}]}`;

// ---------------------------------------------------------------------------
// Judge output parsing
// ---------------------------------------------------------------------------

function normalizeVerdict(raw: unknown): Verdict {
  const v = String(raw ?? "").toLowerCase().trim();
  if (v.startsWith("verif")) return "verified";
  if (v.startsWith("fals") || v.startsWith("refut") || v.startsWith("contradict")) return "falsified";
  if (v.startsWith("toy") || v.includes("scaled")) return "toy";
  return "inconclusive";
}

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1].trim().startsWith("{")) return fenced[1].trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const str = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.trim() ? s.trim() : undefined;
};

export function parseJudgeOutput(text: string): { summary: string; results: ClaimVerdict[] } {
  const json = extractJsonObject(text || "");
  if (!json) return { summary: "", results: [] };
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { summary: "", results: [] };
  }
  const rawResults: unknown[] = Array.isArray(parsed?.results) ? parsed.results : [];
  const results: ClaimVerdict[] = rawResults
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r, i): ClaimVerdict => {
      const conf = String(r.confidence ?? "").toLowerCase();
      return {
        id: str(r.id) ?? `R${i + 1}`,
        claim: str(r.claim) ?? "",
        verdict: normalizeVerdict(r.verdict),
        originalValue: str(r.original_value ?? r.originalValue),
        reproducedValue: str(r.reproduced_value ?? r.reproducedValue),
        evidence: str(r.evidence),
        confidence: conf === "high" || conf === "medium" || conf === "low" ? conf : undefined,
      };
    })
    .filter(r => r.claim.length > 0);
  return { summary: str(parsed?.summary) ?? "", results };
}

// If the judge failed to produce usable JSON, fall back to the agent's own
// recorded statuses so the report is never empty (pending → inconclusive).
export function verdictsFromRecordedResults(recorded: RecordedResult[]): ClaimVerdict[] {
  return recorded.map(r => ({
    id: r.id,
    claim: r.claim,
    verdict: r.status === "pending" ? "inconclusive" : r.status,
    originalValue: r.originalValue,
    reproducedValue: r.reproducedValue,
    evidence: r.evidence,
  }));
}

export function countVerdicts(results: ClaimVerdict[]): VerdictCounts {
  const counts: VerdictCounts = { total: results.length, verified: 0, falsified: 0, toy: 0, inconclusive: 0 };
  for (const r of results) counts[r.verdict]++;
  return counts;
}

// Deterministic paper-level verdict, following the hackathon's reporting: any
// falsified result marks the paper as falsified; all verified → verified; some
// verified → partially verified; otherwise toy-only or inconclusive.
export function deriveOverallVerdict(results: ClaimVerdict[]): OverallVerdict {
  const c = countVerdicts(results);
  if (c.total === 0) return "inconclusive";
  if (c.falsified > 0) return "falsified";
  if (c.verified === c.total) return "verified";
  if (c.verified > 0) return "partially verified";
  if (c.toy > 0) return "toy";
  return "inconclusive";
}

// Future Science revision arrays: falsified results are major, toy and
// inconclusive results are minor (the authors should make them reproducible).
export function verdictsToRevisions(results: ClaimVerdict[]): {
  major: Array<{ description: string }>;
  minor: Array<{ description: string }>;
} {
  const describe = (r: ClaimVerdict): string => {
    const values = r.originalValue || r.reproducedValue
      ? ` (reported: ${r.originalValue || "n/a"}; reproduced: ${r.reproducedValue || "n/a"})`
      : "";
    return `${r.id}: ${r.claim}${values} — ${VERDICT_LABELS[r.verdict]}.`;
  };
  return {
    major: results.filter(r => r.verdict === "falsified").map(r => ({ description: describe(r) })),
    minor: results.filter(r => r.verdict === "toy" || r.verdict === "inconclusive").map(r => ({ description: describe(r) })),
  };
}

// ---------------------------------------------------------------------------
// Report composition
// ---------------------------------------------------------------------------

export function buildReproductionTitle(paperTitle: string): string {
  return `Reproduction Report: "${paperTitle}"`;
}

const ABSTRACT_MAX = 1200;

export function buildReproductionAbstract(input: {
  paperTitle: string;
  overall: OverallVerdict;
  counts: VerdictCounts;
  summary?: string | null;
  gpu: string;
  realExecution: boolean;
}): string {
  const clean = (s: string) => (s || "").replace(/\s+/g, " ").trim();
  const c = input.counts;
  const parts = [
    `Independent reproduction of "${clean(input.paperTitle)}" by the Machine Institute Reproduction Agent — overall verdict: ${input.overall}.`,
    `${c.total} core result${c.total === 1 ? "" : "s"} were extracted and tested${input.realExecution ? ` by re-running the authors' shipped code and data in an isolated ${input.gpu} GPU sandbox` : " from the authors' shipped materials"}: ${c.verified} verified, ${c.falsified} falsified, ${c.toy} toy-scale, ${c.inconclusive} inconclusive.`,
  ];
  const summary = clean(input.summary || "");
  if (summary) parts.push(summary);
  parts.push("Verdicts follow the ICML 2026 reproduction-hackathon scale and were issued by a separate judge model from the agent's full logbook and command outputs.");
  let abstract = parts.join(" ");
  if (abstract.length > ABSTRACT_MAX) abstract = abstract.slice(0, ABSTRACT_MAX - 1).trimEnd() + "…";
  return abstract;
}

export interface ReproductionReportInput {
  paperTitle: string;
  paperAuthors: string;
  paperDate: string;
  paperUrl: string;
  journalDisplayName: string;
  overall: OverallVerdict;
  results: ClaimVerdict[];
  judgeSummary: string;
  logbook: string;
  materialsInventory: string;
  materialsCounts: { text: number; binary: number };
  environment: { gpu: string; image: string; reproducerModel: string; judgeModel: string; maxToolCalls: number; wallClockMinutes: number; perCommandMinutes: number };
  toolCalls: Array<{ index: number; name: string; args: Record<string, unknown>; durationMs: number; error: boolean; resultPreview: string }>;
  stoppedBy: string;
  sandboxAvailable: boolean;
}

function fmtArgs(name: string, args: Record<string, unknown>): string {
  if (name === "run_command" && typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  if (name === "record_result") return `${args.id ?? "?"} → ${args.status ?? "?"}`;
  const s = JSON.stringify(args);
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

export function buildReproductionMarkdown(input: ReproductionReportInput): string {
  const counts = countVerdicts(input.results);
  const L: string[] = [];
  L.push(`## Reproduction Summary`);
  L.push(``);
  L.push(`**Overall verdict:** ${input.overall}`);
  L.push(``);
  L.push(`${counts.total} core result${counts.total === 1 ? "" : "s"} extracted — ${counts.verified} verified, ${counts.falsified} falsified, ${counts.toy} toy-scale, ${counts.inconclusive} inconclusive.`);
  if (input.judgeSummary) {
    L.push(``);
    L.push(input.judgeSummary.trim());
  }
  L.push(``);
  L.push(`## Original Paper`);
  L.push(``);
  L.push(`- **Title:** ${input.paperTitle}`);
  L.push(`- **Authors:** ${input.paperAuthors}`);
  L.push(`- **Published:** ${input.paperDate || "n.d."} in ${input.journalDisplayName}`);
  L.push(`- **URL:** ${input.paperUrl}`);
  L.push(``);
  L.push(`## Methodology`);
  L.push(``);
  L.push(`This report follows the protocol of the ICML 2026 reproduction hackathon organised by Hugging Face and alphaXiv. The Reproduction Agent (1) extracted the paper's core quantitative results, (2) attempted to regenerate each one from the code, data, and raw result files the authors published as supplementary material, running the authors' scripts inside an isolated GPU sandbox, falling back to a scaled-down "toy" reproduction only when the full experiment was infeasible, (3) kept a logbook with the full trace of its actions, and (4) a separate judge model read the logbook and every command output and issued one of four verdicts per result: verified, falsified, toy, or inconclusive. The paper-level verdict is derived deterministically from the per-result verdicts (any falsified result marks the paper as falsified).`);
  L.push(``);
  L.push(`## Environment`);
  L.push(``);
  if (input.sandboxAvailable) {
    L.push(`- **Sandbox:** Modal GPU sandbox (${input.environment.gpu}), image \`${input.environment.image}\``);
  } else {
    L.push(`- **Sandbox:** unavailable — no code was executed; verdicts rest on reading the shipped materials only`);
  }
  L.push(`- **Reproduction agent model:** ${input.environment.reproducerModel}`);
  L.push(`- **Judge model:** ${input.environment.judgeModel}`);
  L.push(`- **Budget:** ${input.environment.maxToolCalls} tool calls, ${input.environment.wallClockMinutes} min wall-clock, ${input.environment.perCommandMinutes} min per command (run ended by: ${input.stoppedBy})`);
  L.push(`- **Materials examined:** ${input.materialsCounts.text} text file${input.materialsCounts.text === 1 ? "" : "s"} (scripts, results, notebooks, README) and ${input.materialsCounts.binary} binary file${input.materialsCounts.binary === 1 ? "" : "s"} (figures)`);
  L.push(``);
  L.push(`## Results`);
  L.push(``);
  if (input.results.length === 0) {
    L.push(`No core results could be extracted or graded.`);
  }
  for (const r of input.results) {
    L.push(`### ${r.id} — ${VERDICT_LABELS[r.verdict]}${r.confidence ? ` (${r.confidence} confidence)` : ""}`);
    L.push(``);
    L.push(`**Claim.** ${r.claim}`);
    L.push(``);
    if (r.originalValue || r.reproducedValue) {
      L.push(`- **Reported:** ${r.originalValue || "n/a"}`);
      L.push(`- **Reproduced:** ${r.reproducedValue || "n/a"}`);
      L.push(``);
    }
    if (r.evidence) {
      L.push(`**Evidence.** ${r.evidence}`);
      L.push(``);
    }
  }
  L.push(`## Materials Examined`);
  L.push(``);
  L.push(input.materialsInventory);
  L.push(``);
  L.push(`## Commands Executed`);
  L.push(``);
  const runs = input.toolCalls.filter(t => t.name === "run_command");
  if (runs.length === 0) {
    L.push(`No commands were executed.`);
  } else {
    for (const t of runs) {
      L.push(`${t.index}. \`${fmtArgs(t.name, t.args)}\` — ${(t.durationMs / 1000).toFixed(1)}s${t.error ? " (error)" : ""}`);
    }
  }
  L.push(``);
  L.push(`## Reproduction Logbook`);
  L.push(``);
  L.push(input.logbook.trim() || "(The agent did not produce a logbook.)");
  L.push(``);
  L.push(`## Tool Trace`);
  L.push(``);
  for (const t of input.toolCalls) {
    L.push(`- [${t.index}] ${t.name}: \`${fmtArgs(t.name, t.args)}\` (${(t.durationMs / 1000).toFixed(1)}s${t.error ? ", error" : ""}) — ${t.resultPreview}`);
  }
  return L.join("\n");
}

// Compact one-line preview of a tool result for the trace section.
export function previewToolResult(result: string, max = 220): string {
  const oneLine = (result || "").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine || "(empty)";
}
