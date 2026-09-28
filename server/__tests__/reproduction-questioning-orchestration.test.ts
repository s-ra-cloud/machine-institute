import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ complete: vi.fn(), create: vi.fn(), context: vi.fn(), materials: vi.fn() }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create: mock.complete } }; } }));
vi.mock("../storage", () => ({ storage: {} }));
vi.mock("../ethics-review", () => ({ loadPaperContext: mock.context }));
vi.mock("../fs-materials", () => ({
  fetchContributionMaterials: mock.materials,
  materialSandboxPath: (f: { name: string }) => `/work/materials/${f.name}`,
  formatMaterialsInventory: () => "The analysis requires data.csv; shipped analyze.py is available.",
}));
vi.mock("../modal-sandbox", () => ({ isModalConfigured: () => true, ReproductionSandbox: { create: mock.create } }));
vi.mock("../provider-credit-preflight", () => ({ assertReproductionRuntimeProviderCredits: vi.fn(async () => {}) }));
import { runReproduction } from "../reproduce";
import { getReproducerPrompt, getJudgePrompt } from "../prompts/reproduce";
const paper = "The paper asks whether averaging recovers the mean. The measured score is 0.91. The analysis requires data.csv for this quantitative result.";
const inventory = "The analysis requires data.csv; shipped analyze.py is available.";
const source = "print('measured score = 0.91')";
const logbook = "## Claims\nScore is 0.91.\n## Reproduction Log\nEvidence is in the tool trace.\n## Discrepancies\nAdapted outputs are separate.\n## Limitations\nLimited to shipped materials.";
const complete = (content: string | null, tool_calls?: unknown[]) => ({ choices: [{ finish_reason: tool_calls ? "tool_calls" : "stop", message: { content, ...(tool_calls ? { tool_calls } : {}) } }] });
const tool = (name: string, args: Record<string, unknown>) => ({ id: Math.random().toString(), type: "function", function: { name, arguments: JSON.stringify(args) } });
const config = { providerMode: "platform" as const, provider: "openai", modelName: "openai/gpt-4o" };
const options = () => ({
  agentId: "qP" as const, reproductionId: "q", projectId: "p", journalId: "j", initiativeDocId: "i", initiativeSlug: "i", journalDisplayName: "Journal", documentId: "paper",
  reproducerPrompt: getReproducerPrompt("qP"), judgePrompt: getJudgePrompt("qP"), modelConfig: config, judgeModelConfig: config, gpu: "T4" as const, emitEvent: vi.fn(async () => {}),
});
function sandbox() {
  const files = new Map<string, string>();
  return { sandboxId: "q-sandbox", image: "test", writeText: vi.fn(async (p: string, t: string) => { files.set(p, t); }),
    readText: vi.fn(async (p: string) => p === "/work/qp-dependencies.json" ? JSON.stringify(["/opt/conda", "/usr", "/work/python-packages"].map(root => ({ root, sha256: "mocked-sha256" }))) : files.get(p) ?? ""), listFiles: vi.fn(async () => []),
    exec: vi.fn(async () => ({ stdout: "measured score = 0.91", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 })),
    terminate: vi.fn(async () => {}) };
}
beforeEach(() => {
  vi.clearAllMocks(); mock.complete.mockReset();
  vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_API_KEY", "test");
  vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", "https://managed.example.test");
  vi.stubEnv("LAB_ALLOWED_MODELS", "openai/gpt-4o");
  mock.context.mockResolvedValue({ title: "Mean estimation", authors: "Authors", date: "2026", abstract: "Mean estimation", url: "https://example.test", fullText: paper, fsAbstracts: [] });
  mock.materials.mockResolvedValue({ files: [{ name: "analyze.py", source: "additional", kind: "text", text: source }], paperMarkdown: paper, textFileCount: 1, binaryFileCount: 0 });
});
describe("qP mocked end-to-end orchestration", () => {
  for (const scenario of ["suitable", "adapt", "blocked", "indefensible", "judge-unavailable"] as const) it(`${scenario}: gates execution, retains provenance, judges independently and composes report`, async () => {
    const decision = scenario === "indefensible" ? "blocked" : scenario === "judge-unavailable" ? "suitable" : scenario;
    const sb = sandbox(); mock.create.mockResolvedValue(sb);
    // Deliberate bypass attempts before inspection must never reach sandbox.exec.
    mock.complete.mockResolvedValueOnce(complete(null, [
      tool("run_command", { command: "echo BYPASS; python scientific.py" }),
      tool("write_file", { path: "/work/working/materials/analyze.py", content: "BYPASS" }),
      tool("read_file", { path: "/work/paper.md" }),
      tool("read_file", { path: "/work/MATERIALS_INDEX.md" }),
      tool("read_file", { path: "/work/materials/analyze.py" }),
      tool("record_result", { id: "R1", claim: "The measured score is 0.91.", status: "pending", source_quote: paper, source_tool_call_id: 3, source_location: `characters 0-${paper.length}`, original_value: "0.91" }),
    ]));
    // Premature completion must recover the authoritative assessment phase.
    if (decision === "suitable") mock.complete.mockResolvedValueOnce(complete(logbook));
    mock.complete.mockResolvedValueOnce(complete(null, [tool("assess_suitability", { assessment: JSON.stringify({
      research_question: "Whether averaging recovers the mean", question_quote: "The paper asks whether averaging recovers the mean.", decision,
      rationale: scenario === "indefensible" ? "The observational sample cannot identify the causal objective; no defensible adaptation preserves the question." : decision === "adapt" ? "Unequal sample inclusion requires a weighted mean." : "The inspected materials define the available analysis.",
      claim_ids: ["R1"], evidence: [{ tool_call_id: 3, excerpt: paper }, { tool_call_id: 4, excerpt: inventory }, { tool_call_id: 5, excerpt: source }],
      intended_changes: decision === "adapt" ? "Weight the observations" : "No changes",
      comparability: decision === "adapt" ? "Changed estimator is not directly comparable." : "Original materials only.",
      planned_changes: [{ path: "/work/working/materials/analyze.py", reason: "Weight unequal inclusion probabilities", claim_ids: ["R1"] }],
    }) })]));
    let evidenceId = 8;
    if (decision === "adapt") {
      mock.complete.mockResolvedValueOnce(complete(null, [
        tool("write_file", { path: "/work/materials/analyze.py", content: "BYPASS", reason: "Should not overwrite protected source" }),
        tool("write_file", { path: "/work/working/materials/unplanned.py", content: "BYPASS", reason: "Should not permit an unplanned file" }),
        tool("run_command", { command: "echo UNAPPLIED_ADAPTATION" }),
        tool("write_file", { path: "/work/working/materials/analyze.py", content: `${source}\n# weighted estimator`, reason: "Weight unequal inclusion probabilities" }),
      ]));
      evidenceId = 12;
    }
    if (decision !== "blocked") mock.complete.mockResolvedValueOnce(complete(null, [tool("run_command", { command: "python materials/analyze.py" })]));
    else {
      mock.complete.mockResolvedValueOnce(complete(null, [tool("run_command", { command: "echo BLOCKED_BYPASS" }), tool("list_files", { path: "/work/data.csv" })]));
    }
    if (scenario !== "indefensible") mock.complete.mockResolvedValueOnce(complete(null, [tool("record_result", decision === "blocked" ? {
      id: "R1", status: "inconclusive", method: "blocked", blocker_kind: "missing-material", required_material: "data.csv",
      evidence_tool_call_ids: [4, 9], evidence_excerpt: "(empty directory or not found in the uploaded/versioned source inventory)", evidence: "data.csv is required but missing from the shipped inventory",
    } : { id: "R1", status: "verified", method: "rerun", reproduced_value: "0.91", evidence_tool_call_ids: [evidenceId], evidence_excerpt: "measured score = 0.91", evidence: "measured score = 0.91" })]));
    mock.complete.mockResolvedValueOnce(complete(logbook));
    if (scenario === "judge-unavailable") mock.complete.mockRejectedValueOnce(new Error("judge unavailable"));
    else mock.complete.mockResolvedValueOnce(complete(JSON.stringify({ summary: "Independent assessment: weighting addresses sampling bias, but changed estimator is not directly comparable.", results: [{ id: "R1", claim: "The measured score is 0.91.", verdict: "verified", evidence: "measured score = 0.91" }] })));
    const result = await runReproduction(options());
    const q = JSON.parse(result.questioningJson!);
    expect(mock.create.mock.calls[0][0]).toMatchObject({ questioning: true });
    expect(mock.create.mock.calls[0][0]).not.toHaveProperty("env");
    expect(q.assessment.decision).toBe(decision);
    expect(sb.exec.mock.calls.some(c => JSON.stringify(c).includes("BYPASS"))).toBe(false);
    expect(sb.exec.mock.calls.some(c => JSON.stringify(c).includes("UNAPPLIED_ADAPTATION"))).toBe(false);
    expect(q.blobs[q.originals["/work/materials/analyze.py"]]).toBe(source);
    expect(result.title).toContain("qP");
    expect(result.markdown).toContain("Independent assessment of adapted analysis");
    expect(result.abstract).toContain("Adapted analysis is distinct");
    expect(result.results[0].verdict).toBe(decision === "suitable" && scenario !== "judge-unavailable" ? "verified" : "inconclusive");
    if (decision === "adapt") {
      expect(q.changes).toHaveLength(1);
      expect(q.blobs[q.executions[0].files["/work/qp-executions/run-1/materials/analyze.py"]]).toContain("weighted estimator");
      const commands = sb.exec.mock.calls as unknown as Array<[string[], unknown]>;
      expect(commands.some(c => c[0][0] === "/usr/bin/env" && c[0].includes("-i") && c[0].includes("--unshare-all"))).toBe(true);
      expect(q.dependencyManifest).toHaveLength(3);
      expect(q.executions[0].dependencyHashes).toHaveLength(3);
      expect(q.independentAssessment).toContain("Independent assessment");
    }
    if (decision === "blocked") expect(q.executions).toHaveLength(0);
    if (scenario === "indefensible") expect(result.results[0].evidence).toContain("comparability");
    if (scenario === "judge-unavailable") expect(q.independentAssessment).toContain("Independent judge unavailable");
    expect(sb.terminate).toHaveBeenCalledOnce();
  });
  it("fails closed when the sandbox cannot protect originals", async () => {
    const sb = sandbox();
    sb.exec.mockResolvedValue({ stdout: "", stderr: "namespace isolation missing", exitCode: 1, timedOut: false, durationMs: 1 });
    mock.create.mockResolvedValue(sb);
    await expect(runReproduction(options())).rejects.toThrow("protection unavailable");
    expect(mock.complete).not.toHaveBeenCalled();
    expect(sb.terminate).toHaveBeenCalledOnce();
  });
  it("rejects an oversized provenance corpus honestly before sandbox provisioning", async () => {
    mock.materials.mockResolvedValue({ files: [{ name: "oversized.py", source: "additional", kind: "text", text: "x".repeat(30 * 1024 * 1024) }],
      paperMarkdown: paper, textFileCount: 1, binaryFileCount: 0 });
    await expect(runReproduction(options())).rejects.toThrow("qP provenance capacity reached");
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.complete).not.toHaveBeenCalled();
  });
  it("allows only argument-validated binary setup during assessment", async () => {
    const sb = sandbox(); mock.create.mockResolvedValue(sb);
    mock.complete.mockResolvedValueOnce(complete(null, [
      tool("setup_environment", { packages: ["numpy; python scientific.py"] }),
      tool("setup_environment", { packages: ["numpy"] }),
      tool("run_command", { command: "python scientific.py" }),
      tool("read_file", { path: "/proc/1/environ" }),
    ]));
    mock.complete.mockRejectedValueOnce(new Error("test stop after inspection"));
    await expect(runReproduction(options())).rejects.toThrow("LLM request failed");
    const commands = JSON.stringify(sb.exec.mock.calls);
    expect(commands).toContain("--only-binary=:all:");
    expect(commands).toContain("numpy==2.2.6");
    expect(commands).not.toContain("scientific.py");
    expect(sb.readText).not.toHaveBeenCalledWith("/proc/1/environ");
    expect(sb.terminate).toHaveBeenCalledOnce();
  });
});