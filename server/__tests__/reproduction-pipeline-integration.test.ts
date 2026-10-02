import { beforeEach, describe, it, expect, vi } from "vitest";
const mock = vi.hoisted(() => ({ complete: vi.fn(), create: vi.fn(), context: vi.fn(), materials: vi.fn() }));
vi.mock("openai", () => ({ default: class { chat = { completions: { create: mock.complete } }; } }));
vi.mock("../managed-adapter", () => ({
  createManagedChatClient: () => ({ chat: { completions: { create: mock.complete } } }),
  createByocChatClient: () => ({ chat: { completions: { create: mock.complete } } }),
}));
vi.mock("../storage", () => ({ storage: {} }));
vi.mock("../ethics-review", () => ({ loadPaperContext: mock.context }));
vi.mock("../fs-materials", () => ({
  fetchContributionMaterials: mock.materials,
  materialSandboxPath: (f: { name: string }) => `/work/materials/${f.name}`,
  formatMaterialsInventory: () => "Shipped analyze.py computes the experimental measurement.",
}));
vi.mock("../modal-sandbox", () => ({ isModalConfigured: () => true, ReproductionSandbox: { create: mock.create } }));
vi.mock("../provider-credit-preflight", () => ({ assertReproductionRuntimeProviderCredits: vi.fn(async () => {}) }));
import { runReproduction } from "../reproduce";
import { getReproducerPrompt, getJudgePrompt } from "../prompts/reproduce";
import { getReproductionFailureDiagnostics } from "../reproduction-diagnostics";
import type { PipelineCheckpoint } from "../reproduction-pipeline";
const paper = "The measured score on the held-out evaluation is 0.91.";
const config = { providerMode: "platform" as const, provider: "openai", modelName: "openai/gpt-4o" };
const complete = (content: string | null, tool_calls?: unknown[]) => ({
  choices: [{ finish_reason: tool_calls ? "tool_calls" : "stop", message: { content, ...(tool_calls ? { tool_calls } : {}) } }],
});
let serial = 0;
const tool = (name: string, args: Record<string, unknown>) => ({ id: `native-${++serial}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const options = () => ({
  reproductionId: "pipeline", projectId: "project", journalId: "mirror", initiativeDocId: "initiative",
  initiativeSlug: "initiative", journalDisplayName: "Journal", documentId: "paper",
  reproducerPrompt: getReproducerPrompt(), judgePrompt: getJudgePrompt(), modelConfig: config, judgeModelConfig: config,
  gpu: "T4" as const, emitEvent: vi.fn(async () => {}),
});
function sandbox() {
  const files = new Map<string, string>();
  return {
    sandboxId: "offline-sandbox",
    writeText: vi.fn(async (path: string, content: string) => { files.set(path, content); }),
    readText: vi.fn(async (path: string) => path === "/work/qp-dependencies.json"
      ? JSON.stringify(["/opt/conda", "/usr", "/work/python-packages"].map(root => ({ root, sha256: "mocked-sha256" }))) : files.get(path) ?? ""),
    listFiles: vi.fn(async () => ["analyze.py"]),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "measured_score=0.91", stderr: "", timedOut: false, durationMs: 1 })),
    terminate: vi.fn(async () => {}),
  };
}
/** Responds to application stage/contracts, never a prescribed global turn number. */
function stageResponder(scenario = "success") {
  return async (request: any) => {
    const names = (request.tools ?? []).map((t: any) => t.function.name);
    if (names.includes("submit_claims")) {
      expect(mock.create).not.toHaveBeenCalled();
      if (scenario === "dsml") return complete("<invoke name='run_command'>untrusted text</invoke>");
      if (scenario === "no-claims") return complete(null, [tool("submit_claims", { claims: [] })]);
      return complete(null, [tool("submit_claims", { claims: [{
        claim: paper, source_quote: scenario === "bad-quote" ? "A quotation that never occurs in the supplied paper." : paper,
        original_value: "0.91",
      }] })]);
    }
    const packetMessage = request.messages.find((m: any) => m.role === "user" && String(m.content).startsWith('{"stage":'));
    const packet = packetMessage ? JSON.parse(packetMessage.content) : undefined;
    if (names.includes("submit_plan")) {
      if (scenario === "planning-loop") return complete(null, [tool("read_file", { path: "/work/materials/analyze.py" })]);
      if (scenario.startsWith("qp-")) {
        const outputs = request.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content));
        const inventory = outputs.find((t: string) => t.includes("Verified file: /work/MATERIALS_INDEX.md"));
        const script = outputs.find((t: string) => t.includes("Verified file: /work/materials/analyze.py"));
        if (!inventory || !script) return complete(null, [
          tool("read_file", { path: "/work/MATERIALS_INDEX.md" }), tool("read_file", { path: "/work/materials/analyze.py" }),
        ]);
        const decision = scenario.slice(3);
        if (!outputs.some((t: string) => t.includes("Assessment committed"))) return complete(null, [
          tool("assess_suitability", { assessment: JSON.stringify({
            research_question: paper, question_quote: paper, decision, rationale: "Evaluate the supplied code against the original reported metric.",
            claim_ids: ["R1"], evidence: [
              { tool_call_id: 1, excerpt: paper },
              { tool_call_id: Number(inventory.match(/Tool call #(\d+)/)[1]), excerpt: "Shipped analyze.py computes the experimental measurement." },
              { tool_call_id: Number(script.match(/Tool call #(\d+)/)[1]), excerpt: "print('measured_score=0.91')" },
            ], intended_changes: decision === "adapt" ? "Change the estimator for a separately assessed analysis." : "No changes.",
            comparability: "Adapted results are separate from original-result verification.",
            ...(decision === "adapt" ? { planned_changes: [{ path: "/work/working/materials/analyze.py",
              reason: "Apply a scientifically justified estimator adjustment.", claim_ids: ["R1"] }] } : {}),
          }) }),
        ]);
      }
      return complete(null, [tool("submit_plan", { claimId: packet.claim.id, method: scenario === "qp-blocked" ? "blocked" : "rerun",
        materialPaths: ["/work/materials/analyze.py"], measurement: "held-out score", rationale: "Run the supplied evaluation." })]);
    }
    if (names.includes("submit_for_assessment")) return complete(null, [
      ...(packet.adaptationContract?.decision === "adapt"
        ? packet.adaptationContract.planned_changes.map((change: any) => tool("write_file", {
          path: change.path, content: `# ${packet.adaptationContract.intended_changes}\nprint('measured_score=0.91')`, reason: change.reason,
        })) : []),
      tool("run_command", { command: scenario === "display-only" ? "cat /work/materials/results.csv" : scenario.startsWith("qp-") ? "python materials/analyze.py" : "python /work/materials/analyze.py" }),
      ...(scenario === "mixed-evidence" ? [tool("run_command", { command: "cat /work/materials/results.csv" })] : []),
      ...(scenario === "analysis-chain" ? [
        tool("read_tool_result", {}),
        tool("read_file", { path: "/work/predictions.csv" }),
        tool("run_command", { command: "python /work/materials/analyze.py --compute" }),
      ] : []),
      tool("submit_for_assessment", {}),
      // A malicious late same-batch command must never dispatch after transition.
      tool("run_command", { command: "DO_NOT_EXECUTE" }),
    ]);
    if (names.includes("record_result")) {
      const evidence = packet.evidence.filter((e: any) => e.tool === "run_command").at(-1);
      return complete(null, [tool("record_result", { id: scenario === "wrong-claim" ? "R999" : packet.claim.id,
        status: "verified", method: "rerun", evidence: "Supplied analysis output.",
        evidence_excerpt: "measured_score=0.91", reproduced_value: "0.91",
        evidence_tool_call_ids: scenario === "mixed-evidence" ? packet.evidence.filter((e: any) => e.tool === "run_command").map((e: any) => e.id) : [evidence.id] })]);
    }
    if (!names.length && /judge/i.test(String(request.messages[0]?.content))) {
      if (scenario === "judge-unavailable") throw new Error("Simulated judge unavailable");
      return complete(JSON.stringify({ summary: "Independent fixture assessment.", results: [{
        id: "R1", claim: paper, verdict: "verified", original_value: "0.91", reproduced_value: "0.91", evidence: "measured_score=0.91",
      }] }));
    }
    return complete(""); // Empty final prose must not create or erase evidence.
  };
}
beforeEach(() => {
  vi.clearAllMocks(); serial = 0;
  mock.context.mockResolvedValue({ title: "Offline fixture", authors: "Fixture", date: "2026", abstract: paper, fullText: paper, fsAbstracts: [] });
  mock.materials.mockResolvedValue({ paperMarkdown: paper, files: [{ name: "analyze.py", kind: "text", source: "additional", text: "print('measured_score=0.91')" }], textFileCount: 1, binaryFileCount: 0 });
});
describe("default reproduction stage-controller integration (offline only)", () => {
  for (const scriptExit of [0, 1]) it(`rejects mixed CSV measurement evidence even with script exit ${scriptExit}`, async () => {
    const sb = sandbox();
    sb.exec.mockImplementation(async (...args: any[]) => {
      const command = JSON.stringify(args);
      return { exitCode: command.includes("analyze.py") ? scriptExit : 0,
        stdout: command.includes("analyze.py") ? "No measurement produced by this entrypoint." : "measured_score=0.91",
        stderr: "", timedOut: false, durationMs: 1 };
    });
    mock.create.mockResolvedValue(sb); mock.complete.mockImplementation(stageResponder("mixed-evidence"));
    const checkpoints: PipelineCheckpoint[] = [];
    await expect(runReproduction({ ...options(), onCheckpoint: async value => { checkpoints.push(structuredClone(value)); } })).rejects.toThrow("Pipeline assessment failed");
    expect(checkpoints.at(-1)?.claims[0].status).toBe("pending");
    expect(sb.exec.mock.calls.filter(c => JSON.stringify(c).includes("analyze.py"))).toHaveLength(1);
  });
  it("qP execution recovers arbitrary authorized changes exclusively from the stage packet", async () => {
    const sb = sandbox(); mock.create.mockResolvedValue(sb);
    const responder = stageResponder("qp-adapt");
    let committed: any;
    let executionContract: any;
    mock.complete.mockImplementation(async (request: any) => {
      const names = (request.tools ?? []).map((t: any) => t.function.name);
      if (names.includes("submit_for_assessment")) {
        const packet = JSON.parse(request.messages.find((m: any) => m.role === "user" && String(m.content).startsWith('{"stage":')).content);
        executionContract = packet.adaptationContract;
        expect(executionContract).toEqual(committed);
        expect(request.messages.some((m: any) => m.role === "tool")).toBe(false);
      }
      const response = await responder(request);
      for (const call of response.choices[0].message.tool_calls ?? []) {
        const native = call as any;
        if (native.function.name === "assess_suitability") {
          const args = JSON.parse(native.function.arguments);
          committed = JSON.parse(args.assessment);
          const uniqueName = `new_estimator_${serial}.py`;
          committed.intended_changes = `Implement a centered weighted estimator in ${uniqueName}, preserving held-out partitions.`;
          committed.planned_changes.push({ path: `/work/working/materials/${uniqueName}`,
            reason: `Center features before weighting in ${uniqueName}.`, claim_ids: ["R1"] });
          native.function.arguments = JSON.stringify({ assessment: JSON.stringify(committed) });
        }
      }
      return response;
    });
    const result = await runReproduction({ ...options(), agentId: "qP", reproducerPrompt: getReproducerPrompt("qP"), judgePrompt: getJudgePrompt("qP") });
    expect(executionContract).toEqual(committed);
    const changes = JSON.parse(result.questioningJson!).changes;
    expect(changes.map((c: any) => c.path)).toEqual(committed.planned_changes.map((c: any) => c.path));
    expect(result.results[0].verdict).toBe("inconclusive");
  });
  for (const scenario of ["qp-suitable", "qp-adapt", "qp-blocked"]) it(`${scenario}: retains qP gates and separates adapted verdicts`, async () => {
    const sb = sandbox(); mock.create.mockResolvedValue(sb); mock.complete.mockImplementation(stageResponder(scenario));
    const result = await runReproduction({ ...options(), agentId: "qP", reproducerPrompt: getReproducerPrompt("qP"), judgePrompt: getJudgePrompt("qP") });
    const provenance = JSON.parse(result.questioningJson!);
    expect(provenance.assessment.decision).toBe(scenario.slice(3));
    expect(result.results[0].verdict).toBe(scenario === "qp-suitable" ? "verified" : "inconclusive");
    expect(mock.create.mock.calls[0][0]).not.toHaveProperty("env");
    expect(sb.exec.mock.calls.some(c => JSON.stringify(c).includes("DO_NOT_EXECUTE"))).toBe(false);
    expect(provenance.executions).toHaveLength(scenario === "qp-blocked" ? 0 : 1);
    expect(sb.terminate).toHaveBeenCalledOnce();
  });
  for (const scenario of ["success", "judge-unavailable", "analysis-chain"]) it(`${scenario}: extraction precedes GPU, stages gate actions and report from state`, async () => {
    const sb = sandbox(); mock.create.mockResolvedValue(sb); mock.complete.mockImplementation(stageResponder(scenario));
    const saved: PipelineCheckpoint[] = [];
    const result = await runReproduction({ ...options(), onCheckpoint: async value => { saved.push(structuredClone(value)); } });
    expect(result.logbook).toContain("## Claims");
    expect(result.logbook).toContain(paper);
    expect(result.results[0].verdict).toBe(scenario === "judge-unavailable" ? "inconclusive" : "verified");
    expect(saved.some(s => s.controller.commandCompletionUnknown)).toBe(true);
    expect(saved.at(-1)?.controller.commandCompletionUnknown).toBe(false);
    expect(sb.exec.mock.calls.some(c => JSON.stringify(c).includes("DO_NOT_EXECUTE"))).toBe(false);
    expect(sb.exec.mock.calls.filter(c => JSON.stringify(c).includes("analyze.py"))).toHaveLength(scenario === "analysis-chain" ? 2 : 1);
    expect(sb.terminate).toHaveBeenCalledOnce();
  });
  for (const scenario of ["dsml", "no-claims", "bad-quote"]) it(`${scenario}: extraction fails without GPU or execution`, async () => {
    mock.complete.mockImplementation(stageResponder(scenario));
    const error = await runReproduction(options()).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(getReproductionFailureDiagnostics(error)?.stage).toBe("extraction");
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.complete.mock.calls.length).toBeLessThanOrEqual(5);
  });
  for (const scenario of ["planning-loop", "wrong-claim", "display-only"]) it(`${scenario}: bounded failure retains checkpoint without inventing a result`, async () => {
    const sb = sandbox(); mock.create.mockResolvedValue(sb); mock.complete.mockImplementation(stageResponder(scenario));
    const saved: PipelineCheckpoint[] = [];
    await expect(runReproduction({ ...options(), onCheckpoint: async value => { saved.push(structuredClone(value)); } })).rejects.toThrow("Pipeline");
    expect(saved.at(-1)?.controller.phase).toBe("failed");
    expect(saved.at(-1)?.claims[0].status).toBe("pending");
    expect(saved.at(-1)?.logbook).toContain("## Limitations");
    expect(sb.terminate).toHaveBeenCalledOnce();
  });
  it("does not dispatch a command when its pre-dispatch checkpoint cannot be saved", async () => {
    const sb = sandbox(); mock.create.mockResolvedValue(sb); mock.complete.mockImplementation(stageResponder());
    await expect(runReproduction({ ...options(), onCheckpoint: async value => {
      if (value.controller.commandCompletionUnknown) throw new Error("Storage unavailable");
    } })).rejects.toThrow();
    expect(sb.exec.mock.calls.filter(c => JSON.stringify(c).includes("analyze.py"))).toHaveLength(0);
    expect(sb.terminate).toHaveBeenCalledOnce();
  });
  it("requires explicit spending approval even for simulated-tool compatibility checks", async () => {
    const { runCompatibilityProbe } = await import("../reproduction-compatibility");
    await expect(runCompatibilityProbe({ config, repetitions: 3, approveModelCharges: false })).rejects.toThrow("approval");
    expect(mock.complete).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
  });
});