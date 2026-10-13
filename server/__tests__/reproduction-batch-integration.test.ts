import { beforeEach, describe, expect, it, vi } from "vitest";

// Offline end-to-end coverage of the production entrypoint (runReproduction in
// batch mode): extraction → planning → host-executed experiments → model
// assessment → independent judge → completed report. Every model reply is a
// scripted tool call; every sandbox command is a scripted exec result.
const mock = vi.hoisted(() => ({ complete: vi.fn(), create: vi.fn(), context: vi.fn(), materials: vi.fn() }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create: mock.complete } }; } }));
vi.mock("../storage", () => ({ storage: {} }));
vi.mock("../ethics-review", () => ({ loadPaperContext: mock.context }));
vi.mock("../fs-materials", () => ({
  fetchContributionMaterials: mock.materials,
  materialSandboxPath: (f: { name: string }) => `/work/materials/${f.name}`,
  formatMaterialsInventory: (m: { files?: Array<{ name: string }> }) =>
    `Shipped text files for the reproduction:\n${(m?.files ?? []).map(f => `- /work/materials/${f.name}`).join("\n")}`,
}));
vi.mock("../modal-sandbox", () => ({ isModalConfigured: () => true, ReproductionSandbox: { create: mock.create } }));
vi.mock("../provider-credit-preflight", () => ({ assertReproductionRuntimeProviderCredits: vi.fn(async () => {}) }));

import { runReproduction, type RunReproductionOptions } from "../reproduce";
import type { PipelineCheckpoint } from "../reproduction-batch";
import { getReproducerPrompt, getJudgePrompt } from "../prompts/reproduce";

// ------------------------------------------------------------------ fixtures
const GREEK = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu"];
const value = (i: number) => (0.5 + i * 0.03).toFixed(2);
const sentence = (i: number) => `The measured ${GREEK[i]} score was ${value(i)}.`;
const scoreLine = (i: number) => `${GREEK[i]}_score=${value(i)}`;
const greekOf = (claim: string) => /measured (\w+) score/.exec(claim)?.[1] ?? "unknown";
const sentences = (n: number) => Array.from({ length: n }, (_, i) => sentence(i));
const paperFor = (n: number) => [
  "# Benchmark study", "", "## Results", "",
  `We evaluate the method on the shipped benchmark. ${sentences(n).join(" ")}`, "",
  "## Method", "", "The shipped script analyze.py recomputes every reported score from the shipped inputs.", "",
].join("\n");
const analyzeOutput = (n: number) => Array.from({ length: n }, (_, i) => scoreLine(i)).join("\n");
const ANALYZE_SOURCE = 'import sys\n\nSCORES = {"alpha": 0.50}\nfor name, score in SCORES.items():\n    print(f"{name}_score={score:.2f}")\n';
const README = "# Materials\n\nRun `python /work/materials/analyze.py`; it prints every reported score as NAME_score=VALUE.\n";
const RAW_CSV = "trial,beta\n1,0.50\n2,0.56\n3,0.53\n";
const ANALYZE = "python /work/materials/analyze.py";
const file = (name: string, text: string) => ({ name, source: "additional", kind: "text", text });

function setPaper(n: number, extraFiles: Array<ReturnType<typeof file>> = [], analyzeSource = ANALYZE_SOURCE) {
  const paper = paperFor(n);
  mock.context.mockResolvedValue({ title: "Benchmark study", authors: "Authors", date: "2026", abstract: "Benchmark scores", url: "https://example.test", fullText: paper, fsAbstracts: [] });
  const files = [file("analyze.py", analyzeSource), file("README.md", README), ...extraFiles];
  mock.materials.mockResolvedValue({ files, paperMarkdown: paper, textFileCount: files.length, binaryFileCount: 0 });
}

// ------------------------------------------------------------------- sandbox
interface ExecResult { stdout: string; stderr: string; exitCode: number; timedOut: boolean; durationMs: number }
const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", exitCode: 0, timedOut: false, durationMs: 1 });
const fail = (stderr: string, exitCode = 1): ExecResult => ({ stdout: "", stderr, exitCode, timedOut: false, durationMs: 1 });
const QP_MANIFEST = JSON.stringify(["/opt/conda", "/usr", "/work/python-packages"].map(root => ({ root, sha256: "mocked-sha256" })));
type Runner = (command: string, opts: { workdir?: string }, argv: string[]) => ExecResult | undefined;

/** strictReads: reading a path that was never written fails like the real filesystem instead of returning "". */
function sandbox(run: Runner, { strictReads = false }: { strictReads?: boolean } = {}) {
  const files = new Map<string, string>();
  const commands: Array<{ command: string; workdir?: string }> = [];
  const exec = vi.fn(async (argv: string[], opts: { workdir?: string } = {}) => {
    const shell = argv.findIndex((token, i) => token === "bash" && /^-l?c$/.test(argv[i + 1] ?? ""));
    const command = shell >= 0 ? argv[shell + 2] : argv.join(" ");
    if (command.includes("nvidia-smi")) return ok("Tesla T4, 15360 MiB\ntorch 2.4.0 cuda True transformers 4.44.0");
    commands.push({ command, workdir: opts.workdir });
    return run(command, opts, argv) ?? ok("");
  });
  const sb = {
    sandboxId: "batch-sandbox", image: "test-image", files, commands, exec,
    writeText: vi.fn(async (p: string, t: string) => { files.set(p, t); }),
    readText: vi.fn(async (p: string) => {
      if (p === "/work/qp-dependencies.json") return QP_MANIFEST;
      const text = files.get(p);
      if (text === undefined && strictReads) throw new Error(`No such file or directory: ${p}`);
      return text ?? "";
    }),
    listFiles: vi.fn(async () => [] as Array<{ name: string; isDir: boolean; size?: number }>),
    terminate: vi.fn(async () => {}),
  };
  mock.create.mockResolvedValue(sb);
  return sb;
}

// --------------------------------------------------------------------- model
type Completion = { choices: Array<{ finish_reason: string; message: { content: string | null; tool_calls?: unknown[] } }> };
const complete = (content: string | null, tool_calls?: unknown[]): Completion =>
  ({ choices: [{ finish_reason: tool_calls ? "tool_calls" : "stop", message: { content, ...(tool_calls ? { tool_calls } : {}) } }] });
let callSerial = 0;
const tool = (name: string, args: Record<string, unknown>) => ({ id: `call-${++callSerial}`, type: "function", function: { name, arguments: JSON.stringify(args) } });

type Stage = "extraction" | "planning" | "repair" | "derivation" | "assessment" | "sweep" | "judge" | "unknown";
interface PacketClaim { id: string; value?: string; claim: string }
interface Packet { text: string; claims: PacketClaim[]; experiment?: string; method?: string; evidenceId?: number; failingId?: number; rawReads: Array<{ path: string; id: number }> }
interface Turn { stage: Stage; packet: Packet; step: number; toolMessages: string[]; toolNames: string[]; request: any }
type Script = Partial<Record<Stage, (turn: Turn) => Completion | undefined>>;

function parsePacket(text: string): Packet {
  const claims: PacketClaim[] = [];
  const claimLine = /^- (R\d+)(?: \(original_value: ([^)]*)\))?: ("(?:[^"\\]|\\.)*")/gm;
  for (let m = claimLine.exec(text); m; m = claimLine.exec(text)) claims.push({ id: m[1], value: m[2], claim: JSON.parse(m[3]) });
  const rawReads: Array<{ path: string; id: number }> = [];
  const rawLine = /(\/work\/\S+) → #(\d+)/g;
  for (let m = rawLine.exec(text); m; m = rawLine.exec(text)) rawReads.push({ path: m[1], id: Number(m[2]) });
  const num = (re: RegExp) => { const m = re.exec(text); return m ? Number(m[1]) : undefined; };
  return {
    text, claims, rawReads,
    experiment: /experiment (X\d+)/.exec(text)?.[1],
    method: /experiment X\d+ \((rerun|raw-data-rederived|toy|blocked)/.exec(text)?.[1],
    evidenceId: num(/Successful execution #(\d+)/),
    failingId: num(/Last failing execution #(\d+)/),
  };
}

function stageOf(request: any): { stage: Stage; text: string } {
  if (!request.tools) return { stage: "judge", text: "" };
  const first = request.messages.find((m: any) => m.role === "user");
  const text = String(first?.content ?? "");
  const prefixes: Array<[string, Stage]> = [
    ["Canonical paper packet", "extraction"], ["CURRENT STAGE: planning", "planning"], ["CURRENT STAGE: repair", "repair"],
    ["CURRENT STAGE: computation", "derivation"], ["CURRENT STAGE: assessment", "assessment"], ["CURRENT STAGE: final sweep", "sweep"],
  ];
  return { stage: prefixes.find(([prefix]) => text.startsWith(prefix))?.[1] ?? "unknown", text };
}

/** Scripts answer per stage; a missing or undefined answer is prose without a tool call. */
function respond(script: Script): Turn[] {
  const trace: Turn[] = [];
  mock.complete.mockImplementation(async (request: any) => {
    const { stage, text } = stageOf(request);
    const toolMessages = request.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content));
    const toolNames = (request.tools ?? []).map((t: any) => t.function?.name ?? t.name);
    // The loop mutates its messages array in place; keep what this request actually contained.
    const turn: Turn = { stage, packet: parsePacket(text), step: toolMessages.length, toolMessages, toolNames, request: { ...request, messages: request.messages.map((m: any) => ({ ...m })) } };
    trace.push(turn);
    return script[stage]?.(turn) ?? complete(`Prose only during ${stage}; no tool was called.`);
  });
  return trace;
}
const lastToolCallId = (turn: Turn) => Number(/^\[Tool call #(\d+)\]/.exec(turn.toolMessages[turn.toolMessages.length - 1] ?? "")?.[1]);
const stages = (trace: Turn[]) => trace.map(t => t.stage);
const modelStages = (trace: Turn[]) => stages(trace).filter(s => s !== "judge");

const extraction = (claims: string[]): Script["extraction"] => turn => {
  const batch = claims.slice(turn.step * 5, turn.step * 5 + 5);
  return complete(null, [tool("submit_claims", {
    claims: batch.map(quote => ({ source_quote: quote, copy_source_quote: true, original_value: /([0-9]+\.[0-9]+)\.$/.exec(quote)?.[1] })),
    has_more: turn.step * 5 + 5 < claims.length,
  })]);
};
const rerunPlan = (extra: Record<string, unknown> = {}): Script["planning"] => turn => complete(null, [tool("submit_plan", {
  experiments: [{
    method: "rerun", command: ANALYZE, material_paths: ["/work/materials/analyze.py"],
    rationale: "analyze.py prints every reported score as NAME_score=VALUE, which is exactly the quantity each claim reports.",
    claims: turn.packet.claims.map(c => ({ claim_id: c.id, measurement: `the ${greekOf(c.claim)}_score line printed by analyze.py` })),
    ...extra,
  }],
})]);
const excerptFor = (c: PacketClaim, method?: string) =>
  method === "raw-data-rederived" ? `${c.id} ${greekOf(c.claim)}_mean=${c.value}` : `${greekOf(c.claim)}_score=${c.value}`;
/** Records every listed claim from the packet's cited execution: verified on success, a command-error blocker on failure. */
const recordAll: Script["assessment"] = turn => {
  const p = turn.packet;
  if (p.evidenceId !== undefined) {
    return complete(null, [tool("record_results", { results: p.claims.map(c => ({
      id: c.id, status: "verified", method: p.method, reproduced_value: c.value,
      evidence_tool_call_ids: [p.evidenceId], evidence_excerpt: excerptFor(c, p.method),
      evidence: `The captured output line ${excerptFor(c, p.method)} matches the reported value ${c.value}.`,
      ...(p.method === "raw-data-rederived" ? { raw_input_path: p.rawReads[0]?.path, raw_input_tool_call_id: p.rawReads[0]?.id } : {}),
    })) })]);
  }
  if (p.failingId !== undefined) {
    return complete(null, [tool("record_results", { results: p.claims.map(c => ({
      id: c.id, status: "inconclusive", method: "blocked", blocker_kind: "command-error",
      evidence_tool_call_ids: [p.failingId], evidence_excerpt: "RuntimeError: calibration table missing",
      evidence: "The planned script failed with a RuntimeError (calibration table missing), so the score could not be measured.",
    })) })]);
  }
  return undefined;
};
const judge = (checkpoints: PipelineCheckpoint[]): Script["judge"] => () => {
  const claims = checkpoints[checkpoints.length - 1]?.claims ?? [];
  return complete(JSON.stringify({
    summary: "Independent judge: every verdict follows the cited captured output.",
    results: claims.map(c => ({ id: c.id, claim: c.claim, verdict: c.status === "pending" ? "inconclusive" : c.status, evidence: "Compared the recorded excerpt with the captured tool output.", confidence: "high" })),
  }));
};

// ----------------------------------------------------------------------- run
const config = { providerMode: "platform" as const, provider: "openai", modelName: "openai/gpt-4o" };
function prepare(extra: Partial<RunReproductionOptions> = {}) {
  const checkpoints: PipelineCheckpoint[] = [];
  const persona = extra.agentId ?? "P";
  const options: RunReproductionOptions = {
    reproductionId: "batch", projectId: "p", journalId: "j", initiativeDocId: "i", initiativeSlug: "i", journalDisplayName: "Journal", documentId: "paper",
    reproducerPrompt: getReproducerPrompt(persona), judgePrompt: getJudgePrompt(persona), modelConfig: config, judgeModelConfig: config,
    gpu: "T4", emitEvent: vi.fn(async () => {}),
    onCheckpoint: async checkpoint => { checkpoints.push(structuredClone(checkpoint)); },
    ...extra,
  };
  return { checkpoints, start: () => runReproduction(options), last: () => checkpoints[checkpoints.length - 1] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.complete.mockReset();
  mock.create.mockReset();
  vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_API_KEY", "test");
  vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", "https://managed.example.test");
  vi.stubEnv("LAB_ALLOWED_MODELS", "openai/gpt-4o");
  setPaper(1);
});

describe("batch reproduction pipeline (website entrypoint, offline)", () => {
  it("reserves planning submission calls even when one response batches too many inspections", async () => {
    sandbox(command => command === ANALYZE ? ok(analyzeOutput(1)) : undefined);
    const { checkpoints, start } = prepare();
    let planningTurns = 0;
    const trace = respond({
      extraction: extraction(sentences(1)),
      planning: turn => {
        if (planningTurns++ === 0) return complete(null,
          Array.from({ length: 12 }, () => tool("read_file", { path: "/work/MATERIALS_INDEX.md" })));
        expect(turn.toolMessages.some(message => message.includes("Remaining calls are reserved"))).toBe(true);
        expect(turn.request.tool_choice).toEqual({ type: "function", function: { name: "submit_plan" } });
        return rerunPlan()!(turn);
      },
      assessment: recordAll, judge: judge(checkpoints),
    });
    const result = await start();
    expect(planningTurns).toBe(2);
    expect(result.counts).toMatchObject({ verified: 1 });
    expect(stages(trace)).toContain("judge");
  });

  it("plans one rerun, executes it on the host and completes a judged report with a verified claim", async () => {
    const sb = sandbox(command => command === ANALYZE ? ok(analyzeOutput(1)) : undefined);
    const { checkpoints, start, last } = prepare();
    const trace = respond({ extraction: extraction(sentences(1)), planning: rerunPlan(), assessment: recordAll, judge: judge(checkpoints) });
    const result = await start();
    expect(modelStages(trace)).toEqual(["extraction", "planning", "assessment"]);
    expect(stages(trace)).toContain("judge");
    expect(sb.commands).toEqual([{ command: ANALYZE, workdir: undefined }]);
    expect(result.stoppedBy).toBe("model");
    expect(result.counts).toMatchObject({ total: 1, verified: 1 });
    expect(result.results[0]).toMatchObject({ id: "R1", verdict: "verified" });
    // synthetic paper read, inventory, README, submit_plan, host run, record_results
    expect(result.toolCallCount).toBe(6);
    expect(last().controller.phase).toBe("complete");
    expect(last().failure).toBeUndefined();
    expect(last().claims).toEqual([expect.objectContaining({ id: "R1", status: "verified", evidenceIds: [5] })]);
    expect(last().outputs.find(o => o.id === 1)).toMatchObject({ tool: "read_file", origin: "pre-pipeline" });
    expect(last().outputs.find(o => o.tool === "run_command")).toMatchObject({ id: 5, origin: "host-run" });
    expect(last().outputs.find(o => o.tool === "record_results")).toMatchObject({ id: 6, origin: "agent-tool" });
    expect(last().controller.experiments[0]).toMatchObject({ id: "X1", method: "rerun", status: "assessed", executionIds: [5], evidenceId: 5, claimIds: ["R1"] });
    expect(result.logbook).toContain("### X1 — rerun");
    expect(result.logbook).toContain("R1 — verified (rerun): original 0.50 → reproduced 0.50 [evidence #5]");
    expect(sb.terminate).toHaveBeenCalledTimes(1);
  });

  it("covers twelve claims with three extraction batches, one plan, one host execution and one assessment call", async () => {
    setPaper(12);
    const sb = sandbox(command => command === ANALYZE ? ok(analyzeOutput(12)) : undefined);
    const { checkpoints, start, last } = prepare();
    const trace = respond({ extraction: extraction(sentences(12)), planning: rerunPlan(), assessment: recordAll, judge: judge(checkpoints) });
    const result = await start();
    expect(modelStages(trace)).toEqual(["extraction", "extraction", "extraction", "planning", "assessment"]);
    expect(sb.commands).toEqual([{ command: ANALYZE, workdir: undefined }]);
    expect(result.stoppedBy).toBe("model");
    expect(result.counts).toMatchObject({ total: 12, verified: 12 });
    expect(last().claims.map(c => c.id)).toEqual(Array.from({ length: 12 }, (_, i) => `R${i + 1}`));
    expect(last().claims.every(c => c.status === "verified")).toBe(true);
    // Model calls: 3 extraction submissions + submit_plan + record_results; the experiment itself cost none.
    expect(last().controller).toMatchObject({ phase: "complete", calls: 5, hostCommands: 1 });
  });

  it("repairs a local-module import deterministically from /work/materials without spending model calls", async () => {
    setPaper(1, [file("helpers.py", "def load():\n    return 0.5\n")]);
    const traceback = "Traceback (most recent call last):\n  File \"/work/materials/analyze.py\", line 1, in <module>\n    import helpers\nModuleNotFoundError: No module named 'helpers'";
    const sb = sandbox((command, opts) => command === ANALYZE ? (opts.workdir === "/work/materials" ? ok(analyzeOutput(1)) : fail(traceback)) : undefined);
    const { checkpoints, start, last } = prepare();
    const trace = respond({ extraction: extraction(sentences(1)), planning: rerunPlan(), assessment: recordAll, judge: judge(checkpoints) });
    const result = await start();
    expect(sb.commands).toEqual([{ command: ANALYZE, workdir: undefined }, { command: ANALYZE, workdir: "/work/materials" }]);
    expect(modelStages(trace)).toEqual(["extraction", "planning", "assessment"]);
    const x = last().controller.experiments[0];
    expect(x.repairs).toEqual(["working_directory=/work/materials (local module helpers)"]);
    expect(x.executionIds).toHaveLength(2);
    expect(x.evidenceId).toBe(x.executionIds[1]);
    expect(result.counts).toMatchObject({ total: 1, verified: 1 });
    expect(last().claims[0].evidenceIds).toEqual([x.executionIds[1]]);
    expect(result.logbook).toContain("Repairs: working_directory=/work/materials (local module helpers)");
  });

  it("installs a missing pip package under its import alias and reruns before any model repair", async () => {
    let attempts = 0;
    const traceback = "Traceback (most recent call last):\n  File \"/work/materials/analyze.py\", line 2, in <module>\n    from sklearn.metrics import f1_score\nModuleNotFoundError: No module named 'sklearn'";
    const sb = sandbox(command => {
      if (command === ANALYZE) return ++attempts === 1 ? fail(traceback) : ok(analyzeOutput(1));
      if (command === "pip install -q scikit-learn") return ok("Successfully installed scikit-learn-1.6.1");
      return undefined;
    });
    const { checkpoints, start, last } = prepare();
    const trace = respond({ extraction: extraction(sentences(1)), planning: rerunPlan(), assessment: recordAll, judge: judge(checkpoints) });
    const result = await start();
    expect(sb.commands.map(c => c.command)).toEqual([ANALYZE, "pip install -q scikit-learn", ANALYZE]);
    expect(modelStages(trace)).toEqual(["extraction", "planning", "assessment"]);
    const x = last().controller.experiments[0];
    expect(x.repairs).toEqual([expect.stringMatching(/^pip install scikit-learn → exit code 0 \(\d+\.\ds\) \(#6\)$/)]);
    expect(x.executionIds).toEqual([5, 7]);
    expect(x.evidenceId).toBe(7);
    expect(last().controller.hostCommands).toBe(3);
    expect(result.counts).toMatchObject({ total: 1, verified: 1 });
  });

  it("records an unrepairable failure as a command-error blocker after the model declares it", async () => {
    const traceback = "Traceback (most recent call last):\n  File \"/work/materials/analyze.py\", line 7, in <module>\n    raise RuntimeError(\"calibration table missing\")\nRuntimeError: calibration table missing";
    const sb = sandbox(command => command === ANALYZE ? fail(traceback) : undefined);
    const { checkpoints, start, last } = prepare();
    const trace = respond({
      extraction: extraction(sentences(1)), planning: rerunPlan(), assessment: recordAll, judge: judge(checkpoints),
      repair: () => complete(null, [tool("declare_blocked", {
        blocker_kind: "command-error",
        explanation: "analyze.py raises RuntimeError: calibration table missing before printing any score; no environment or path change can fix shipped code that fails.",
      })]),
    });
    const result = await start();
    expect(modelStages(trace)).toEqual(["extraction", "planning", "repair", "assessment"]);
    const repair = trace.find(t => t.stage === "repair")!;
    expect(repair.toolNames).toEqual(expect.arrayContaining(["read_file", "write_file", "run_command", "declare_blocked"]));
    expect(repair.packet.text).toContain("Failing execution #5: exit code 1");
    expect(sb.commands).toEqual([{ command: ANALYZE, workdir: undefined }]);
    const assessment = trace.find(t => t.stage === "assessment")!;
    expect(assessment.packet.failingId).toBe(5);
    expect(assessment.packet.text).toContain("blocker_kind command-error");
    expect(result.stoppedBy).toBe("model");
    expect(result.counts).toMatchObject({ total: 1, inconclusive: 1 });
    expect(last().controller.experiments[0]).toMatchObject({ status: "assessed", failure: expect.stringMatching(/^command-error: analyze\.py raises RuntimeError/) });
    expect(last().claims[0]).toMatchObject({ status: "inconclusive", evidenceIds: [5] });
    expect(result.logbook).toContain("R1 — inconclusive (blocked)");
    expect(result.logbook).toContain("Failure: command-error: analyze.py raises RuntimeError");
  });

  describe.each(["deferred", "planned"] as const)("raw-data re-derivation (%s)", mode => {
    it("writes and runs a claim-specific computation and records it against the host-read raw input", async () => {
      setPaper(2, [file("raw.csv", RAW_CSV)]);
      const DERIVE = "python /work/results/derive_X2.py";
      const sb = sandbox(command => command === ANALYZE ? ok(analyzeOutput(1)) : command === DERIVE ? ok("loaded /work/materials/raw.csv\nR2 beta_mean=0.53") : undefined);
      const { checkpoints, start, last } = prepare();
      const trace = respond({
        extraction: extraction(sentences(2)),
        planning: mode === "planned"
          ? () => complete(null, [tool("submit_plan", { experiments: [
            { method: "rerun", command: ANALYZE, material_paths: ["/work/materials/analyze.py"], rationale: "analyze.py prints the alpha score.", claims: [{ claim_id: "R1", measurement: "the alpha_score line printed by analyze.py" }] },
            { method: "raw-data-rederived", material_paths: ["/work/materials/raw.csv"], raw_inputs: ["/work/materials/raw.csv"], rationale: "No shipped script prints the beta score; raw.csv holds the per-trial beta values needed to recompute its mean.", claims: [{ claim_id: "R2", measurement: "mean of the beta column of raw.csv" }] },
          ] })])
          : rerunPlan(),
        assessment: turn => {
          if (mode === "deferred" && turn.packet.experiment === "X1") {
            const r1 = turn.packet.claims.find(c => c.id === "R1")!;
            return complete(null, [
              tool("defer_claims", { claim_ids: ["R2"], method: "raw-data-rederived", reason: "analyze.py prints only the alpha score; raw.csv holds the per-trial beta values needed to recompute the beta mean.", raw_inputs: ["/work/materials/raw.csv"] }),
              tool("record_results", { results: [{ id: "R1", status: "verified", method: "rerun", reproduced_value: r1.value, evidence_tool_call_ids: [turn.packet.evidenceId], evidence_excerpt: excerptFor(r1), evidence: "The alpha_score line matches the reported value." }] }),
            ]);
          }
          return recordAll!(turn);
        },
        derivation: turn => {
          if (turn.step === 0) return complete(null, [tool("write_file", { path: "/work/results/derive_X2.py", content: "import csv\nrows = [float(r['beta']) for r in csv.DictReader(open('/work/materials/raw.csv'))]\nprint('loaded /work/materials/raw.csv')\nprint('R2 beta_mean=%.2f' % (sum(rows) / len(rows)))\n" })]);
          if (turn.step === 1) return complete(null, [tool("run_command", { command: DERIVE })]);
          return complete(null, [tool("submit_for_assessment", { evidence_tool_call_id: lastToolCallId(turn) })]);
        },
        judge: judge(checkpoints),
      });
      const result = await start();
      expect(modelStages(trace)).toEqual(["extraction", "planning", "assessment", "derivation", "derivation", "derivation", "assessment"]);
      expect(sb.commands.map(c => c.command)).toEqual([ANALYZE, DERIVE]);
      expect(sb.files.get("/work/results/derive_X2.py")).toContain("csv.DictReader");
      const derivation = trace.find(t => t.stage === "derivation")!;
      expect(derivation.packet.text).toContain("/work/materials/raw.csv — read #");
      expect(derivation.toolNames).toEqual(expect.arrayContaining(["write_file", "run_command", "submit_for_assessment"]));
      const second = trace.filter(t => t.stage === "assessment")[1];
      expect(second.packet).toMatchObject({ experiment: "X2", method: "raw-data-rederived", rawReads: [{ path: "/work/materials/raw.csv", id: expect.any(Number) }] });
      expect(result.stoppedBy).toBe("model");
      expect(result.counts).toMatchObject({ total: 2, verified: 2 });
      const [x1, x2] = last().controller.experiments;
      expect(x1).toMatchObject({ id: "X1", method: "rerun", origin: "plan", status: "assessed", claimIds: mode === "deferred" ? ["R1", "R2"] : ["R1"] });
      expect(x2).toMatchObject({ id: "X2", method: "raw-data-rederived", origin: mode === "deferred" ? "deferred" : "plan", status: "assessed", claimIds: ["R2"] });
      expect(x2.command).toBeUndefined();
      // inventory, README and the raw input are host reads; the computation run is a model tool call.
      expect(last().outputs.filter(o => o.tool === "read_file" && o.origin === "host-run")).toHaveLength(3);
      expect(last().outputs.filter(o => o.tool === "run_command").map(o => o.origin)).toEqual(["host-run", "agent-tool"]);
      expect(last().claims.find(c => c.id === "R2")).toMatchObject({ status: "verified", evidenceIds: [x2.evidenceId] });
      expect(result.logbook).toContain(mode === "deferred" ? "### X2 — raw-data-rederived (deferred from assessment)" : "### X2 — raw-data-rederived: no planned command");
      if (mode === "deferred") expect(result.logbook).toContain("Assessment: R1: verified, R2: verified. R1=verified R2=deferred to X2");
      expect(result.logbook).not.toContain("System-finalized");
    });
  });

  it("finalizes an unassessed claim deterministically when the assessor never records, without inventing a verdict", async () => {
    const sb = sandbox(command => command === ANALYZE ? ok(analyzeOutput(1)) : undefined);
    const emitEvent = vi.fn(async () => {});
    const { checkpoints, start, last } = prepare({ emitEvent });
    // No assessment or sweep script: the model answers both stages with prose only.
    const trace = respond({ extraction: extraction(sentences(1)), planning: rerunPlan(), judge: judge(checkpoints) });
    const result = await start();
    // prose → nudge; prose → record_results forced and missing; prose → the stage ends. Same for the sweep.
    expect(modelStages(trace)).toEqual(["extraction", "planning", "assessment", "assessment", "assessment", "sweep", "sweep", "sweep"]);
    const [, retry, forced] = trace.filter(t => t.stage === "assessment");
    expect(retry.request.messages.some((m: any) => m.role === "user" && String(m.content).includes("Call record_results for the pending claims (R1)"))).toBe(true);
    expect(retry.request.tool_choice).toEqual({ type: "function", function: { name: "record_results" } });
    expect(forced.request.messages.some((m: any) => m.role === "user" && String(m.content).includes("The required record_results tool call was missing"))).toBe(true);
    expect(emitEvent.mock.calls.filter(([phase]) => phase === "reproduction-stage").map(([, message]) => message)).toEqual([
      expect.stringMatching(/^Stage assessment ended without reaching its goal \(no-progress, finish_reason=stop; 0\/3 tool calls, 1 answer\(s\) without a tool call\)\. State: \{"stage":"assessment","experiment":"X1","pending":\["R1"\]/),
      expect.stringMatching(/^Stage sweep ended without reaching its goal \(no-progress/),
    ]);
    expect(sb.commands).toEqual([{ command: ANALYZE, workdir: undefined }]);
    expect(result.stoppedBy).toBe("tool-budget");
    expect(result.counts).toMatchObject({ total: 1, inconclusive: 1 });
    expect(last().controller.phase).toBe("complete");
    expect(last().claims[0]).toMatchObject({ id: "R1", status: "inconclusive", evidenceIds: [] });
    expect(result.logbook).toContain("System-enforced tool-call budget exhaustion (all stage allowances consumed)");
    expect(result.logbook).toContain("## System-enforced final claim states");
    expect(result.logbook).toContain("System-finalized at the enforced call allowance (inconclusive, no verdict inferred): R1");
  });

  describe.each([
    ["openai/gpt-4o", "forces tool_choice", config],
    ["deepseek/deepseek-v4-pro-0813", "offers only record_results", { providerMode: "byoc" as const, provider: "openrouter", modelName: "deepseek/deepseek-v4-pro-0813", apiKey: `sk-or-v1-${"a".repeat(48)}` }],
  ])("assessor that analyses in prose before recording (%s: %s)", (modelName, _how, modelConfig) => {
    it("keeps the executed experiment's assessment instead of ending the stage with every claim pending", async () => {
      // BYOK OpenRouter looks up the model's context window; the lookup failing is handled and must not reach the network here.
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
      try {
        const sb = sandbox(command => command === ANALYZE ? ok(analyzeOutput(1)) : undefined);
        const emitEvent = vi.fn(async () => {});
        const onDiagnostics = vi.fn();
        const { checkpoints, start, last } = prepare({ emitEvent, modelConfig, judgeModelConfig: modelConfig, onDiagnostics });
        const prose = "alpha_score=0.50 matches the reported 0.50, so R1 is verified.";
        const trace = respond({
          extraction: extraction(sentences(1)), planning: rerunPlan(), judge: judge(checkpoints),
          // First answer: the verdict written as text, no tool call. After the nudge: the recorded result.
          assessment: turn => turn.request.messages.some((m: any) => m.role === "assistant") ? recordAll!(turn) : complete(prose),
        });
        const result = await start();
        expect(modelStages(trace)).toEqual(["extraction", "planning", "assessment", "assessment"]);
        const [first, second] = trace.filter(t => t.stage === "assessment");
        expect(first.toolNames).toEqual(expect.arrayContaining(["record_results", "read_tool_result", "read_file", "list_files", "defer_claims"]));
        expect(first.request.tool_choice).toBe("auto");
        expect(second.request.messages.filter((m: any) => m.role === "assistant")).toEqual([expect.objectContaining({ content: prose })]);
        expect(second.request.messages.filter((m: any) => m.role === "user" && String(m.content).includes("prose is not a recorded result and is not saved")).length).toBeGreaterThanOrEqual(1);
        if (modelName.startsWith("deepseek/")) {
          expect(second.toolNames).toEqual(["record_results"]);
          expect(second.request.tool_choice).toBe("auto");
        } else {
          expect(second.toolNames).toEqual(first.toolNames);
          expect(second.request.tool_choice).toEqual({ type: "function", function: { name: "record_results" } });
        }
        expect(sb.commands).toEqual([{ command: ANALYZE, workdir: undefined }]);
        expect(result.stoppedBy).toBe("model");
        expect(result.counts).toMatchObject({ total: 1, verified: 1 });
        expect(last().claims[0]).toMatchObject({ status: "verified", evidenceIds: [5] });
        expect(last().controller).toMatchObject({ phase: "complete", calls: 3 });
        expect(emitEvent.mock.calls.some(([phase]) => phase === "reproduction-stage")).toBe(false);
        expect(result.logbook).not.toContain("System-finalized");
        // Diagnostics travel with every checkpoint (plus the final snapshot), so an unfinished run stays inspectable.
        expect(onDiagnostics).toHaveBeenCalledTimes(checkpoints.length + 1);
        expect(onDiagnostics.mock.calls[0][0]).toMatchObject({ version: 1, events: expect.any(Array) });
        const beforeLastCheckpoint = onDiagnostics.mock.calls.at(-2)![0];
        expect(beforeLastCheckpoint.events.filter((e: any) => e.kind === "completion" && e.phase === "assessment").length).toBe(2);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it("records a grounded missing-material blocker when the plan declares a claim unmeasurable with the shipped materials", async () => {
    const sb = sandbox(() => undefined);
    const { checkpoints, start, last } = prepare();
    const trace = respond({
      extraction: extraction(sentences(1)),
      planning: () => complete(null, [tool("submit_plan", { experiments: [{
        method: "blocked", material_paths: [], rationale: "analyze.py hardcodes a single score; the benchmark inputs behind the measured alpha score are not shipped, so nothing can recompute it.",
        claims: [{ claim_id: "R1", measurement: "the alpha score, which needs the unshipped benchmark inputs" }],
      }] })]),
      assessment: turn => {
        if (turn.step === 0) return complete(null, [tool("list_files", { path: "/work/materials/benchmark" })]);
        const cited = [...turn.packet.text.matchAll(/#(\d+)/g)].map(m => Number(m[1]));
        return complete(null, [tool("record_results", { results: [{
          id: "R1", status: "inconclusive", method: "blocked", blocker_kind: "missing-material", required_material: "measured alpha score",
          evidence_tool_call_ids: [...new Set([...cited, lastToolCallId(turn)])], evidence_excerpt: "(empty directory or not found)",
          evidence: "The benchmark inputs are not shipped: the inventory and README list only analyze.py, and /work/materials/benchmark is missing.",
        }] })]);
      },
      judge: judge(checkpoints),
    });
    const result = await start();
    expect(modelStages(trace)).toEqual(["extraction", "planning", "assessment", "assessment"]);
    const assessment = trace.find(t => t.stage === "assessment")!;
    expect(assessment.packet.text).toContain("No execution was performed");
    expect(assessment.packet.text).toContain("blocker_kind missing-material, citing read_file of /work/MATERIALS_INDEX.md (#2) and the README (#3)");
    expect(assessment.toolNames).toEqual(expect.arrayContaining(["record_results", "read_tool_result", "read_file", "list_files", "defer_claims"]));
    expect(sb.commands).toEqual([]);
    expect(result.stoppedBy).toBe("model");
    expect(result.counts).toMatchObject({ total: 1, inconclusive: 1 });
    expect(last().controller.experiments[0]).toMatchObject({ id: "X1", method: "blocked", status: "assessed", executionIds: [] });
    expect(last().claims[0]).toMatchObject({ status: "inconclusive", evidenceIds: expect.arrayContaining([2, 3, 5]) });
    expect(result.logbook).toContain("R1 — inconclusive (blocked)");
    expect(result.logbook).not.toContain("System-finalized");
  });

  it("lets the assessor prove a material's absence with read_file of its expected path and record the blocker", async () => {
    const sb = sandbox(command => command === ANALYZE ? ok(analyzeOutput(1)) : undefined, { strictReads: true });
    const { checkpoints, start, last } = prepare();
    const trace = respond({
      extraction: extraction(sentences(1)), planning: rerunPlan(), judge: judge(checkpoints),
      assessment: turn => {
        if (turn.step === 0) return complete(null, [tool("read_file", { path: "/work/materials/results/margins.csv" })]);
        const cited = [...turn.packet.text.matchAll(/#(\d+)/g)].map(m => Number(m[1]));
        return complete(null, [tool("record_results", { results: [{
          id: "R1", status: "inconclusive", method: "blocked", blocker_kind: "missing-material", required_material: "measured alpha score",
          evidence_tool_call_ids: [...new Set([...cited, lastToolCallId(turn)])], evidence_excerpt: "File not found: /work/materials/results/margins.csv",
          evidence: "analyze.py prints no alpha score and the per-task results file it would need is not shipped (not found).",
        }] })]);
      },
    });
    const result = await start();
    expect(modelStages(trace)).toEqual(["extraction", "planning", "assessment", "assessment"]);
    const [first, second] = trace.filter(t => t.stage === "assessment");
    expect(first.packet.text).toContain("citing the inventory/README reads (#2, #3) plus proof of absence: a read_file of the path where the material would live (its 'File not found' line is the excerpt)");
    expect(second.toolMessages[0]).toBe("[Tool call #6]\nFile not found: /work/materials/results/margins.csv (no such file in the sandbox).");
    expect(result.counts).toMatchObject({ total: 1, inconclusive: 1 });
    expect(last().claims[0]).toMatchObject({ status: "inconclusive", evidenceIds: [5, 2, 3, 6] });
    expect(sb.commands).toEqual([{ command: ANALYZE, workdir: undefined }]);
    expect(result.logbook).toContain("R1 — inconclusive (blocked)");
    expect(result.logbook).not.toContain("System-finalized");
  });

  describe("preparation guard (script reads then rewrites a bookkeeping file)", () => {
    // The guard refuses the planned command until the function and its dependency were inspected.
    const GUARDED_SOURCE = [
      "import json", "from pathlib import Path", "",
      "ROOT_DIR = Path(__file__).resolve().parent.parent",
      'HISTORY = (ROOT_DIR / "data" / "confidence_history.json").resolve()',
      'SCORES = {"alpha": 0.50}', "", "",
      "def update_confidence(path):",
      "    history = json.loads(path.read_text())",
      '    history.append({"alpha": SCORES["alpha"]})',
      "    path.write_text(json.dumps(history))", "", "",
      "update_confidence(HISTORY)",
      "for name, score in SCORES.items():",
      '    print(f"{name}_score={score:.2f}")', "",
    ].join("\n");
    const DEPENDENCY = "/work/data/confidence_history.json";
    const REFUSAL = `Refused before execution: preparation check found update_confidence reads then rewrites ${DEPENDENCY}.`;
    const inspected = (script: number, dependency: number, absent = false) =>
      `preparation update_confidence→${DEPENDENCY}: inspected /work/materials/analyze.py (#${script}) and ${DEPENDENCY} (#${dependency}${absent ? ", absent" : ""})`;

    beforeEach(() => setPaper(1, [], GUARDED_SOURCE));

    it("performs the required inspections itself and reruns when the dependency exists, spending no model calls", async () => {
      const sb = sandbox(command => command === ANALYZE ? ok(analyzeOutput(1)) : undefined, { strictReads: true });
      sb.files.set(DEPENDENCY, "[]");
      const { checkpoints, start, last } = prepare();
      const trace = respond({ extraction: extraction(sentences(1)), planning: rerunPlan(), assessment: recordAll, judge: judge(checkpoints) });
      const result = await start();
      expect(modelStages(trace)).toEqual(["extraction", "planning", "assessment"]);
      // The refused launch never reaches the sandbox; only the rerun after the host inspections does.
      expect(sb.commands).toEqual([{ command: ANALYZE, workdir: undefined }]);
      const x = last().controller.experiments[0];
      expect(x).toMatchObject({ status: "assessed", executionIds: [5, 8], evidenceId: 8, repairs: [inspected(6, 7)] });
      expect(last().outputs.filter(o => o.id >= 5 && o.id <= 8).map(o => [o.tool, o.origin, o.error])).toEqual([
        ["run_command", "host-run", false], ["read_file", "host-run", false], ["read_file", "host-run", false], ["run_command", "host-run", false],
      ]);
      expect(result.stoppedBy).toBe("model");
      expect(result.counts).toMatchObject({ total: 1, verified: 1 });
      expect(last().claims[0]).toMatchObject({ status: "verified", evidenceIds: [8] });
    });

    it("hands the bookkeeping judgement to the model and completes the rerun itself after the model initializes the file", async () => {
      const sb = sandbox(command => command === ANALYZE ? ok(analyzeOutput(1)) : undefined, { strictReads: true });
      const { checkpoints, start, last } = prepare();
      const trace = respond({
        extraction: extraction(sentences(1)), planning: rerunPlan(), assessment: recordAll, judge: judge(checkpoints),
        repair: turn => {
          if (turn.step === 0) return complete(null, [tool("write_file", { path: DEPENDENCY, content: "[]" })]);
          // Reruns without re-reading the initialized file: the guard refuses again, then the model gives up in prose.
          if (turn.step === 1) return complete(null, [tool("run_command", { command: ANALYZE })]);
          return undefined;
        },
      });
      const result = await start();
      // write_file; refused rerun; prose ×3 (two nudges are tolerated in repair, the third prose answer ends the stage).
      expect(modelStages(trace)).toEqual(["extraction", "planning", "repair", "repair", "repair", "repair", "repair", "assessment"]);
      const repair = trace.find(t => t.stage === "repair")!;
      expect(repair.packet.text).toContain(`The planned command has NOT run yet: the preparation check refuses it until ${DEPENDENCY}, which update_confidence in /work/materials/analyze.py reads and rewrites, is accounted for.`);
      expect(repair.packet.text).toContain(`The application already inspected: /work/materials/analyze.py (#6), ${DEPENDENCY} (#7: not readable — absent).`);
      expect(repair.packet.text).toContain("Bookkeeping the script maintains itself");
      expect(repair.packet.text).not.toContain("Failing execution");
      expect(trace[4].toolMessages[1]).toMatch(new RegExp(`^\\[Tool call #9\\]\\n${REFUSAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      expect(sb.files.get(DEPENDENCY)).toBe("[]");
      expect(sb.commands).toEqual([{ command: ANALYZE, workdir: undefined }]);
      const x = last().controller.experiments[0];
      expect(x).toMatchObject({ status: "assessed", executionIds: [5, 9, 12], evidenceId: 12, repairs: [inspected(6, 7, true), inspected(10, 11)] });
      expect(last().outputs.filter(o => o.id >= 8 && o.id <= 12).map(o => [o.tool, o.origin])).toEqual([
        ["write_file", "agent-tool"], ["run_command", "agent-tool"], ["read_file", "host-run"], ["read_file", "host-run"], ["run_command", "host-run"],
      ]);
      expect(result.stoppedBy).toBe("model");
      expect(result.counts).toMatchObject({ total: 1, verified: 1 });
      expect(last().claims[0]).toMatchObject({ status: "verified", evidenceIds: [12] });
      expect(result.logbook).not.toContain("System-finalized");
    });

    it("finalizes claims honestly when the command never executes, instead of asking for an impossible command-error blocker", async () => {
      const sb = sandbox(command => command === ANALYZE ? ok(analyzeOutput(1)) : undefined, { strictReads: true });
      const { checkpoints, start, last } = prepare();
      // The repair stage answers in prose only: no initialization, no declared blocker.
      const trace = respond({ extraction: extraction(sentences(1)), planning: rerunPlan(), assessment: recordAll, judge: judge(checkpoints) });
      const result = await start();
      expect(modelStages(trace)).toEqual(["extraction", "planning", "repair", "repair", "repair"]);
      expect(sb.commands).toEqual([]);
      const x = last().controller.experiments[0];
      expect(x).toMatchObject({ status: "assessed", executionIds: [5], repairs: [inspected(6, 7, true), inspected(8, 9, true)], assessment: "planned command never executed; claims finalized by the application" });
      expect(x.evidenceId).toBeUndefined();
      expect(x.failure).toMatch(/^Refused before execution: preparation check found update_confidence/);
      expect(result.stoppedBy).toBe("tool-budget");
      expect(result.counts).toMatchObject({ total: 1, inconclusive: 1 });
      expect(last().claims[0]).toMatchObject({ status: "inconclusive", evidenceIds: [] });
      expect(result.logbook).toContain("System-enforced tool-call budget exhaustion (repair allowance for X1 ended with its planned command never executed: Refused before execution: preparation check found update_confidence");
      expect(result.logbook).toContain("System-finalized at the enforced call allowance (inconclusive, no verdict inferred): R1");
      expect(trace.some(t => t.packet.text.includes("blocker_kind command-error"))).toBe(false);
    });

    it("lets a declared missing-material blocker be recorded against the inventory, README and an absence listing", async () => {
      const sb = sandbox(command => command === ANALYZE ? ok(analyzeOutput(1)) : undefined, { strictReads: true });
      const { checkpoints, start, last } = prepare();
      const trace = respond({
        extraction: extraction(sentences(1)), planning: rerunPlan(), judge: judge(checkpoints),
        repair: () => complete(null, [tool("declare_blocked", {
          blocker_kind: "missing-material",
          explanation: "confidence_history.json carries the per-run confidence measurements that the script appends to and reads back; the shipped materials contain no data directory, so it cannot be reconstructed.",
        })]),
        assessment: turn => {
          if (turn.step === 0) return complete(null, [tool("list_files", { path: "/work/data" })]);
          const grounding = /citing read_file of \S+ \(#(\d+)\) and the README \(#(\d+)\)/.exec(turn.packet.text)!;
          return complete(null, [tool("record_results", { results: [{
            id: "R1", status: "inconclusive", method: "blocked", blocker_kind: "missing-material", required_material: "measured alpha score",
            evidence_tool_call_ids: [Number(grounding[1]), Number(grounding[2]), lastToolCallId(turn)], evidence_excerpt: "(empty directory or not found)",
            evidence: "The confidence history data behind the measured alpha score is not shipped: the inventory and README list no data directory and /work/data is missing.",
          }] })]);
        },
      });
      const result = await start();
      expect(modelStages(trace)).toEqual(["extraction", "planning", "repair", "assessment", "assessment"]);
      const assessment = trace.find(t => t.stage === "assessment")!;
      expect(assessment.packet.text).toContain("No execution was performed: missing-material: confidence_history.json carries");
      expect(assessment.packet.text).toContain("blocker_kind missing-material, citing read_file of /work/MATERIALS_INDEX.md (#2) and the README (#3)");
      expect(assessment.packet.text).not.toContain("blocker_kind command-error");
      expect(sb.commands).toEqual([]);
      expect(result.stoppedBy).toBe("model");
      expect(result.counts).toMatchObject({ total: 1, inconclusive: 1 });
      expect(last().controller.experiments[0]).toMatchObject({ status: "assessed", executionIds: [5], declaredBlocker: expect.stringMatching(/^missing-material: /) });
      expect(last().claims[0]).toMatchObject({ status: "inconclusive", evidenceIds: expect.arrayContaining([2, 3]) });
      expect(result.logbook).not.toContain("System-finalized");
    });
  });

  it("fails honestly when no valid plan is accepted: nothing executes and the checkpoint records the planning failure", async () => {
    const sb = sandbox(command => command === ANALYZE ? ok(analyzeOutput(1)) : undefined);
    const { checkpoints, start, last } = prepare();
    const trace = respond({
      extraction: extraction(sentences(1)),
      planning: turn => turn.step === 0
        ? complete(null, [tool("submit_plan", { experiments: [{ method: "rerun", command: "cd /work/materials && python analyze.py", material_paths: ["/work/materials/analyze.py"], rationale: "Run the analysis.", claims: [{ claim_id: "R1", measurement: "alpha_score" }] }] })])
        : undefined,
      judge: judge(checkpoints),
    });
    await expect(start()).rejects.toThrow(/^Planning failed: no valid experiment plan was accepted within 12 model calls \(last refusal: experiments\[0\]\.command must launch one shipped script/);
    // Refused plan, then prose ×3: planning tolerates two nudges before the stage ends.
    expect(stages(trace)).toEqual(["extraction", "planning", "planning", "planning", "planning"]);
    expect(trace[2].toolMessages[0]).toMatch(/^\[Tool call #4\]\nRefused: experiments\[0\]\.command must launch one shipped script listed in material_paths/);
    expect(sb.commands).toEqual([]);
    expect(sb.terminate).toHaveBeenCalledTimes(1);
    expect(last().controller.phase).toBe("failed");
    expect(last().failure).toMatchObject({ phase: "planning", phaseCalls: 1, aggregateCalls: 2 });
    expect(last().failure?.reason).toMatch(/^Planning failed/);
    expect(last().claims).toEqual([expect.objectContaining({ id: "R1", status: "pending" })]);
  });

  it("runs the qP persona through assessment-gated planning, sealed execution and recording", async () => {
    const QP_ANALYZE = "python materials/analyze.py";
    const sb = sandbox((_command, _opts, argv) => argv.join(" ").endsWith(`-- ${QP_ANALYZE}`) ? ok(analyzeOutput(1)) : undefined);
    const { checkpoints, start, last } = prepare({ agentId: "qP" });
    const trace = respond({
      extraction: extraction(sentences(1)),
      planning: turn => {
        if (turn.step === 0) return complete(null, [tool("read_file", { path: "/work/materials/analyze.py" })]);
        if (turn.step === 1) {
          const inventoryId = Number(/read as #(\d+)\)/.exec(turn.packet.text)?.[1]);
          return complete(null, [tool("assess_suitability", { assessment: JSON.stringify({
            research_question: "Does the shipped analysis reproduce the reported alpha score?",
            question_quote: sentence(0),
            decision: "suitable",
            rationale: "analyze.py prints the alpha score directly from the shipped inputs; no adaptation is needed.",
            claim_ids: ["R1"],
            evidence: [
              { tool_call_id: 1, excerpt: sentence(0) },
              { tool_call_id: inventoryId, excerpt: "Shipped text files for the reproduction:" },
              { tool_call_id: lastToolCallId(turn), excerpt: 'print(f"{name}_score={score:.2f}")' },
            ],
            intended_changes: "None; the shipped code runs unchanged.",
            comparability: "The printed alpha_score is directly comparable with the reported value.",
          }) })]);
        }
        return complete(null, [tool("submit_plan", { experiments: [{ method: "rerun", command: QP_ANALYZE, material_paths: ["/work/materials/analyze.py"], rationale: "analyze.py prints the alpha score.", claims: [{ claim_id: "R1", measurement: "the alpha_score line printed by analyze.py" }] }] })]);
      },
      assessment: recordAll,
      judge: judge(checkpoints),
    });
    const result = await start();
    expect(modelStages(trace)).toEqual(["extraction", "planning", "planning", "planning", "assessment"]);
    expect(trace[1].toolNames).toEqual(expect.arrayContaining(["read_file", "list_files", "assess_suitability", "setup_environment", "submit_plan"]));
    expect(trace[2].toolMessages[0]).toMatch(/^\[Tool call #4\]\nVerified file: \/work\/materials\/analyze\.py/);
    expect(trace[3].toolMessages[1]).toMatch(/Assessment committed: suitable/);
    expect(sb.commands.some(c => c.command.includes("/usr/bin/bwrap") && c.command.endsWith(`-- ${QP_ANALYZE}`))).toBe(true);
    expect(result.stoppedBy).toBe("model");
    expect(result.counts).toMatchObject({ total: 1, verified: 1 });
    const questioning = JSON.parse(String(result.questioningJson));
    expect(questioning).toMatchObject({ persona: "qP", assessment: { decision: "suitable", claim_ids: ["R1"] }, changes: [] });
    expect(questioning.executions).toEqual([expect.objectContaining({ command: QP_ANALYZE, status: "executed", argv: ["python", "materials/analyze.py"] })]);
    expect(questioning.independentAssessment).toBe("Independent judge: every verdict follows the cited captured output.");
    expect(last().controller).toMatchObject({ phase: "complete", hostCommands: 1 });
    expect(last().controller.experiments[0]).toMatchObject({ method: "rerun", status: "assessed", command: QP_ANALYZE });
  });
});
