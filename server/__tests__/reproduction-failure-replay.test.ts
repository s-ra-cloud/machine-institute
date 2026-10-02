import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Replay the deliberately small serving window that originally exposed this
// recovery failure, independently of the newly selected managed model's size.
vi.mock("../../shared/model-catalog", async importOriginal => {
  const actual = await importOriginal<typeof import("../../shared/model-catalog")>();
  return {
    ...actual,
    MANAGED_MODELS: actual.MANAGED_MODELS.map(m => ({
      ...m,
      // qP's extra mandatory isolation/phase contracts require more startup
      // headroom. Keep its separate fixture small without removing contracts.
      contextWindow: m.model === "openai/gpt-4.1-mini" ? 40960 : 32768,
    })),
  };
});
import { estimateRequestTokens } from "../llm-context";

const createCompletion = vi.hoisted(() => vi.fn());
const createSandbox = vi.hoisted(() => vi.fn());
const loadPaperContext = vi.hoisted(() => vi.fn());
const fetchContributionMaterials = vi.hoisted(() => vi.fn());
const assertReproductionRuntimeProviderCredits = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createCompletion } };
  },
}));
vi.mock("../storage", () => ({ storage: {} }));
vi.mock("../ethics-review", () => ({ loadPaperContext }));
vi.mock("../fs-materials", () => ({
  fetchContributionMaterials,
  materialSandboxPath: (file: { name: string }) => `/work/materials/${file.name}`,
  formatMaterialsInventory: () => "- /work/materials/expensive.py",
}));
vi.mock("../modal-sandbox", () => ({
  isModalConfigured: () => true,
  ReproductionSandbox: { create: createSandbox },
}));
vi.mock("../provider-credit-preflight", () => ({ assertReproductionRuntimeProviderCredits }));

import { REPRODUCTION_BUDGET } from "../reproduce";
import { runLegacyBaseline as runReproduction } from "./legacy-reproduction-baseline";
import { renderSourcePage } from "../reproduction-source-page";
import { ReproductionDiagnostics, getReproductionFailureDiagnostics } from "../reproduction-diagnostics";
import { REPRODUCER_PROMPT, JUDGE_PROMPT, buildEffectiveReproducerPrompt } from "../prompts/reproduce";

const logbook = [
  "## Claims\nR1 was rerun using the shipped experiment.",
  "## Reproduction Log\nOriginal tool #7 returned EXPENSIVE_METRIC=0.91.",
  "## Discrepancies\nThe measured value matches the reported value.",
  "## Limitations\nOnly the shipped materials were tested.",
].join("\n\n");
const claim = "測定🧪: the supplied experiment reports 0.91.";
const evidence = "EXPENSIVE_METRIC=0.91";
const PAPER = `# Paper\n${claim}\n${"測定 paper history ".repeat(800)}`;
const sourceArgs = (sourceToolCallId: number, paper = PAPER) => {
  const page = renderSourcePage("/work/paper.md", paper, 0, 6_000);
  const range = page.match(/^Returned characters: (\d+)-(\d+) of \d+$/m);
  if (!range || !page.includes(claim)) throw new Error("The fixture claim is not on the cited paper page");
  return {
    source_quote: claim,
    source_location: `characters ${range[1]}-${range[2]}`,
    source_tool_call_id: sourceToolCallId,
  };
};
const completion = (content: string | null, calls?: unknown[], finishReason = calls ? "tool_calls" : "stop") => ({
  choices: [{ message: { content, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: finishReason }],
});
const rawCall = (id: string, name: string, raw: string) => ({
  id, type: "function", function: { name, arguments: raw },
});
const call = (id: string, name: string, args: Record<string, unknown>) =>
  rawCall(id, name, JSON.stringify(args));

function acceptedState(request: any) {
  const message = [...request.messages].reverse().find((item: any) =>
    item.role === "user" && String(item.content).startsWith('{"authoritative":true'));
  expect(message).toBeDefined();
  return JSON.parse(message.content);
}

function activeGuidance(request: any): string {
  const message = request.messages.at(-1);
  expect(message.role).toBe("user");
  return String(message.content);
}

function expectPendingR4Guidance(request: any, recoveryCalls?: number) {
  const guidance = activeGuidance(request);
  const phase = recoveryCalls === undefined ? guidance : guidance.slice(guidance.indexOf("\n") + 1);
  expect(phase).toMatch(/^LATEST ACTION — (PREPARE\/EXECUTE|FINALIZE):/);
  expect(phase).toContain("R4");
  expect(phase).toContain(claim);
  expect(Buffer.byteLength(JSON.stringify(phase), "utf8")).toBeLessThanOrEqual(800);
  expect(phase).not.toMatch(/NEXT.*register|NEXT.*EXTRACT/i);
  if (recoveryCalls !== undefined) {
    expect(guidance).toMatch(new RegExp(`^RECOVERY: ${recoveryCalls} tool calls left`));
  }
  expect(acceptedState(request).claims).toEqual([
    expect.objectContaining({ id: "R4", status: "pending" }),
  ]);
}

// Two initial inspections, then seven repeated directory/archive pages. The
// eleventh dispatched call trips the real guard after R4 is already accepted.
function pendingR4BrowsingTurn(turn: number, request: any, archive = "read_tool_result", paper = PAPER) {
  if (turn === 1) return completion(null, [
    call("r4-source", "read_file", { path: "/work/paper.md", max_chars: 6000 }),
    call("r4-register", "record_result", {
      id: "R4", claim, status: "pending", original_value: "0.91", ...sourceArgs(1, paper),
    }),
  ]);
  if (turn > 10) return undefined;
  expectPendingR4Guidance(request);
  const args = archive === "read_reproduction_context"
    ? { ref: acceptedState(request).claims[0].ref, max_chars: 120 }
    : { tool_call_id: 1, max_chars: 120 };
  return completion(null, [turn % 2 === 0
    ? call(`browse-directory-${turn}`, "list_files", { path: "/work/materials" })
    : call(`browse-archive-${turn}`, archive, args)]);
}

function expectBoundedReplayRequests(requests: any[], contextWindow = 32768) {
  for (const request of requests) {
    expect(estimateRequestTokens(request) + request.max_tokens + 1024).toBeLessThanOrEqual(contextWindow);
    const declarations = new Set(request.messages.flatMap((message: any) =>
      (message.tool_calls ?? []).map((item: any) => item.id)));
    for (const message of request.messages) {
      if (message.role === "tool") expect(declarations.has(message.tool_call_id)).toBe(true);
    }
  }
}

async function runSuccessfulReplay(opts: Parameters<typeof runReproduction>[0] = options()) {
  try {
    return await runReproduction(opts);
  } catch (error) {
    // The production loop sanitizes provider exceptions. Re-throw an assertion
    // from the mocked provider itself so a failed replay points to its cause.
    await createCompletion.mock.results.at(-1)?.value;
    throw error;
  }
}

async function runFailedReplay(opts: Parameters<typeof runReproduction>[0] = options()): Promise<unknown> {
  try {
    return await runReproduction(opts);
  } catch (error) {
    await createCompletion.mock.results.at(-1)?.value;
    return error;
  }
}

function options() {
  const config = { providerMode: "platform" as const, provider: "openai", modelName: "openai/gpt-4o" };
  return {
    reproductionId: "replay-1", projectId: "project-1", journalId: "journal-1",
    initiativeDocId: "initiative-1", initiativeSlug: "initiative",
    journalDisplayName: "Replay journal", documentId: "paper-1", paperTitle: "Replay paper",
    reproducerPrompt: REPRODUCER_PROMPT, judgePrompt: JUDGE_PROMPT,
    modelConfig: config, judgeModelConfig: config, gpu: "T4" as const,
    emitEvent: vi.fn(async (_phase: string, _message: string) => {}),
  };
}

function sandbox() {
  const files = new Map<string, string>();
  return {
    sandboxId: "mocked-replay-sandbox", image: "mocked-image",
    writeText: vi.fn(async (path: string, content: string) => { files.set(path, content); }),
    listFiles: vi.fn(async () => []), readText: vi.fn(async (path: string) => files.get(path) ?? ""),
    exec: vi.fn(async (argv: string[]) => ({
      stdout: argv.join(" ").includes("nvidia-smi") ? "Mock GPU, 16 GB" : evidence,
      stderr: "", exitCode: 0, timedOut: false, durationMs: 1,
    })),
    terminate: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_API_KEY", "synthetic-test-key");
  vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", "https://managed.example.test");
  vi.stubEnv("LAB_ALLOWED_MODELS", "openai/gpt-4o");
  createCompletion.mockReset();
  createSandbox.mockReset();
  loadPaperContext.mockResolvedValue({
    title: "Replay paper", authors: "Test author", date: "2026",
    abstract: "One quantitative claim.", url: "https://example.test/paper",
    fullText: "# Paper\nOne quantitative claim.", fsAbstracts: [],
  });
  fetchContributionMaterials.mockResolvedValue({
    documentId: "paper-1",
    files: [{ name: "expensive.py", kind: "text", source: "additional", text: "print('EXPENSIVE_METRIC=0.91')" }],
    readme: "Run expensive.py.", paperMarkdown: PAPER,
    textFileCount: 1, binaryFileCount: 0,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("mocked full-flow reproduction failure and recovery replay", () => {
  it("allows a second analysis command after the old cutoff and repairs a result during reserved finalization", async () => {
    const sb = sandbox();
    await sb.writeText("/work/predictions.csv", "correct\nTrue\n");
    createSandbox.mockResolvedValue(sb);
    let turn = 0;
    let judged = 0;
    createCompletion.mockImplementation(async (request: any) => {
      if (!request.tools) {
        judged++;
        expect(request.messages[1].content).toContain("Original tool #16");
        return completion(JSON.stringify({
          summary: "Independently checked the second execution.",
          results: [{ id: "R4", claim, verdict: "verified", reproduced_value: "0.91", evidence }],
        }));
      }
      turn++;
      const browsing = pendingR4BrowsingTurn(turn, request);
      if (browsing) return browsing;
      if (turn === 11) return completion(null, [call("recover-state", "read_reproduction_context", { ref: acceptedState(request).claims[0].ref })]);
      if (turn === 12) return completion(null, [call("first-analysis", "run_command", { command: "python /work/materials/expensive.py" })]);
      if (turn === 13) return completion(null, [call("first-output", "read_tool_result", { tool_call_id: 13 })]);
      if (turn === 14) return completion(null, [call("predictions", "read_file", { path: "/work/predictions.csv" })]);
      if (turn === 15) {
        expect(activeGuidance(request)).toContain("(analysis)");
        return completion(null, [call("second-analysis", "run_command", { command: "python /work/materials/expensive.py --check" })]);
      }
      if (turn <= 18) return completion(null, [call(`evidence-${turn}`, "read_tool_result", { tool_call_id: 16 })]);
      expect(activeGuidance(request)).toContain(turn < 22 ? "(finalization)" : "REPORT");
      if (turn === 19) return completion(null, [call("rejected-final", "record_result", { id: "R4", status: "verified" })]);
      if (turn === 20) return completion(null, [call("recover-evidence", "read_tool_result", { tool_call_id: 16 })]);
      if (turn === 21) return completion(null, [call("supported-final", "record_result", {
        id: "R4", status: "verified", method: "rerun", reproduced_value: "0.91",
        evidence_tool_call_ids: [16], evidence_excerpt: evidence,
      })]);
      expect(turn).toBe(22);
      return completion(logbook.replaceAll("R1", "R4").replace("tool #7", "tool #16"));
    });
    const result = await runSuccessfulReplay();
    expect(result.overall).toBe("verified");
    expect(result.toolCallCount).toBe(22);
    expect(judged).toBe(1);
    expect(sb.exec.mock.calls.filter(([argv]) => argv.join(" ").includes("expensive.py"))).toHaveLength(2);
  });
  it.each([false, true])("moves accepted R4 from repeated browsing through script inspection, write, execution and validated judging (provider context rejection: %s)", async rejectContext => {
    const sb = sandbox();
    createSandbox.mockResolvedValue(sb);
    const requests: any[] = [];
    const judged: any[] = [];
    let turn = 0;
    let rejected = false;
    const wrapper = "import runpy\nrunpy.run_path('/work/materials/expensive.py', run_name='__main__')\n";
    const recoveredLogbook = logbook.replaceAll("R1", "R4").replace("tool #7", "tool #14");
    createCompletion.mockImplementation(async (request: any) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (!request.tools) {
        const input = request.messages[1].content;
        judged.push(...JSON.parse(input.split("# AGENT'S RECORDED RESULTS (proposals, not verdicts)\n")[1].split("\n\n# AGENT'S LOGBOOK")[0]));
        expect(input).toContain("Original tool #14");
        expect(input).toContain("python /work/recover-r4.py");
        expect(input).toContain(evidence);
        return completion(JSON.stringify({
          summary: "The independent judge checked R4's actual recovered execution.",
          results: [{ id: "R4", claim, verdict: "verified", reproduced_value: "0.91", evidence }],
        }));
      }
      expect(request.messages[0].content).toBe(buildEffectiveReproducerPrompt(REPRODUCER_PROMPT));
      if (turn === 10 && rejectContext && !rejected) {
        expectPendingR4Guidance(request, 4);
        rejected = true;
        throw {
          status: 400,
          error: {
            code: "context_length_exceeded",
            message: "This model's maximum context length is 32768 tokens. However, you requested 33000 tokens (25000 in the messages, 8000 in the completion).",
          },
        };
      }
      turn++;
      const browsing = pendingR4BrowsingTurn(turn, request);
      if (browsing) return browsing;
      if (turn === 11) {
        expectPendingR4Guidance(request, 4);
        const guidance = activeGuidance(request);
        expect(guidance.indexOf("PREPARE/EXECUTE")).toBeLessThan(guidance.indexOf("PAGE ARCHIVED OUTPUT"));
        return completion(null, [call("inspect-r4-script", "read_file", { path: "/work/materials/expensive.py" })]);
      }
      if (turn === 12) {
        expectPendingR4Guidance(request, 3); // A new script read cannot renew the grace window.
        const output = request.messages.find((message: any) => message.tool_call_id === "inspect-r4-script");
        expect(output?.content).toContain("[Tool call #12]");
        expect(sb.readText).toHaveBeenCalledWith("/work/materials/expensive.py");
        if (rejectContext) {
          expect(output?.content).toContain("Earlier output elided. Use read_tool_result with the original tool call ID");
        } else {
          expect(output?.content).toContain("Verified file: /work/materials/expensive.py");
          expect(output?.content).toContain("print('EXPENSIVE_METRIC=0.91')");
        }
        return completion(null, [call("write-r4-wrapper", "write_file", { path: "/work/recover-r4.py", content: wrapper })]);
      }
      if (turn === 13) {
        expectPendingR4Guidance(request, 2);
        return completion(null, [call("execute-r4", "run_command", { command: "python /work/recover-r4.py" })]);
      }
      if (turn === 14) {
        expect(activeGuidance(request)).toMatch(/^RECOVERY: 6 tool calls left \(analysis\)/);
        expect(activeGuidance(request)).toContain("LATEST ACTION — ASSESS/RECORD");
        expect(activeGuidance(request)).toContain("R4");
        expect(acceptedState(request).claims[0]).toMatchObject({ id: "R4", status: "pending" });
        const output = request.messages.find((message: any) => message.tool_call_id === "execute-r4");
        expect(output?.content).toContain("[Tool call #14]");
        if (rejectContext) {
          expect(output?.content).toContain("Earlier output elided. Use read_tool_result with the original tool call ID");
        } else {
          expect(output?.content).toContain(evidence);
        }
        return completion(null, [call("finalize-r4", "record_result", {
          id: "R4", status: "verified", method: "rerun", reproduced_value: "0.91",
          evidence_tool_call_ids: [14], evidence_excerpt: evidence,
        })]);
      }
      expect(turn).toBe(15);
      expect(activeGuidance(request)).toMatch(/^LATEST ACTION — REPORT:/);
      expect(activeGuidance(request)).not.toContain("RECOVERY");
      expect(acceptedState(request).claims[0]).toMatchObject({ id: "R4", status: "verified" });
      return completion(recoveredLogbook);
    });

    const opts = options();
    const result = await runSuccessfulReplay(opts);
    expect(result.overall).toBe("verified");
    expect(result.stoppedBy).toBe("model");
    expect(result.toolCallCount).toBe(15);
    expect(judged).toEqual([expect.objectContaining({
      id: "R4", claim, status: "verified", reproducedValue: "0.91", evidenceToolCallIds: [14],
    })]);
    expect(sb.writeText).toHaveBeenCalledWith("/work/recover-r4.py", wrapper);
    expect(sb.readText.mock.invocationCallOrder.at(-1)).toBeLessThan(sb.exec.mock.invocationCallOrder.at(-1)!);
    expect(sb.exec.mock.calls.filter(([argv]) => !argv.join(" ").includes("nvidia-smi"))).toEqual([
      [["bash", "-lc", "python /work/recover-r4.py"], expect.objectContaining({ timeoutMs: expect.any(Number) })],
    ]);
    expect(sb.terminate).toHaveBeenCalledTimes(1);
    expect(rejected).toBe(rejectContext);
    if (rejectContext) {
      const recoveryRequests = requests.filter(request => request.tools && activeGuidance(request).startsWith("RECOVERY: 4"));
      expect(recoveryRequests).toHaveLength(2);
      expect(JSON.stringify(recoveryRequests[0])).not.toBe(JSON.stringify(recoveryRequests[1]));
      expect(opts.emitEvent.mock.calls.some(([phase]) => phase === "reproduction-context")).toBe(true);
    }
    expectBoundedReplayRequests(requests);
  });

  it("starts all four recovery calls in the next outgoing request after a threshold-crossing batch, without charging already-generated script/write/command calls", async () => {
    const sb = sandbox();
    createSandbox.mockResolvedValue(sb);
    const requests: any[] = [];
    let turn = 0;
    let judgeCalls = 0;
    const wrapper = "import runpy\nrunpy.run_path('/work/materials/expensive.py', run_name='__main__')\n";
    createCompletion.mockImplementation(async (request: any) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (!request.tools) {
        judgeCalls++;
        expect(request.messages[1].content).toContain("Original tool #14");
        expect(request.messages[1].content).toContain("python /work/batched-r4.py");
        return completion(JSON.stringify({
          summary: "The judge verified the batched execution.",
          results: [{ id: "R4", claim, verdict: "verified", reproduced_value: "0.91", evidence }],
        }));
      }
      turn++;
      if (turn === 10) {
        expectPendingR4Guidance(request);
        expect(activeGuidance(request)).not.toContain("RECOVERY:");
        return completion(null, [
          call("threshold-directory", "list_files", { path: "/work/materials" }), // #11 trips the guard.
          call("already-generated-inspection", "read_file", { path: "/work/materials/expensive.py" }),
          call("already-generated-write", "write_file", { path: "/work/batched-r4.py", content: wrapper }),
          call("already-generated-command", "run_command", { command: "python /work/batched-r4.py" }),
        ]);
      }
      const browsing = pendingR4BrowsingTurn(turn, request);
      if (browsing) return browsing;
      if (turn === 11) {
        expect(activeGuidance(request)).toMatch(/^RECOVERY: 4 tool calls left/);
        expect(activeGuidance(request)).toContain("LATEST ACTION — ASSESS/RECORD");
        expect(activeGuidance(request)).toContain("R4");
        expect(acceptedState(request).claims[0]).toMatchObject({ id: "R4", status: "pending" });
        expect(sb.readText).toHaveBeenCalledWith("/work/materials/expensive.py");
        expect(sb.writeText).toHaveBeenCalledWith("/work/batched-r4.py", wrapper);
        expect(sb.exec.mock.calls.filter(([argv]) => argv.join(" ").includes("python /work/batched-r4.py"))).toHaveLength(1);
        return completion(null, [call("record-after-batched-threshold", "record_result", {
          id: "R4", status: "verified", method: "rerun", reproduced_value: "0.91",
          evidence_tool_call_ids: [14], evidence_excerpt: evidence,
        })]);
      }
      expect(turn).toBe(12);
      expect(activeGuidance(request)).toMatch(/^LATEST ACTION — REPORT:/);
      return completion(logbook.replaceAll("R1", "R4").replace("tool #7", "tool #14"));
    });

    const result = await runSuccessfulReplay();
    expect(result.overall).toBe("verified");
    expect(result.toolCallCount).toBe(15);
    expect(result.stoppedBy).toBe("model");
    expect(judgeCalls).toBe(1);
    expect(sb.terminate).toHaveBeenCalledTimes(1);
    expectBoundedReplayRequests(requests);
  });

  it("keeps R4's remaining handoff active when a newly registered, unrelated R5 is validly finalized", async () => {
    const sb = sandbox();
    createSandbox.mockResolvedValue(sb);
    const secondClaim = "The independently shipped check reports EXPENSIVE_METRIC=0.91.";
    const twoClaimPaper = `# Paper\n${claim}\n${secondClaim}\n${"測定 paper history ".repeat(800)}`;
    fetchContributionMaterials.mockResolvedValue({
      documentId: "paper-1",
      files: [{ name: "expensive.py", kind: "text", source: "additional", text: "print('EXPENSIVE_METRIC=0.91')" }],
      readme: "Run expensive.py.", paperMarkdown: twoClaimPaper,
      textFileCount: 1, binaryFileCount: 0,
    });
    const requests: any[] = [];
    let turn = 0;
    let forcedStops = 0;
    createCompletion.mockImplementation(async (request: any) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (!request.tools) {
        expect(activeGuidance(request)).toMatch(/^STOP: Repeated browsing recovery exhausted/);
        forcedStops++;
        return completion([
          "## Claims\nR4 remains pending; R5 was tested.",
          "## Reproduction Log\nOriginal command #13 returned EXPENSIVE_METRIC=0.91 for R5.",
          "## Discrepancies\nR4 still has no accepted outcome.",
          "## Limitations\nR4's bounded recovery allowance was exhausted.",
        ].join("\n\n"));
      }
      turn++;
      const browsing = pendingR4BrowsingTurn(turn, request, "read_tool_result", twoClaimPaper);
      if (browsing) return browsing;
      if (turn === 11) {
        expectPendingR4Guidance(request, 4);
        return completion(null, [
          call("register-unrelated-r5", "record_result", {
            id: "R5", claim: secondClaim, status: "pending", original_value: "0.91",
            ...sourceArgs(1, twoClaimPaper), source_quote: secondClaim,
          }),
          call("unrelated-r5-command", "run_command", { command: "python /work/materials/expensive.py" }),
          call("finalize-unrelated-r5", "record_result", {
            id: "R5", status: "verified", method: "rerun", reproduced_value: "0.91",
            evidence_tool_call_ids: [13], evidence_excerpt: evidence,
          }),
        ]);
      }
      expect(turn).toBeLessThanOrEqual(19);
      expect(activeGuidance(request)).toContain("RECOVERY:");
      expect(activeGuidance(request)).toContain('Pending id="R4"');
      expect(acceptedState(request).claims).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "R4", status: "pending" }),
        expect.objectContaining({ id: "R5", status: "verified" }),
      ]));
      return completion(null, [call("still-invalid-r4", "record_result", {
        id: "R4", status: "verified", method: "rerun", reproduced_value: "0.90",
        evidence_tool_call_ids: [13], evidence_excerpt: evidence,
      })]);
    });

    const error = await runFailedReplay();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/stopped before completing required work \(no-progress\)/);
    expect(forcedStops).toBe(1); // A judge request has no STOP instruction and cannot pass the mock.
    expect(turn).toBe(19);
    expect(getReproductionFailureDiagnostics(error)).toMatchObject({
      stopReason: "no-progress", callCount: 22,
      claims: expect.arrayContaining([
        expect.objectContaining({ id: "R4", status: "pending" }),
        expect.objectContaining({ id: "R5", status: "verified" }),
      ]),
    });
    expect(sb.exec.mock.calls.filter(([argv]) => argv.join(" ").includes("python /work/materials/expensive.py"))).toHaveLength(1);
    expect(sb.terminate).toHaveBeenCalledTimes(1);
    expectBoundedReplayRequests(requests);
  });

  it("refuses late same-batch finalizations after preparation and reserved repairs are exhausted", async () => {
    const sb = sandbox();
    createSandbox.mockResolvedValue(sb);
    const requests: any[] = [];
    let turn = 0;
    let forcedStops = 0;
    createCompletion.mockImplementation(async (request: any) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (!request.tools) {
        const refusedRecord = request.messages.find((message: any) => message.tool_call_id === "eighth-would-be-valid");
        const refusedAssessment = request.messages.find((message: any) => message.tool_call_id === "sixth-assessment");
        expect(refusedRecord?.content).toContain("this call was not executed");
        expect(refusedAssessment?.content).toContain("this call was not executed");
        expect(refusedRecord?.content).not.toContain("evidence validated");
        forcedStops++;
        return completion([
          "## Claims\nR4 remains pending.",
          "## Reproduction Log\nOriginal command #12 ran, but the four accepted-budget finalization attempts were invalid.",
          "## Discrepancies\nNo valid claim outcome was accepted.",
          "## Limitations\nCalls beyond the four-call recovery allowance were not executed.",
        ].join("\n\n"));
      }
      turn++;
      if (turn === 10) return completion(null, [
        call("threshold-before-record-batch", "list_files", { path: "/work/materials" }),
        call("command-before-record-batch", "run_command", { command: "python /work/materials/expensive.py" }),
      ]);
      const browsing = pendingR4BrowsingTurn(turn, request);
      if (browsing) return browsing;
      expect(turn).toBe(11);
      expect(activeGuidance(request)).toMatch(/^RECOVERY: 4 tool calls left/);
      return completion(null, [
        call("invalid-finalization-one", "record_result", { id: "R4", status: "verified" }),
        call("invalid-finalization-two", "record_result", {
          id: "R4", status: "verified", method: "rerun", reproduced_value: "0.90",
          evidence_tool_call_ids: [12], evidence_excerpt: evidence,
        }),
        call("invalid-finalization-three", "record_result", {
          id: "R4", status: "verified", method: "rerun", reproduced_value: "0.91",
          evidence_tool_call_ids: [999], evidence_excerpt: evidence,
        }),
        call("invalid-finalization-four", "record_result", { id: "R4", status: ["verified"] }),
        ...Array.from({ length: 3 }, (_, i) => call(`final-repair-${i}`, "record_result", { id: "R4", status: "verified" })),
        call("eighth-would-be-valid", "record_result", {
          id: "R4", status: "verified", method: "rerun", reproduced_value: "0.91",
          evidence_tool_call_ids: [12], evidence_excerpt: evidence,
        }),
        call("sixth-assessment", "assess_suitability", { assessment: {} }),
      ]);
    });

    const opts = options();
    const error = await runFailedReplay(opts);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/stopped before completing required work \(no-progress\)/);
    expect(turn).toBe(11);
    expect(forcedStops).toBe(1);
    expect(getReproductionFailureDiagnostics(error)).toMatchObject({
      stopReason: "no-progress", callCount: 19,
      claims: [expect.objectContaining({ id: "R4", status: "pending" })],
    });
    expect(opts.emitEvent.mock.calls.filter(([phase]) => phase === "reproduction-record")).toHaveLength(8); // Registration, preparation attempts and reserved repairs.
    expect(opts.emitEvent.mock.calls.some(([phase, message]) =>
      phase === "reproduction-record" && message.includes("evidence validated"))).toBe(false);
    expect(sb.exec.mock.calls.filter(([argv]) => argv.join(" ").includes("python /work/materials/expensive.py"))).toHaveLength(1);
    expect(sb.terminate).toHaveBeenCalledTimes(1);
    expectBoundedReplayRequests(requests);
  });

  it("keeps qP handoff guidance subordinate to the assessment phase and cannot execute or write before that gate", async () => {
    const sb = sandbox();
    createSandbox.mockResolvedValue(sb);
    const requests: any[] = [];
    let turn = 0;
    let forcedStops = 0;
    let startupCommands = 0;
    // Keep qP's additional mandatory phase/isolation contract inside this
    // intentionally small serving window, without removing the contract itself.
    const savedPrompt = "Inspect the supplied paper and materials. Assess suitability before any scientific write or execution.";
    const config = { providerMode: "platform" as const, provider: "openai", modelName: "openai/gpt-4.1-mini" };
    vi.stubEnv("LAB_ALLOWED_MODELS", config.modelName);
    createCompletion.mockImplementation(async (request: any) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      expect(request.messages[0].content).toBe(buildEffectiveReproducerPrompt(savedPrompt, "qP"));
      if (!request.tools) {
        expect(activeGuidance(request)).toMatch(/^STOP: Repeated browsing recovery exhausted/);
        const command = request.messages.find((message: any) => message.tool_call_id === "qp-gated-command");
        const write = request.messages.find((message: any) => message.tool_call_id === "qp-gated-write");
        expect(command?.content).toContain("qP assessment phase permits inspection only");
        expect(write?.content).toContain("qP assessment phase permits inspection only");
        forcedStops++;
        return completion([
          "## Claims\nR4 remains pending.",
          "## Reproduction Log\nNo scientific execution or write was authorized.",
          "## Discrepancies\nSuitability assessment was never completed.",
          "## Limitations\nRecovery cannot bypass the qP assessment phase.",
        ].join("\n\n"));
      }
      turn++;
      if (turn === 1) {
        startupCommands = sb.exec.mock.calls.length;
        return pendingR4BrowsingTurn(1, request);
      }
      if (turn < 10) {
        expect(activeGuidance(request)).toContain("qP phase: assessment");
        return completion(null, [call(`qp-directory-${turn}`, "list_files", { path: "/work/materials" })]);
      }
      if (turn > 10) {
        expect(activeGuidance(request)).toContain("(finalization)");
        return completion(null, [call(`qp-final-${turn}`, "record_result", { id: "R4", status: "verified" })]);
      }
      expect(turn).toBe(10);
      const guidance = activeGuidance(request);
      expect(guidance).toMatch(/^RECOVERY: 4 tool calls left/);
      const prefix = guidance.split("\n")[0];
      expect(prefix).toMatch(/follow.*qP phase/i);
      expect(prefix).not.toMatch(/inspect relevant code|test the pending claim|run.*experiment/i);
      expect(guidance).toContain("qP phase: assessment (inspection only; write/execute disabled)");
      expect(guidance).toContain("call assess_suitability before execution");
      return completion(null, [
        call("qp-gated-command", "run_command", { command: "python materials/expensive.py" }),
        call("qp-gated-write", "write_file", { path: "/work/working/materials/expensive.py", content: "print('unauthorized')" }),
        call("qp-allowed-inspection", "read_file", { path: "/work/materials/expensive.py" }),
        call("qp-invalid-assessment", "assess_suitability", { assessment: "{}" }),
      ]);
    });

    const error = await runFailedReplay({
      ...options(), agentId: "qP" as const, reproducerPrompt: savedPrompt,
      modelConfig: config, judgeModelConfig: config,
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/stopped before completing required work \(no-progress\)/);
    expect(forcedStops).toBe(1);
    expect(startupCommands).toBeGreaterThan(0);
    expect(sb.exec).toHaveBeenCalledTimes(startupCommands); // Only sealed setup/isolation and environment probes.
    expect(sb.writeText.mock.calls.some(([, content]) => content === "print('unauthorized')")).toBe(false);
    expect(getReproductionFailureDiagnostics(error)).toMatchObject({
      stopReason: "no-progress", callCount: 17,
      claims: [expect.objectContaining({ id: "R4", status: "pending" })],
    });
    expect(sb.terminate).toHaveBeenCalledTimes(1);
    expectBoundedReplayRequests(requests, 40960);
  });

  it("exhausts preparation and finalization when R4 keeps browsing, without judging or inventing a blocker", async () => {
    const sb = sandbox();
    createSandbox.mockResolvedValue(sb);
    const requests: any[] = [];
    const remaining: number[] = [];
    let turn = 0;
    let forcedStops = 0;
    const honestLogbook = [
      "## Claims\nR4 is still pending and has not been tested.",
      "## Reproduction Log\nOnly directories and archived accepted state were inspected.",
      "## Discrepancies\nNo experiment was run; no scientific comparison is possible.",
      "## Limitations\nRepeated browsing consumed the bounded recovery allowance. No real blocker was demonstrated.",
    ].join("\n\n");
    createCompletion.mockImplementation(async (request: any) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      const stop = request.messages.find((message: any) =>
        message.role === "user" && String(message.content).startsWith("STOP:"));
      if (!request.tools) {
        expect(stop?.content).toContain("Repeated browsing recovery exhausted");
        expect(request.messages[0].content).toBe(buildEffectiveReproducerPrompt(REPRODUCER_PROMPT));
        forcedStops++;
        return completion(honestLogbook);
      }
      turn++;
      const browsing = pendingR4BrowsingTurn(turn, request, "read_reproduction_context");
      if (browsing) return browsing;
      const left = turn < 15 ? 15 - turn : 18 - turn;
      expectPendingR4Guidance(request, left);
      remaining.push(left);
      return completion(null, [turn % 2 === 0
        ? call(`persistent-directory-${turn}`, "list_files", { path: "/work/materials" })
        : call(`persistent-context-${turn}`, "read_reproduction_context", {
          ref: acceptedState(request).claims[0].ref, max_chars: 120,
        })]);
    });

    const error = await runReproduction(options()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/stopped before completing required work \(no-progress\)/);
    expect(remaining).toEqual([4, 3, 2, 1, 3, 2, 1]);
    expect(turn).toBe(17);
    expect(forcedStops).toBe(1);
    const diagnostics = getReproductionFailureDiagnostics(error)!;
    expect(diagnostics).toMatchObject({ stopReason: "no-progress", stage: "completion", callCount: 18 });
    expect(diagnostics.claims).toEqual([expect.objectContaining({ id: "R4", status: "pending" })]);
    expect(JSON.stringify(diagnostics.claims)).not.toContain("blocker");
    expect(sb.exec).toHaveBeenCalledTimes(1); // Environment probe only, never a fabricated experiment.
    expect(sb.terminate).toHaveBeenCalledTimes(1);
    expectBoundedReplayRequests(requests);
  });

  it("does not execute or judge textual DSML tool invocations returned on the forced-final turn", async () => {
    const sb = sandbox();
    createSandbox.mockResolvedValue(sb);
    const requests: any[] = [];
    let turn = 0;
    let forcedStops = 0;
    let judgeCalls = 0;
    const dsmlCommand = "python /work/materials/expensive.py --dsml-forced-final";
    const dsmlReply = [
      "I will retrieve the archived output and run the experiment now.",
      "<｜DSML｜tool_calls>",
      '<｜DSML｜invoke name="read_tool_result">',
      '<｜DSML｜parameter name="tool_call_id">1</｜DSML｜parameter>',
      "</｜DSML｜invoke>",
      '<｜DSML｜invoke name="run_command">',
      `<｜DSML｜parameter name="command" string="true">${dsmlCommand}</｜DSML｜parameter>`,
      "</｜DSML｜invoke>",
      "</｜DSML｜tool_calls>",
    ].join("\n");
    createCompletion.mockImplementation(async (request: any) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (!request.tools) {
        const stop = request.messages.find((message: any) =>
          message.role === "user" && String(message.content).startsWith("STOP:"));
        if (!stop) {
          judgeCalls++;
          throw new Error("The independent judge must not run for a pending claim and DSML-only final response.");
        }
        expect(stop.content).toContain("Repeated browsing recovery exhausted");
        forcedStops++;
        return completion(dsmlReply); // Content only: no provider-native tool_calls.
      }
      turn++;
      const browsing = pendingR4BrowsingTurn(turn, request, "read_reproduction_context");
      if (browsing) return browsing;
      expectPendingR4Guidance(request, turn < 15 ? 15 - turn : 18 - turn);
      return completion(null, [turn % 2 === 0
        ? call(`dsml-loop-directory-${turn}`, "list_files", { path: "/work/materials" })
        : call(`dsml-loop-context-${turn}`, "read_reproduction_context", {
          ref: acceptedState(request).claims[0].ref, max_chars: 120,
        })]);
    });

    const opts = options();
    const error = await runFailedReplay(opts);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/stopped before completing required work \(no-progress\)/);
    expect((error as Error).message).toMatch(/still pending \(R4\)/);
    expect((error as Error).message).toMatch(/final logbook is missing/);
    expect(getReproductionFailureDiagnostics(error)).toMatchObject({
      stopReason: "no-progress", stage: "completion", callCount: 18,
      claims: [expect.objectContaining({ id: "R4", status: "pending" })],
    });
    expect(turn).toBe(17);
    expect(forcedStops).toBe(1);
    expect(judgeCalls).toBe(0);
    expect(opts.emitEvent.mock.calls.some(([phase]) => phase === "reproduction-judge")).toBe(false);
    expect(sb.exec).toHaveBeenCalledTimes(1); // Environment probe only.
    expect(sb.exec.mock.calls.some(([argv]) => argv.join(" ").includes(dsmlCommand))).toBe(false);
    expect(requests.flatMap(request => request.messages)
      .flatMap((message: any) => message.tool_calls ?? [])
      .some((item: any) => item.function.name === "read_tool_result" || item.function.name === "run_command")).toBe(false);
    expect(sb.terminate).toHaveBeenCalledTimes(1);
    expectBoundedReplayRequests(requests);
  });

  it("does not renew analysis or finalization for fresh reads and writes without a validated claim", async () => {
    const sb = sandbox();
    createSandbox.mockResolvedValue(sb);
    let turn = 0;
    let forcedStops = 0;
    createCompletion.mockImplementation(async (request: any) => {
      if (!request.tools) {
        expect(activeGuidance(request)).toMatch(/^STOP: Repeated browsing recovery exhausted/);
        forcedStops++;
        return completion(logbook.replace("R1 was rerun", "R4 remains pending after the script was rerun"));
      }
      turn++;
      const browsing = pendingR4BrowsingTurn(turn, request);
      if (browsing) return browsing;
      const left = turn <= 12 ? 15 - turn : turn < 19 ? 19 - turn : 22 - turn;
      expect(activeGuidance(request)).toMatch(new RegExp(`^RECOVERY: ${left} tool calls left`));
      expect(acceptedState(request).claims[0]).toMatchObject({ id: "R4", status: "pending" });
      if (turn === 11) return completion(null, [call("fresh-script", "read_file", { path: "/work/materials/expensive.py" })]);
      if (turn === 12) return completion(null, [call("unrecorded-run", "run_command", { command: "python /work/materials/expensive.py" })]);
      if (turn === 13) return completion(null, [call("fresh-note", "write_file", { path: "/work/results/notes.md", content: evidence })]);
      expect(turn).toBeLessThanOrEqual(21);
      return completion(null, [call("fresh-note-read", "read_file", { path: "/work/results/notes.md" })]);
    });

    const error = await runReproduction(options()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/no-progress/);
    expect(getReproductionFailureDiagnostics(error)).toMatchObject({
      stopReason: "no-progress", callCount: 22,
      claims: [expect.objectContaining({ id: "R4", status: "pending" })],
    });
    expect(turn).toBe(21);
    expect(forcedStops).toBe(1);
    expect(sb.exec.mock.calls.filter(([argv]) => argv.join(" ").includes("/work/materials/expensive.py"))).toHaveLength(1);
    expect(sb.terminate).toHaveBeenCalledTimes(1);
  });

  it("uses a real failed shipped-script command during handoff to finalize R4 as a command-error blocker, then independently judges it", async () => {
    const sb = sandbox();
    const dependencyError = "ModuleNotFoundError: No module named 'replay_dependency'";
    sb.exec.mockImplementation(async argv => argv.join(" ").includes("nvidia-smi")
      ? { stdout: "Mock GPU, 16 GB", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 }
      : { stdout: "", stderr: dependencyError, exitCode: 1, timedOut: false, durationMs: 1 });
    createSandbox.mockResolvedValue(sb);
    let turn = 0;
    let judgeCalls = 0;
    createCompletion.mockImplementation(async (request: any) => {
      if (!request.tools) {
        judgeCalls++;
        const input = request.messages[1].content;
        expect(input).toContain("Original tool #13");
        expect(input).toContain("exit code 1");
        expect(input).toContain(dependencyError);
        const claims = JSON.parse(input.split("# AGENT'S RECORDED RESULTS (proposals, not verdicts)\n")[1].split("\n\n# AGENT'S LOGBOOK")[0]);
        expect(claims).toEqual([expect.objectContaining({
          id: "R4", claim, status: "inconclusive", method: "blocked",
          blockerKind: "command-error", evidenceToolCallIds: [13], evidenceExcerpt: dependencyError,
        })]);
        return completion(JSON.stringify({
          summary: "The judge confirmed the concrete dependency failure, not a reproduced metric.",
          results: [{ id: "R4", claim, verdict: "inconclusive", evidence: dependencyError }],
        }));
      }
      turn++;
      const browsing = pendingR4BrowsingTurn(turn, request);
      if (browsing) return browsing;
      if (turn === 11) {
        expectPendingR4Guidance(request, 4);
        return completion(null, [call("blocked-script-read", "read_file", { path: "/work/materials/expensive.py" })]);
      }
      if (turn === 12) {
        expectPendingR4Guidance(request, 3);
        return completion(null, [call("actual-command-error", "run_command", { command: "python /work/materials/expensive.py" })]);
      }
      if (turn === 13) {
        expect(activeGuidance(request)).toMatch(/^RECOVERY: 6 tool calls left \(analysis\)/);
        const output = request.messages.find((message: any) => message.tool_call_id === "actual-command-error");
        expect(output?.content).toContain("exit code 1");
        expect(output?.content).toContain(dependencyError);
        return completion(null, [call("record-real-blocker", "record_result", {
          id: "R4", status: "inconclusive", method: "blocked", blocker_kind: "command-error",
          evidence_tool_call_ids: [13], evidence_excerpt: dependencyError,
          evidence: `Original command #13 failed: ${dependencyError}`,
          notes: "The shipped experiment failed with a dependency error before producing any metric.",
        })]);
      }
      expect(turn).toBe(14);
      expect(activeGuidance(request)).toMatch(/^LATEST ACTION — REPORT:/);
      expect(activeGuidance(request)).not.toContain("RECOVERY");
      return completion([
        "## Claims\nR4 could not be tested.",
        `## Reproduction Log\nOriginal tool #13: ${dependencyError}`,
        "## Discrepancies\nNo reproduced value was obtained.",
        "## Limitations\nThe shipped script failed with a dependency error.",
      ].join("\n\n"));
    });

    const result = await runSuccessfulReplay();
    expect(result.overall).toBe("inconclusive");
    expect(result.stoppedBy).toBe("model");
    expect(result.toolCallCount).toBe(14);
    expect(result.results).toEqual([expect.objectContaining({ id: "R4", verdict: "inconclusive" })]);
    expect(judgeCalls).toBe(1);
    expect(sb.exec.mock.calls.filter(([argv]) => !argv.join(" ").includes("nvidia-smi"))).toEqual([
      [["bash", "-lc", "python /work/materials/expensive.py"], expect.objectContaining({ timeoutMs: expect.any(Number) })],
    ]);
    expect(sb.terminate).toHaveBeenCalledTimes(1);
  });

  it("repairs registrations and malformed/truncated calls after compaction without repeating an experiment, then uses the independent judge", async () => {
    const sb = sandbox();
    createSandbox.mockResolvedValue(sb);
    const requests: any[] = [];
    const judged: any[] = [];
    const longDraft = `${logbook}\n${"Unfinished draft 測定🧪 ".repeat(4000)}END_UNFINISHED_DRAFT`;
    let turn = 0;
    createCompletion.mockImplementation(async (request: any) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (!request.tools) {
        const input = request.messages[1].content;
        const claims = JSON.parse(input.split("# AGENT'S RECORDED RESULTS (proposals, not verdicts)\n")[1].split("\n\n# AGENT'S LOGBOOK")[0]);
        judged.push(...claims);
        expect(input).toContain("Original tool #8");
        expect(input).toContain(evidence);
        return completion(JSON.stringify({
          summary: "The independent judge verified the cited execution.",
          results: [{ id: "R1", claim, verdict: "verified", reproduced_value: "0.91", evidence }],
        }));
      }
      expect(request.messages[0].content).toBe(buildEffectiveReproducerPrompt(REPRODUCER_PROMPT));
      turn++;
      if (turn === 1) {
        expect(JSON.stringify(request)).toContain("LATEST ACTION — EXTRACT");
        return completion(null, [
          call("paper-source", "read_file", { path: "/work/paper.md", max_chars: 6000 }),
          call("register", "record_result", { id: "R1", claim, status: "pending", ...sourceArgs(1) }),
        ]);
      }
      if (turn === 2) return completion(null, [
        call("duplicate", "record_result", { id: "R1", status: "pending" }),
        call("missing-id", "record_result", { status: "verified" }),
        call("wrong-type", "run_command", { command: ["python", "should-not-run.py"] }),
        rawCall("broken-json", "run_command", '{"command":"python should-not-run.py"'),
      ]);
      if (turn === 3) return completion(null, [
        call("truncated", "run_command", { command: "python should-not-run.py" }),
      ], "length");
      if (turn === 4) {
        expect(JSON.stringify(request)).toContain("LATEST ACTION — PREPARE/EXECUTE");
        return completion(null, [call("expensive", "run_command", { command: "python /work/materials/expensive.py" })]);
      }
      if (turn === 5) {
        return completion(null, [call("rejected-result", "record_result", {
        id: "R1", status: "verified", method: "rerun", reproduced_value: "0.90",
        evidence_excerpt: evidence, evidence_tool_call_ids: [8],
        notes: "Scientific details 測定🧪 ".repeat(500),
        })]);
      }
      if (turn === 6) return completion(longDraft);
      if (turn === 7) {
        expect(JSON.stringify(request)).not.toContain("END_UNFINISHED_DRAFT");
        expect(JSON.stringify(request)).toContain("read_reproduction_context");
        expect(JSON.stringify(request)).toContain("LATEST ACTION — ASSESS/RECORD");
        const stateMessage = [...request.messages].reverse().find((message: any) =>
          message.role === "user" && String(message.content).startsWith('{"authoritative":true'));
        const state = JSON.parse(stateMessage.content);
        expect(state.totals.claims).toBe(1);
        expect(state.claims[0]).toMatchObject({ id: "R1", status: "pending" });
        return completion(null, [call("recover-evidence", "read_tool_result", { tool_call_id: 8 })]);
      }
      if (turn === 8) {
        const tool = [...request.messages].reverse().find((message: any) => message.role === "tool");
        expect(tool.content).toContain("Original evidence tool call #8");
        expect(tool.content).toContain(evidence);
        return completion(null, [call("corrected-result", "record_result", {
          id: "R1", status: "verified", method: "rerun", reproduced_value: "0.91",
          evidence_excerpt: evidence, evidence_tool_call_ids: [8],
        })]);
      }
      expect(JSON.stringify(request)).toContain("LATEST ACTION — REPORT");
      return completion(logbook);
    });
    const result = await runReproduction(options());
    expect(result.overall).toBe("verified");
    expect(result.stoppedBy).toBe("model");
    expect(result.toolCallCount).toBe(11);
    expect(judged).toEqual([expect.objectContaining({
      id: "R1", claim, status: "verified", reproducedValue: "0.91", evidenceToolCallIds: [8],
    })]);
    expect(sb.exec.mock.calls.filter(([argv]) => argv.join(" ").includes("expensive.py"))).toHaveLength(1);
    expect(sb.exec.mock.calls.some(([argv]) => argv.join(" ").includes("should-not-run"))).toBe(false);
    expect(sb.terminate).toHaveBeenCalledTimes(1);
    for (const request of requests) {
      expect(estimateRequestTokens(request) + request.max_tokens + 1024).toBeLessThanOrEqual(32768);
      const declarations = new Set(request.messages.flatMap((message: any) => (message.tool_calls ?? []).map((item: any) => item.id)));
      for (const message of request.messages) {
        if (message.role === "tool") expect(declarations.has(message.tool_call_id)).toBe(true);
      }
    }
  });

  it("recovers the production browsing/archive loop through a real command, valid record, and judge after compaction", async () => {
    const sb = sandbox();
    const browsingPaper = `${PAPER}\n${"paper search page with reported values\n".repeat(1000)}PAPER_SEARCH_TAIL`;
    sb.readText.mockImplementation(async (path: string) => path === "/work/paper.md"
      ? browsingPaper
      : "");
    createSandbox.mockResolvedValue(sb);
    const requests: any[] = [];
    let turn = 0;
    let judgeCalled = false;
    const recoveredLogbook = [
      "## Claims\nR1 was tested with the shipped script.",
      "## Reproduction Log\nOriginal tool #6 returned EXPENSIVE_METRIC=0.91.",
      "## Discrepancies\nThe reproduced value matched.",
      "## Limitations\nOnly the shipped experiment was run.",
    ].join("\n\n");
    createCompletion.mockImplementation(async (request: any) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (!request.tools) {
        judgeCalled = true;
        expect(request.messages[1].content).toContain("Original tool #6");
        return completion(JSON.stringify({
          summary: "The judge verified the recovered execution.",
          results: [{ id: "R1", claim, verdict: "verified", reproduced_value: "0.91", evidence }],
        }));
      }
      turn++;
      if (turn === 1) return completion(null, [
         call("paper-first", "read_file", { path: "/work/paper.md", max_chars: 6000 }),
        call("inventory", "list_files", { path: "/work" }),
      ]);
      if (turn === 2) return completion(null, [call("archive-index", "read_reproduction_context", {})]);
      if (turn === 3) return completion('{"notice":"Archived unchanged; not scientific evidence."}');
      if (turn === 4) return completion(null, [
         call("paper-targeted", "read_file", { path: "/work/paper.md", offset: 12000, max_chars: 5000 }),
      ]);
      if (turn === 5) return completion('{"notice":"Retrieval only; this is not scientifically valid evidence."}');
      if (turn === 6) {
        expect(JSON.stringify(request)).toContain("LATEST ACTION — EXTRACT");
        return completion(null, [call("register-actual", "record_result", {
          id: "R1", claim, status: "pending", original_value: "0.91",
          ...sourceArgs(1, browsingPaper),
        })]);
      }
      if (turn === 7) return completion('{"notice":"Archived unchanged; not scientific evidence."}');
      if (turn === 8) {
        expect(JSON.stringify(request)).toContain("LATEST ACTION — PREPARE/EXECUTE");
        return completion(null, [call("actual-experiment", "run_command", { command: "python /work/materials/expensive.py" })]);
      }
      if (turn === 9) {
        expect(JSON.stringify(request)).toContain("LATEST ACTION — ASSESS/RECORD");
        return completion(null, [call("valid-record", "record_result", {
          id: "R1", status: "verified", method: "rerun", reproduced_value: "0.91",
          evidence_tool_call_ids: [6], evidence_excerpt: evidence,
        })]);
      }
      expect(JSON.stringify(request)).toContain("LATEST ACTION — REPORT");
      return completion(recoveredLogbook);
    });

    const result = await runReproduction(options());
    expect(result.overall).toBe("verified");
    expect(result.toolCallCount).toBe(7);
    expect(judgeCalled).toBe(true);
    expect(sb.exec.mock.calls.filter(([argv]) => argv.join(" ").includes("expensive.py"))).toHaveLength(1);
    expect(requests.some(request =>
      request.tools
      && !JSON.stringify(request).includes("PAPER_SEARCH_TAIL")
      && JSON.stringify(request).includes("LATEST ACTION —"),
    )).toBe(true);
  });

  it("bounds a zero-claim reading-only agent without running commands or judging", async () => {
    const sb = sandbox();
    sb.readText.mockResolvedValue("different page ".repeat(2000));
    createSandbox.mockResolvedValue(sb);
    let turn = 0;
    createCompletion.mockImplementation(async (request: any) => {
      expect(request.tools).toBeDefined();
      turn++;
      if (turn === 1) return completion(null, [
        call("read-a", "read_file", { path: "/work/paper.md", offset: 0, max_chars: 5000 }),
        call("list-a", "list_files", { path: "/work" }),
      ]);
      if (turn === 2) return completion(null, [
        call("read-b", "read_file", { path: "/work/paper.md", offset: 12000, max_chars: 5000 }),
        call("context-a", "read_reproduction_context", {}),
      ]);
      expect(JSON.stringify(request)).toContain("LATEST ACTION — EXTRACT");
      return completion('{"notice":"Archived unchanged; not scientific evidence."}');
    });

    const error = await runReproduction(options()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/no-progress/);
    expect(turn).toBe(5); // two browsing turns, then the initial stop plus two bounded recoveries
    expect(sb.exec).toHaveBeenCalledTimes(1); // environment probe only
    expect(createCompletion.mock.calls.every(([request]) => request.tools)).toBe(true);
  });

  it("stops an unrecoverable registration loop with private bounded diagnostics, no judge, and preserves the original failure over cleanup failure", async () => {
    const sb = sandbox();
    const cleanupError = new Error("cleanup error must not mask completion error");
    sb.terminate.mockRejectedValue(cleanupError);
    createSandbox.mockResolvedValue(sb);
    let turn = 0;
    createCompletion.mockImplementation(async (request: any) => {
      expect(request.tools).toBeDefined();
      turn++;
      if (turn === 1) return completion(null, [
        call("paper-source", "read_file", { path: "/work/paper.md", max_chars: 6000 }),
        call("register", "record_result", { id: "R1", claim, status: "pending", ...sourceArgs(1) }),
      ]);
      if (turn === 2) return completion(null, [
        call("duplicate", "record_result", { id: "R1", status: "pending" }),
        rawCall("malformed", "run_command", '{"command":'),
        call("invalid", "record_result", { id: "R1", status: ["verified"] }),
      ]);
      if (turn === 3) return completion(null, [call("truncated", "run_command", { command: "python should-not-run.py" })], "length");
      expect(JSON.stringify(request)).toContain("LATEST ACTION — PREPARE/EXECUTE");
      return completion("I am finished. api_key=synthetic-secret-value Authorization: Bearer synthetic-bearer-token");
    });
    const error = await runReproduction(options()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBe(cleanupError);
    expect((error as Error).message).toMatch(/stopped before completing required work.*no-progress/);
    const diagnostics = getReproductionFailureDiagnostics(error);
    expect(diagnostics).toBeDefined();
    expect(diagnostics).toMatchObject({ stopReason: "no-progress", stage: "completion", callCount: 6 });
    expect(diagnostics!.claims).toEqual([expect.objectContaining({ id: "R1", status: "pending" })]);
    expect(diagnostics!.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ argumentParse: "invalid-json" }),
      expect.objectContaining({ argumentParse: "invalid-schema" }),
      expect.objectContaining({ argumentParse: "truncated", finishReason: "length" }),
      expect.objectContaining({ kind: "cleanup-failed" }),
    ]));
    const serialized = JSON.stringify(diagnostics);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(24000);
    expect(serialized).not.toContain("synthetic-secret-value");
    expect(serialized).not.toContain("synthetic-bearer-token");
    expect(serialized).toContain("REDACTED");
    expect(turn).toBeLessThan(REPRODUCTION_BUDGET.maxToolCalls);
    expect(sb.exec).toHaveBeenCalledTimes(1); // environment probe only
    expect(sb.terminate).toHaveBeenCalledTimes(1);
  });

  it("still tears down and rethrows the original emit failure if diagnostic capture and cleanup both fail", async () => {
    const sb = sandbox();
    createSandbox.mockResolvedValue(sb);
    sb.terminate.mockRejectedValue(new Error("secondary cleanup failure"));
    vi.spyOn(ReproductionDiagnostics.prototype, "claims").mockImplementation(() => { throw new Error("capture unavailable"); });
    vi.spyOn(ReproductionDiagnostics.prototype, "snapshot").mockImplementation(() => { throw new Error("snapshot unavailable"); });
    const original = new Error("event sink failed");
    const opts = options();
    opts.emitEvent.mockImplementation(async (phase, message) => {
      if (phase === "reproduction-sandbox" && message.includes("ready.")) throw original;
    });
    await expect(runReproduction(opts)).rejects.toBe(original);
    expect(sb.terminate).toHaveBeenCalledTimes(1);
    expect(createCompletion).not.toHaveBeenCalled();
  });
});