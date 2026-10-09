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
import { ReproductionSession } from "../reproduction-session";
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
      tool("run_command", { command: scenario === "display-only" ? "cat /work/materials/results.csv" : scenario.startsWith("qp-") ? "python materials/analyze.py" : "python /work/materials/analyze.py",
        ...(packet.executionEvidence?.some((e: any) => e.successful && e.command === "python /work/materials/analyze.py")
          ? { repeat_reason: "Independent replicate for this fixture's next claim." } : {}),
        ...(scenario === "working-directory" ? { working_directory: "/work/materials" } : {}) }),
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
  it("reads a late material function by query through the website entrypoint and completes judging", async () => {
    const prefix = "# unrelated initialization\n".repeat(2000);
    mock.materials.mockResolvedValue({ paperMarkdown: paper, files: [{
      name: "analyze.py", kind: "text", source: "additional",
      text: prefix + "def measure():\n    print('measured_score=0.91')\nmeasure()\n",
    }], textFileCount: 1, binaryFileCount: 0 });
    mock.create.mockResolvedValue(sandbox());
    const responder = stageResponder();
    let sawTargetedPage = false, requestedPage = false;
    mock.complete.mockImplementation(async (request: any) => {
      sawTargetedPage ||= request.messages.some((m: any) => m.role === "tool"
        && String(m.content).includes(`Returned characters: ${prefix.length}-`)
        && String(m.content).includes("def measure():"));
      if (!requestedPage && request.tools?.some((t: any) => t.function.name === "submit_plan")) {
        requestedPage = true;
        return complete(null, [tool("read_file", { path: "/work/materials/analyze.py", query: "def measure", max_chars: 500 })]);
      }
      const reply = await responder(request);
      for (const call of reply.choices[0].message.tool_calls ?? []) {
        if (call.function.name !== "read_file") continue;
        const args = JSON.parse(call.function.arguments);
        if (args.path === "/work/materials/analyze.py")
          call.function.arguments = JSON.stringify({ ...args, query: "def measure", max_chars: 500 });
      }
      return reply;
    });
    const result = await runReproduction(options());
    expect(sawTargetedPage).toBe(true);
    expect(result.results[0].verdict).toBe("verified");
  });
  it("blocks a mkdir-only repair, then allows a restored file to be inspected before a successful retry", async () => {
    const sb = sandbox();
    let experiments = 0, step = 0, sawRefusal = false;
    sb.exec.mockImplementation(async (...args: any[]) => {
      const experiment = JSON.stringify(args).includes("python /work/materials/analyze.py");
      const failed = experiment && ++experiments === 1;
      return { exitCode: failed ? 1 : 0, stdout: failed ? "" : "measured_score=0.91",
        stderr: failed ? "FileNotFoundError: [Errno 2] No such file or directory: '/work/data/history.json'" : "",
        timedOut: false, durationMs: 1 };
    });
    mock.create.mockResolvedValue(sb);
    const responder = stageResponder();
    mock.complete.mockImplementation(async (request: any) => {
      if (request.tools?.some((t: any) => t.function.name === "submit_for_assessment")) {
        sawRefusal ||= request.messages.some((m: any) => String(m.content).includes("mkdir alone does not restore a file"));
        const run = tool("run_command", { command: "python /work/materials/analyze.py" });
        if (step++ === 0) return complete(null, [run]);
        if (step === 2) return complete(null, [tool("run_command", { command: "mkdir -p /work/data" }), run]);
        if (step === 3) return complete(null, [
          tool("write_file", { path: "/work/data/history.json", content: "{}" }),
          tool("read_file", { path: "/work/data/history.json" }),
        ]);
        return complete(null, [run, tool("submit_for_assessment", {})]);
      }
      return responder(request);
    });
    const result = await runReproduction(options());
    expect(sawRefusal).toBe(true);
    expect(experiments).toBe(2);
    expect(result.results[0].verdict).toBe("verified");
  });
  it("rejects unknown reuse evidence before accepting a plan, then completes normally", async () => {
    mock.create.mockResolvedValue(sandbox());
    const responder = stageResponder();
    let attempted = false, refused = false;
    mock.complete.mockImplementation(async (request: any) => {
      const reply = await responder(request);
      if (request.tools?.some((t: any) => t.function.name === "submit_plan")) {
        refused ||= request.messages.some((m: any) => String(m.content).includes("reuse requires an original successful"));
        const call = reply.choices[0].message.tool_calls?.find((t: any) => t.function.name === "submit_plan");
        if (call && !attempted) {
          attempted = true;
          call.function.arguments = JSON.stringify({ ...JSON.parse(call.function.arguments), reuse_evidence_tool_call_id: 999 });
        }
      }
      return reply;
    });
    const result = await runReproduction(options());
    expect(refused).toBe(true);
    expect(result.results[0].verdict).toBe("verified");
  });
  it("rejects a different material script before sandbox dispatch and recovers with the accepted plan", async () => {
    const sb = sandbox();
    mock.create.mockResolvedValue(sb);
    const responder = stageResponder();
    let attempted = false, sawRefusal = false;
    mock.complete.mockImplementation(async (request: any) => {
      if (request.tools?.some((t: any) => t.function.name === "submit_for_assessment")) {
        sawRefusal ||= request.messages.some((m: any) => String(m.content).includes("not a source entrypoint in the accepted rerun plan"));
        if (!attempted) {
          attempted = true;
          return complete(null, [tool("run_command", { command: "python /work/materials/unplanned.py" })]);
        }
      }
      return responder(request);
    });
    const result = await runReproduction(options());
    expect(attempted).toBe(true);
    expect(sawRefusal).toBe(true);
    expect(sb.exec.mock.calls.some(call => JSON.stringify(call).includes("unplanned.py"))).toBe(false);
    expect(sb.exec.mock.calls.some(call => JSON.stringify(call).includes("python /work/materials/analyze.py"))).toBe(true);
    expect(result.results[0].verdict).toBe("verified");
  });
  it("repairs a compound measurement formatting rejection with an explicit, validated exact copy", async () => {
    const excerpt = "measured_score=0.91\ncontrol_score=0.80";
    const sb = sandbox();
    sb.exec.mockResolvedValue({ exitCode: 0, stdout: excerpt, stderr: "", timedOut: false, durationMs: 1 });
    mock.create.mockResolvedValue(sb);
    const responder = stageResponder();
    const record = vi.spyOn(ReproductionSession.prototype, "recordResult");
    let attempts = 0, sawRepair = false;
    mock.complete.mockImplementation(async (request: any) => {
      const reply = await responder(request);
      if (request.tools?.some((t: any) => t.function.name === "record_result")) {
        sawRepair ||= request.messages.some((m: any) => String(m.content).includes("set copy_excerpt_to_reproduced_value=true"));
        const call = reply.choices[0].message.tool_calls![0] as any;
        const args = JSON.parse(call.function.arguments);
        args.evidence_excerpt = excerpt;
        if (attempts++ === 0) args.reproduced_value = "score: 0.910 (rounded)";
        else {
          delete args.reproduced_value;
          args.copy_excerpt_to_reproduced_value = true;
        }
        call.function.arguments = JSON.stringify(args);
      }
      return reply;
    });
    const result = await runReproduction(options());
    expect(sawRepair).toBe(true);
    expect(attempts).toBe(2);
    expect(record.mock.calls.some(([args]) => args.reproduced_value === excerpt)).toBe(true);
    expect(result.results[0].verdict).toBe("verified");
    record.mockRestore();
  });
  it.each(["missing", "blank", "oversized"])("repairs an invalid explicit-copy excerpt without inferring evidence: %s", async failure => {
    mock.create.mockResolvedValue(sandbox());
    const responder = stageResponder();
    let attempts = 0, sawRefusal = false;
    const record = vi.spyOn(ReproductionSession.prototype, "recordResult");
    mock.complete.mockImplementation(async (request: any) => {
      const reply = await responder(request);
      const schema = request.tools?.find((t: any) => t.function.name === "record_result")?.function.parameters;
      if (schema) {
        expect(schema.required).toContain("evidence_excerpt");
        expect(schema.properties.evidence_excerpt).toMatchObject({ minLength: 1, maxLength: 6000 });
        sawRefusal ||= request.messages.some((m: any) => String(m.content).includes(
          failure === "oversized" ? "6001 characters; maximum is 6000"
            : failure === "missing" ? "evidence_excerpt is required" : "missing, blank, or not a string"));
        const call = reply.choices[0].message.tool_calls![0] as any;
        const args = JSON.parse(call.function.arguments);
        delete args.reproduced_value;
        args.copy_excerpt_to_reproduced_value = true;
        if (attempts++ === 0) {
          if (failure === "missing") delete args.evidence_excerpt;
          else args.evidence_excerpt = failure === "blank" ? "  " : "x".repeat(6001);
        }
        call.function.arguments = JSON.stringify(args);
      }
      return reply;
    });
    const result = await runReproduction(options());
    expect(attempts).toBe(2);
    expect(sawRefusal).toBe(true);
    const copied = record.mock.calls.filter(([args]) => args.copy_excerpt_to_reproduced_value === true);
    expect(copied).toHaveLength(1);
    expect(copied[0][0].reproduced_value).toBe(copied[0][0].evidence_excerpt);
    expect(result.results[0].verdict).toBe("verified");
    record.mockRestore();
  });
  it.each(["invented", "conflicting"])("exact-copy requests cannot bypass evidence checks: %s", async failure => {
    mock.create.mockResolvedValue(sandbox());
    const responder = stageResponder();
    let attempted = false, sawRefusal = false;
    const record = vi.spyOn(ReproductionSession.prototype, "recordResult");
    mock.complete.mockImplementation(async (request: any) => {
      const reply = await responder(request);
      if (request.tools?.some((t: any) => t.function.name === "record_result")) {
        sawRefusal ||= request.messages.some((m: any) => String(m.content).includes(
          failure === "invented" ? "evidence_excerpt must be copied exactly" : "Conflicting measurement text"));
        if (!attempted) {
          attempted = true;
          const call = reply.choices[0].message.tool_calls![0] as any;
          const args = JSON.parse(call.function.arguments);
          args.copy_excerpt_to_reproduced_value = true;
          if (failure === "invented") { delete args.reproduced_value; args.evidence_excerpt = "invented_score=0.999"; }
          call.function.arguments = JSON.stringify(args);
        }
      }
      return reply;
    });
    await runReproduction(options());
    expect(sawRefusal).toBe(true);
    expect(record.mock.calls.some(([args]) => args.copy_excerpt_to_reproduced_value === true)).toBe(false);
    record.mockRestore();
  });
  it("repairs an ungrounded raw-data plan before execution and preserves input provenance through reporting", async () => {
    const path = "/work/materials/rows.csv", csv = "value\n0.90\n0.92\n";
    mock.materials.mockResolvedValue({ paperMarkdown: paper, files: [
      { name: "rows.csv", kind: "text", source: "additional", text: csv },
    ], textFileCount: 1, binaryFileCount: 0 });
    const sb = sandbox();
    sb.exec.mockImplementation(async (command: any) => ({
      exitCode: 0, stdout: JSON.stringify(command).includes("csv.DictReader")
        ? `${path}\nmeasured_score=0.91` : csv, stderr: "", timedOut: false, durationMs: 1,
    }));
    mock.create.mockResolvedValue(sb);
    let attempted = false, sawRefusal = false;
    const base = stageResponder();
    mock.complete.mockImplementation(async (request: any) => {
      const packetMessage = request.messages.find((m: any) => m.role === "user" && String(m.content).startsWith('{"stage":'));
      if (!packetMessage) return base(request);
      const packet = JSON.parse(packetMessage.content);
      if (packet.stage === "planning") {
        const plan = { claimId: packet.claim.id, method: "raw-data-rederived", materialPaths: [path],
          measurement: "Mean of the two raw observations", rationale: "Compute from observations, not a supplied summary." };
        if (!attempted) { attempted = true; return complete(null, [tool("submit_plan", plan)]); }
        sawRefusal ||= request.messages.some((m: any) => String(m.content).includes("Raw-data re-derivation requires"));
        const read = request.messages.find((m: any) => m.role === "tool" && String(m.content).includes(csv.trim()));
        if (!read) return complete(null, [tool("read_file", { path })]);
        const id = Number(String(read.content).match(/Tool call #(\d+)/)?.[1]);
        return complete(null, [tool("submit_plan", { ...plan, rawInputs: [{ path, readToolCallId: id }] })]);
      }
      if (packet.stage === "execution") return complete(null, [
        tool("run_command", { command: `python -c "import csv; p='${path}'; rows=list(csv.DictReader(open(p))); print(p); print('measured_score='+str(sum(float(r['value']) for r in rows)/len(rows)))"` }),
        tool("submit_for_assessment", {}),
      ]);
      const input = packet.plan.rawInputs[0];
      expect(packet.materialReads).toContainEqual(input);
      const evidence = packet.executionEvidence.find((e: any) => e.successful);
      return complete(null, [tool("record_result", { id: packet.claim.id, status: "verified",
        method: "raw-data-rederived", reproduced_value: "0.91", evidence_excerpt: "measured_score=0.91",
        evidence: "Mean recomputed from shipped observations.", evidence_tool_call_ids: [evidence.id],
        raw_input_path: input.path, raw_input_tool_call_id: input.readToolCallId,
      })]);
    });
    const saved: PipelineCheckpoint[] = [];
    const result = await runReproduction({ ...options(), onCheckpoint: async value => { saved.push(structuredClone(value)); } });
    expect(sawRefusal).toBe(true);
    expect(result.results[0].verdict).toBe("verified");
    expect(saved.at(-1)?.controller.phase).toBe("complete");
    expect(sb.terminate).toHaveBeenCalledOnce();
  });
  it.each(["suitable", "adapt"])("refuses grouping that expands immutable qP authorization: %s", async decision => {
    mock.create.mockResolvedValue(sandbox());
    const responder = stageResponder(`qp-${decision}`);
    let attempted = false, sawRefusal = false;
    mock.complete.mockImplementation(async (request: any) => {
      sawRefusal ||= request.messages.some((m: any) => String(m.content).includes("sharing a qP experiment requires"));
      const response = await responder(request);
      for (const call of response.choices[0].message.tool_calls ?? []) {
        const t = call as any;
        if (t.function.name === "submit_plan" && !attempted) {
          attempted = true;
          t.function.arguments = JSON.stringify({ ...JSON.parse(t.function.arguments),
            relatedClaims: [{ claimId: "R999", measurement: "Unauthorized adapted claim" }] });
        }
      }
      return response;
    });
    const saved: PipelineCheckpoint[] = [];
    await runReproduction({ ...options(), agentId: "qP",
      reproducerPrompt: getReproducerPrompt("qP"), judgePrompt: getJudgePrompt("qP"),
      onCheckpoint: async value => { saved.push(structuredClone(value)); } });
    expect(attempted && sawRefusal).toBe(true);
    expect(saved.at(-1)?.controller.phase).toBe("complete");
    expect(saved.at(-1)?.controller.sharedExperiments.every(g => !g.claimIds.includes("R999"))).toBe(true);
  });
  it("carries a failed-run method revision into planning and completes without repeating the superseded plan", async () => {
    const sb = sandbox();
    sb.exec.mockImplementation(async (command: unknown) => ({
      exitCode: JSON.stringify(command).includes("/materials/analyze.py") ? 137 : 0,
      stdout: JSON.stringify(command).includes("/materials/analyze.py") ? "Full experiment stopped" : "measured_score=0.91",
      stderr: "", timedOut: false, durationMs: 1,
    }));
    mock.create.mockResolvedValue(sb);
    const responder = stageResponder();
    let mismatched = false, triedOldPlan = false, judgeCalls = 0;
    const reason = "Full rerun exited 137; perform a smaller toy experiment, not an original-result verification.";
    mock.complete.mockImplementation(async (request: any) => {
      const names = (request.tools ?? []).map((t: any) => t.function.name);
      const message = request.messages.find((m: any) => m.role === "user" && String(m.content).startsWith('{"stage":'));
      const packet = message ? JSON.parse(message.content) : undefined;
      if (names.includes("submit_plan") && packet.revision) {
        expect(packet.revision).toMatchObject({ reason, method: "toy", previousPlan: { method: "rerun" } });
        const method = triedOldPlan ? "toy" : "rerun";
        if (triedOldPlan) expect(request.messages.some((m: any) => String(m.content).includes("this revision requested method=toy"))).toBe(true);
        triedOldPlan = true;
        return complete(null, [tool("submit_plan", { claimId: "R1", method,
          materialPaths: ["/work/materials/analyze.py"], measurement: "toy held-out score", rationale: reason })]);
      }
      if (names.includes("submit_for_assessment") && packet.plan.method === "toy") {
        return complete(null, [
          tool("write_file", { path: "/work/results/toy.py", content: "print('measured_score=0.91')" }),
          tool("run_command", { command: "python /work/results/toy.py" }),
          tool("submit_for_assessment", {}),
        ]);
      }
      if (names.includes("record_result") && packet.plan.method === "rerun") {
        if (!mismatched) {
          mismatched = true;
          return complete(null, [tool("record_result", { id: "R1", status: "toy", method: "toy" })]);
        }
        return complete(null, [tool("request_plan_revision", { reason, method: "toy" })]);
      }
      if (names.includes("record_result")) {
        const evidence = packet.executionEvidence.find((e: any) => e.command === "python /work/results/toy.py");
        return complete(null, [tool("record_result", { id: "R1", status: "toy", method: "toy",
          reproduced_value: "0.91", evidence: "Toy output only; original experiment failed.",
          evidence_excerpt: "measured_score=0.91", evidence_tool_call_ids: [evidence.id] })]);
      }
      if (!names.length && /judge/i.test(String(request.messages[0]?.content))) {
        judgeCalls++;
        return complete(JSON.stringify({ summary: "Only a toy experiment completed.", results: [{
          id: "R1", claim: paper, verdict: "toy", original_value: "0.91", reproduced_value: "0.91",
          evidence: "Toy output only; original experiment failed.",
        }] }));
      }
      return responder(request);
    });
    const saved: PipelineCheckpoint[] = [];
    const result = await runReproduction({ ...options(), onCheckpoint: async value => { saved.push(structuredClone(value)); } });
    expect(triedOldPlan).toBe(true);
    expect(judgeCalls).toBe(1);
    expect(result.results[0].verdict).toBe("toy");
    expect(saved.at(-1)?.controller.phase).toBe("complete");
    expect(saved.at(-1)?.revisions).toHaveLength(1);
    expect(sb.exec.mock.calls.filter(c => JSON.stringify(c).includes("/materials/analyze.py"))).toHaveLength(1);
    expect(sb.terminate).toHaveBeenCalledOnce();
  });
  it.each(["individual", "shared", "reuse"])("completes a mixed-outcome report through independent judging; planning=%s", async mode => {
    const shared = mode === "shared", reuse = mode === "reuse";
    const claims = Array.from({ length: shared ? 12 : 5 }, (_, i) => ({
      claim: `The measured score for condition ${i + 1} on the held-out evaluation is 0.91.`,
      source_quote: `The measured score for condition ${i + 1} on the held-out evaluation is 0.91.`,
      original_value: "0.91",
    }));
    const observed = (i: number) => i % 2 ? "0.90" : "0.91";
    const output = claims.map((_, i) => `condition_${i + 1}=${observed(i)}`).join("\n");
    const body = shared ? [0, 5, 10].map(start => claims.slice(start, start + 5).map(c => c.claim).join("\n").padEnd(5400, " ")).join("")
      : claims.map(c => c.claim).join("\n");
    mock.context.mockResolvedValue({ title: "Multi-claim fixture", authors: "Fixture", date: "2026", abstract: body, fullText: body, fsAbstracts: [] });
    mock.materials.mockResolvedValue({ paperMarkdown: body, files: [{
      name: "analyze.py", kind: "text", source: "additional", text: `print(${JSON.stringify(output)})`,
    }], textFileCount: 1, binaryFileCount: 0 });
    const sb = sandbox();
    sb.exec.mockResolvedValue({ exitCode: 0, stdout: output, stderr: "", timedOut: false, durationMs: 1 });
    mock.create.mockResolvedValue(sb);
    const plannedReads = new Set<string>(), evidenceReads = new Set<string>(), duplicateAttempts = new Set<string>();
    let executed = false, judgeCalls = 0, extractionPacket = 0;
    mock.complete.mockImplementation(async (request: any) => {
      const names = (request.tools ?? []).map((t: any) => t.function.name);
      if (names.includes("submit_claims")) return complete(null, [tool("submit_claims", {
        claims: claims.slice(extractionPacket * 5, ++extractionPacket * 5),
      })]);
      const message = request.messages.find((m: any) => m.role === "user" && String(m.content).startsWith('{"stage":'));
      const packet = message ? JSON.parse(message.content) : undefined;
      if (names.includes("submit_plan")) {
        if (!plannedReads.has(packet.claim.id)) {
          plannedReads.add(packet.claim.id);
          return complete(null, [tool("read_file", { path: "/work/materials/analyze.py" })]);
        }
        return complete(null, [tool("submit_plan", {
          claimId: packet.claim.id, method: "rerun", materialPaths: ["/work/materials/analyze.py"],
          ...(reuse && executed ? { reuse_evidence_tool_call_id: packet.executionEvidence.find((e: any) => e.successful && e.command === "python /work/materials/analyze.py").id } : {}),
          ...(shared ? { relatedClaims: packet.pendingClaims.filter((c: any) => c.id !== packet.claim.id)
            .map((c: any) => ({ claimId: c.id, measurement: c.claim })) } : {}),
          measurement: packet.claim.claim, rationale: "The shipped script computes all five condition scores; reuse captured execution when available.",
        })]);
      }
      if (names.includes("submit_for_assessment")) {
        if (!executed) {
          executed = true;
          return complete(null, [tool("run_command", { command: "python /work/materials/analyze.py" }), tool("submit_for_assessment", {})]);
        }
        if (shared) {
          expect(packet.experimentMeasurements).toHaveLength(12);
          expect(request.messages.some((m: any) => String(m.content).includes("Account for every grouped claim"))).toBe(true);
          const output = request.messages.find((m: any) => m.role === "tool" && String(m.content).includes("exit code 0") && String(m.content).includes("condition_1=0.91"));
          const id = Number(String(output.content).match(/Tool call #(\d+)/)?.[1]);
          const handoff = request.tools.find((t: any) => t.function.name === "submit_for_assessment").function;
          expect(handoff.parameters.properties.measurements.items.properties).not.toHaveProperty("evidence_excerpt");
          return complete(null, [tool("submit_for_assessment", { measurements: packet.experimentMeasurements.map((c: any) => ({
            claimId: c.claimId, evidence_tool_call_id: id,
          })) })]);
        }
        expect(packet.executionEvidence.some((e: any) => e.successful)).toBe(true);
        if (!duplicateAttempts.has(packet.claim.id)) {
          duplicateAttempts.add(packet.claim.id);
          return complete(null, [tool("run_command", { command: "python /work/materials/analyze.py" })]);
        }
        expect(request.messages.some((m: any) => String(m.content).includes("Refused duplicate execution"))).toBe(true);
        return complete(null, [tool("submit_for_assessment", {})]);
      }
      if (names.includes("record_result")) {
        if (reuse && packet.claim.id !== "R1") expect(packet.measurementHandoff?.reused).toBe(true);
        if (shared) expect(packet.measurementHandoff?.claimId).toBe(packet.claim.id);
        const evidence = packet.executionEvidence.find((e: any) => e.successful && e.command === "python /work/materials/analyze.py");
        expect(evidence).toBeDefined();
        if (!evidenceReads.has(packet.claim.id)) {
          evidenceReads.add(packet.claim.id);
          return complete(null, [tool("read_tool_result", evidence.retrieveTail)]);
        }
        const i = Number(packet.claim.id.slice(1)) - 1;
        return complete(null, [tool("record_result", {
          id: packet.claim.id, status: i % 2 ? "falsified" : "verified", method: "rerun",
          reproduced_value: observed(i), evidence_excerpt: `condition_${i + 1}=${observed(i)}`,
          evidence_tool_call_ids: [evidence.id], evidence: "The original successful source execution contains this condition's measured score.",
        })]);
      }
      if (!names.length && /judge/i.test(String(request.messages[0]?.content))) {
        judgeCalls++;
        return complete(JSON.stringify({ summary: "Offline fixture: three matching and two discrepant measurements.", results: claims.map((c, i) => ({
          id: `R${i + 1}`, claim: c.claim, verdict: i % 2 ? "falsified" : "verified",
          original_value: "0.91", reproduced_value: observed(i), evidence: `condition_${i + 1}=${observed(i)}`,
        })) }));
      }
      return complete("");
    });
    const saved: PipelineCheckpoint[] = [];
    const result = await runReproduction({ ...options(), onCheckpoint: async value => { saved.push(structuredClone(value)); } });
    expect(judgeCalls).toBe(1);
    expect(duplicateAttempts.size).toBe(shared || reuse ? 0 : 4);
    expect(result.results.map(r => r.verdict)).toEqual(claims.map((_, i) => i % 2 ? "falsified" : "verified"));
    expect(plannedReads.size).toBe(shared ? 1 : 5);
    expect(saved.at(-1)?.controller.milestones.filter(m => m.phase === "execution")).toHaveLength(shared ? 1 : 5);
    expect(saved.at(-1)?.controller.phase).toBe("complete");
    expect(saved.at(-1)?.controller.calls).toBeLessThan(100);
    expect(saved.at(-1)?.claims.every(c => c.status !== "pending")).toBe(true);
    expect(sb.exec.mock.calls.filter(call => JSON.stringify(call).includes("python /work/materials/analyze.py"))).toHaveLength(1);
    expect(sb.terminate).toHaveBeenCalledOnce();
  });
  it("excludes immutable source fields from assessment and rejects an attempted rewrite before dispatch", async () => {
    mock.create.mockResolvedValue(sandbox());
    const record = vi.spyOn(ReproductionSession.prototype, "recordResult");
    const responder = stageResponder();
    let attempted = false;
    mock.complete.mockImplementation(async (request: any) => {
      const recording = request.tools?.find((t: any) => t.function.name === "record_result");
      const reply = await responder(request);
      if (recording) {
        const schema = recording.function.parameters;
        expect(schema.additionalProperties).toBe(false);
        for (const field of ["claim", "original_value", "source_quote", "source_location", "source_tool_call_id"])
          expect(schema.properties).not.toHaveProperty(field);
        expect(schema.properties.status.enum).not.toContain("pending");
        if (!attempted) {
          attempted = true;
          const call = reply.choices[0].message.tool_calls![0] as any;
          call.function.arguments = JSON.stringify({
            ...JSON.parse(call.function.arguments), original_value: "0.99", claim: "A rewritten claim",
          });
        }
      }
      return reply;
    });
    try {
      await runReproduction(options());
      expect(attempted).toBe(true);
      expect(record.mock.calls.some(([args]) => args.original_value === "0.99" || args.claim === "A rewritten claim")).toBe(false);
      expect(record.mock.calls.some(([args]) => args.status === "verified" && args.method === "rerun")).toBe(true);
    } finally {
      record.mockRestore();
    }
  });
  it("requires an explicit assessment method and recovers from an omitted method", async () => {
    mock.create.mockResolvedValue(sandbox());
    const responder = stageResponder();
    let omitted = false;
    mock.complete.mockImplementation(async (request: any) => {
      const recording = request.tools?.find((t: any) => t.function.name === "record_result");
      const reply = await responder(request);
      if (recording) {
        expect(recording.function.parameters.required).toContain("method");
        expect(recording.function.description).toContain("never relabel");
        if (!omitted) {
          omitted = true;
          const call = reply.choices[0].message.tool_calls![0] as any;
          const args = JSON.parse(call.function.arguments);
          delete args.method;
          call.function.arguments = JSON.stringify(args);
        }
      }
      return reply;
    });
    await runReproduction(options());
    expect(omitted).toBe(true);
    expect(mock.complete.mock.calls.some(([request]) =>
      request.messages.some((message: any) => message.role === "tool"
        && String(message.content).includes("method")
        && String(message.content).includes("Resubmit this tool")))).toBe(true);
  });
  it("runs a standalone script with an explicit material working directory", async () => {
    const sb = sandbox();
    mock.create.mockResolvedValue(sb);
    mock.complete.mockImplementation(stageResponder("working-directory"));
    await runReproduction(options());
    expect(sb.exec).toHaveBeenCalledWith(
      ["bash", "-lc", "python /work/materials/analyze.py"],
      expect.objectContaining({ workdir: "/work/materials" }),
    );
  });
  it("rejects a piped planned experiment before dispatch and allows a corrected direct rerun", async () => {
    const sb = sandbox();
    mock.create.mockResolvedValue(sb);
    const responder = stageResponder("working-directory");
    let attempted = false;
    mock.complete.mockImplementation((request: any) => {
      if (!attempted && request.tools?.some((t: any) => t.function.name === "submit_for_assessment")) {
        attempted = true;
        return complete(null, [tool("run_command", {
          command: "cd /work/materials && python analyze.py 2>&1 | tee /work/results/run.log",
        })]);
      }
      return responder(request);
    });
    await runReproduction(options());
    expect(attempted).toBe(true);
    expect(sb.exec.mock.calls.some(call => JSON.stringify(call).includes("tee "))).toBe(false);
    expect(sb.exec).toHaveBeenCalledWith(
      ["bash", "-lc", "python /work/materials/analyze.py"],
      expect.objectContaining({ workdir: "/work/materials" }),
    );
  });
  it("retains the session archive callback across stage-specific context overrides", async () => {
    mock.create.mockResolvedValue(sandbox());
    const archive = vi.spyOn(ReproductionSession.prototype, "archiveContext");
    const responder = stageResponder();
    let injected = false;
    mock.complete.mockImplementation((request: any) => {
      if (!injected && request.tools?.some((t: any) => t.function.name === "submit_plan")) {
        injected = true;
        return complete("ARCHIVE_THIS_GENERATED_HISTORY ".repeat(25000), [
          tool("read_file", { path: "/work/materials/analyze.py" }),
        ]);
      }
      return responder(request);
    });
    try {
      await runReproduction(options());
      expect(archive.mock.calls.some(([, text]) => text.startsWith("ARCHIVE_THIS_GENERATED_HISTORY"))).toBe(true);
    } finally {
      archive.mockRestore();
    }
  });
  it("reserves assessment capacity for an evidence-backed decision or plan revision", async () => {
    mock.create.mockResolvedValue(sandbox());
    const responder = stageResponder();
    let reads = 0;
    let restricted = false;
    mock.complete.mockImplementation((request: any) => {
      const names = request.tools?.map((t: any) => t.function.name) ?? [];
      if (names.includes("record_result")) {
        const schema = request.tools.find((t: any) => t.function.name === "record_result").function.parameters;
        expect(schema.properties.required_material.type).toBe("string");
        expect(schema.properties.source_quote).toBeUndefined();
        expect(schema.additionalProperties).toBe(false);
        if (reads++ < 4) return complete(null, [tool("read_tool_result", {})]);
        expect(names.sort()).toEqual(["record_result", "request_plan_revision"]);
        expect(request.tool_choice).toBe("auto");
        restricted = true;
      }
      return responder(request);
    });
    const result = await runReproduction(options());
    expect(restricted).toBe(true);
    expect(result.results[0].verdict).toBe("verified");
  });
  for (const changed of [false, true]) it(`compares command output before resetting execution progress (changed=${changed})`, async () => {
    const sb = sandbox();
    if (changed) {
      let sequence = 0;
      sb.exec.mockImplementation(async () => ({
        stdout: `distinct measurement ${++sequence}`, stderr: "", exitCode: 0, timedOut: false, durationMs: 1,
      }));
    }
    mock.create.mockResolvedValue(sb);
    const responder = stageResponder();
    let commands = 0;
    let checked = false;
    mock.complete.mockImplementation((request: any) => {
      const names = request.tools?.map((t: any) => t.function.name) ?? [];
      if (names.includes("submit_for_assessment")) {
        if (commands++ < 3) return complete(null, [tool("run_command", { command: "grep score /work/materials/analyze.py" })]);
        expect(request.tool_choice).toEqual(changed ? "auto" : {
          type: "function", function: { name: "submit_for_assessment" },
        });
        checked = true;
        throw new Error("Test intentionally stops before scientific assessment.");
      }
      return responder(request);
    });
    await expect(runReproduction(options())).rejects.toThrow();
    expect(checked).toBe(true);
  });
  it("keeps the immutable execution handoff compact and original evidence retrievable", async () => {
    const sb = sandbox(); mock.create.mockResolvedValue(sb);
    const responder = stageResponder();
    let reads = 0;
    let checked = false;
    mock.complete.mockImplementation((request: any) => {
      const names = request.tools?.map((t: any) => t.function.name) ?? [];
      if (names.includes("submit_plan") && reads++ < 5)
        return complete(null, [tool("read_file", { path: "/work/materials/analyze.py" })]);
      if (names.includes("submit_for_assessment")) {
        const packet = request.messages.map((m: any) => {
          try { return JSON.parse(m.content); } catch { return null; }
        }).find((m: any) => m?.stage === "execution");
        expect(packet.claim.claim).toBe(paper);
        expect(packet.plan.claimId).toBe("R1");
        expect(packet.evidence.length).toBeLessThanOrEqual(3);
        for (const item of packet.evidence) {
          expect(item.excerpt.length).toBeLessThanOrEqual(400);
          expect(item.retrieve).toBe(`read_tool_result tool_call_id=${item.id}`);
        }
        checked = true;
      }
      return responder(request);
    });
    await runReproduction(options());
    expect(checked).toBe(true);
  });
  it("closes repeated execution browsing without forcing commands or a verdict", async () => {
    mock.create.mockResolvedValue(sandbox());
    const responder = stageResponder();
    let reads = 0;
    let restricted = false;
    mock.complete.mockImplementation((request: any) => {
      const names = request.tools?.map((t: any) => t.function.name) ?? [];
      if (names.includes("submit_for_assessment")) {
        if (reads++ < 6) return complete(null, [tool("list_files", { path: "/work/materials" })]);
        restricted = true;
        expect(names).not.toContain("list_files");
        expect(names).not.toContain("read_tool_result");
        expect(names).toContain("write_file");
        expect(names).toContain("run_command");
        expect(request.tool_choice).toBe("auto");
        expect(JSON.stringify(request.messages)).not.toContain("Repeated inspection");
      }
      return responder(request);
    });
    const result = await runReproduction(options());
    expect(restricted).toBe(true);
    expect(result.results[0].verdict).toBe("verified");
  });
  it("reserves the last planning calls for a model-authored plan after eight reads", async () => {
    mock.create.mockResolvedValue(sandbox());
    const responder = stageResponder();
    let reads = 0;
    let forced = false;
    mock.complete.mockImplementation((request: any) => {
      if (request.tools?.some((t: any) => t.function.name === "submit_plan")) {
        if (reads++ < 8) {
          expect(request.tool_choice).toBe("auto");
          return complete(null, [tool("read_file", { path: "/work/materials/analyze.py" })]);
        }
        expect(request.tool_choice).toEqual({ type: "function", function: { name: "submit_plan" } });
        forced = true;
      }
      return responder(request);
    });
    const result = await runReproduction(options());
    expect(forced).toBe(true);
    expect(result.results[0].verdict).toBe("verified");
  });
  for (const scenario of ["qp-suitable", "qp-adapt", "qp-blocked"]) it(`${scenario} repairs planning without bypassing suitability`, async () => {
    const sb = sandbox(); mock.create.mockResolvedValue(sb);
    const responder = stageResponder(scenario);
    let reads = 0;
    mock.complete.mockImplementation((request: any) => {
      const names = (request.tools ?? []).map((t: any) => t.function.name);
      if (names.includes("submit_plan") && reads < 8) {
        reads++;
        expect(names).not.toContain("run_command");
        return complete(null, [tool("read_file", { path: "/work/materials/analyze.py" })]);
      }
      if (names.includes("submit_plan")) {
        expect(JSON.stringify(request.messages)).toContain("PLANNING REPAIR");
        expect(["assess_suitability", "submit_plan"]).toContain(request.tool_choice.function.name);
      }
      return responder(request);
    });
    const result = await runReproduction({ ...options(), agentId: "qP",
      reproducerPrompt: getReproducerPrompt("qP"), judgePrompt: getJudgePrompt("qP") });
    expect(JSON.parse(result.questioningJson!).assessment.decision).toBe(scenario.slice(3));
    expect(result.results[0].verdict).toBe(scenario === "qp-suitable" ? "verified" : "inconclusive");
  });
  it("repairs README/list/archive loops with twelve claims before executing inspected code", async () => {
    const claims = Array.from({ length: 12 }, (_, i) => `The measured experimental score for condition ${i} is 0.91.`);
    const text = [0, 5, 10].map(start => claims.slice(start, start + 5).join("\n").padEnd(5400, " ")).join("");
    mock.materials.mockResolvedValue({ paperMarkdown: text, files: [
      { name: "README.md", kind: "text", source: "additional", text: "Use analyze.py for the held-out measurement.\n".repeat(150) },
      { name: "analyze.py", kind: "text", source: "additional", text: "# held-out measurement\n".repeat(900) + "print('measured_score=0.91')" },
    ], textFileCount: 2, binaryFileCount: 0 });
    const sb = sandbox(); mock.create.mockResolvedValue(sb);
    const responder = stageResponder();
    let orientation = 0;
    let repaired = false;
    let scriptRead = false;
    let extractionPacket = 0;
    const saved: PipelineCheckpoint[] = [];
    mock.complete.mockImplementation(async (request: any) => {
      const names = (request.tools ?? []).map((t: any) => t.function.name);
      if (names.includes("submit_claims")) return complete(null, [tool("submit_claims", {
        claims: claims.slice(extractionPacket * 5, ++extractionPacket * 5).map(claim => ({ claim, source_quote: claim, original_value: "0.91" })),
      })]);
      if (names.includes("submit_plan") && !scriptRead) {
        const context = JSON.stringify(request.messages);
        if (context.includes("PLANNING REPAIR")) {
          repaired = true;
          expect(context).toContain("stage calls");
          expect(context).toContain("inspected");
          expect(names).not.toContain("run_command");
          expect(names).not.toContain("record_result");
          scriptRead = true;
          return complete(null, [tool("read_file", { path: "/work/materials/analyze.py", offset: 0 })]);
        }
        orientation++;
        if (orientation === 2) return complete(null, [
          tool("read_tool_result", { tool_call_id: 13 }), tool("read_tool_result", { tool_call_id: 14 }),
        ]);
        return complete(null, [tool("read_file", { path: "/work/materials/README.md" }),
          tool("list_files", { path: "/work/materials" })]);
      }
      return responder(request);
    });
    await runReproduction({ ...options(), onCheckpoint: async value => { saved.push(structuredClone(value)); } });
    expect(repaired).toBe(true);
    expect(saved.at(-1)?.planningRecovery?.[0]).toMatchObject({ firstStallCall: 6, outcome: "plan-accepted" });
    expect(saved.at(-1)?.claims).toHaveLength(12);
    expect(saved.at(-1)?.claims.every(c => c.status === "verified")).toBe(true);
    expect(sb.exec.mock.calls.filter(c => JSON.stringify(c).includes("analyze.py"))).toHaveLength(12);
  });
  it("attempted fifteen claims proceed with only twelve registered and no cap overflow checkpoint", async () => {
    const sentences = Array.from({ length: 15 }, (_, i) => `The measured experimental score for condition ${i} is 0.91.`);
    const longPaper = [0, 5, 10].map(start => sentences.slice(start, start + 5).join("\n").padEnd(5400, " ")).join("");
    mock.materials.mockResolvedValue({ paperMarkdown: longPaper, files: [{ name: "analyze.py", kind: "text", source: "additional", text: "print('measured_score=0.91')" }], textFileCount: 1, binaryFileCount: 0 });
    const sb = sandbox(); mock.create.mockResolvedValue(sb);
    const responder = stageResponder();
    let packet = 0;
    mock.complete.mockImplementation((request: any) => {
      if ((request.tools ?? []).some((t: any) => t.function.name === "submit_claims")) {
        const selected = sentences.slice(packet * 5, ++packet * 5);
        return complete(null, [tool("submit_claims", { claims: selected.map(claim => ({ claim, source_quote: claim, original_value: "0.91" })) })]);
      }
      return responder(request);
    });
    const saved: PipelineCheckpoint[] = [];
    const result = await runReproduction({ ...options(), onCheckpoint: async value => { saved.push(structuredClone(value)); } });
    expect(packet).toBe(3);
    expect(saved.every(s => s.claims.length <= 12)).toBe(true);
    expect(saved.at(-1)?.claims).toHaveLength(12);
    expect(saved.at(-1)?.claims.every(c => c.status === "verified")).toBe(true);
    expect(result.markdown).toContain("claim-limit");
    expect(sb.exec.mock.calls.filter(c => JSON.stringify(c).includes("analyze.py"))).toHaveLength(12);
  });
  for (const failure of ["provider", "checkpoint"]) it(`${failure} after accepted claims remains a hard failure without GPU`, async () => {
    const longPaper = paper.padEnd(5400, " ") + "An additional measured result was 0.82.".padEnd(5400, " ");
    mock.materials.mockResolvedValue({ paperMarkdown: longPaper, files: [], textFileCount: 0, binaryFileCount: 0 });
    const responder = stageResponder();
    mock.complete.mockImplementation((request: any) => {
      if (!String(request.messages[1]?.content).includes(paper)) throw new Error("Provider unavailable");
      return responder(request);
    });
    const saved: PipelineCheckpoint[] = [];
    await expect(runReproduction({ ...options(), onCheckpoint: async value => {
      saved.push(structuredClone(value));
      if (failure === "checkpoint") throw new Error("Storage unavailable");
    } })).rejects.toThrow(failure === "provider" ? "LLM request failed" : "Storage unavailable");
    expect(mock.create).not.toHaveBeenCalled();
    expect(saved.at(-1)?.claims[0].status).toBe("pending");
    expect(saved.at(-1)?.logbook).not.toContain("still in progress");
    expect(saved.at(-1)?.controller.phase).toBe("failed");
  });
  for (const agentId of ["P", "qP"] as const) it(`${agentId}: later extraction refusals preserve early claims through execution`, async () => {
    const longPaper = paper.padEnd(5400, " ") + "A later measured experimental result was 0.82.".padEnd(5400, " ");
    mock.materials.mockResolvedValue({ paperMarkdown: longPaper, files: [{ name: "analyze.py", kind: "text", source: "additional", text: "print('measured_score=0.91')" }], textFileCount: 1, binaryFileCount: 0 });
    const sb = sandbox(); mock.create.mockResolvedValue(sb);
    const responder = stageResponder(agentId === "qP" ? "qp-suitable" : "success");
    mock.complete.mockImplementation((request: any) => {
      if ((request.tools ?? []).some((t: any) => t.function.name === "submit_claims")
        && !String(request.messages[1]?.content).includes(paper)) {
        const quote = "A later measured experimental result was 0.82.";
        return complete(null, [tool("submit_claims", { claims: [{ claim: quote, source_quote: quote, required_material: "invented" }] })]);
      }
      return responder(request);
    });
    const checkpoints: PipelineCheckpoint[] = [];
    const result = await runReproduction({ ...options(), agentId, reproducerPrompt: getReproducerPrompt(agentId),
      judgePrompt: getJudgePrompt(agentId), onCheckpoint: async value => { checkpoints.push(structuredClone(value)); } });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].verdict).toBe("verified");
    expect(result.markdown).toMatch(/^> Bounded extraction coverage/m);
    expect(result.logbook).toContain("validation-exhausted");
    expect(checkpoints.at(-1)?.extraction?.packets.some(p => p.status === "validation-exhausted")).toBe(true);
    expect(sb.exec.mock.calls.some(c => JSON.stringify(c).includes("analyze.py"))).toBe(true);
  });
  it("persists terminal extraction failure without stale in-progress wording", async () => {
    mock.complete.mockImplementation(stageResponder("bad-quote"));
    const saved: PipelineCheckpoint[] = [];
    await expect(runReproduction({ ...options(), onCheckpoint: async value => { saved.push(structuredClone(value)); } })).rejects.toThrow("Extraction failed");
    expect(saved.at(-1)?.controller.phase).toBe("failed");
    expect(saved.at(-1)?.logbook).toContain("no-claims");
    expect(saved.at(-1)?.logbook).not.toContain("still in progress");
    expect(mock.create).not.toHaveBeenCalled();
  });
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
    if (scenario === "planning-loop") {
      expect(saved.at(-1)?.failure).toMatchObject({ phase: "planning", phaseCalls: 12, aggregateCalls: 13 });
      expect(saved.at(-1)?.logbook).toContain("local planning allowance exhausted, not global budget");
      expect(saved.at(-1)?.planningRecovery?.[0].outcome).toBe("unresolved");
      expect(sb.exec.mock.calls.filter(c => JSON.stringify(c).includes("analyze.py"))).toHaveLength(0);
    }
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