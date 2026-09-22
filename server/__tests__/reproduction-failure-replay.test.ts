import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { runReproduction, REPRODUCTION_BUDGET } from "../reproduce";
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
const sourceArgs = (sourceToolCallId: number, end = PAPER.length) => ({
  source_quote: claim,
  source_location: `characters 0-${end}`,
  source_tool_call_id: sourceToolCallId,
});
const completion = (content: string | null, calls?: unknown[], finishReason = calls ? "tool_calls" : "stop") => ({
  choices: [{ message: { content, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: finishReason }],
});
const rawCall = (id: string, name: string, raw: string) => ({
  id, type: "function", function: { name, arguments: raw },
});
const call = (id: string, name: string, args: Record<string, unknown>) =>
  rawCall(id, name, JSON.stringify(args));

function options() {
  const config = { providerMode: "platform" as const, provider: "openrouter", modelName: "deepseek/deepseek-chat" };
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
  vi.stubEnv("OPENROUTER_API_KEY", "synthetic-test-key");
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
          call("paper-source", "read_file", { path: "/work/paper.md", max_chars: 40000 }),
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
    sb.readText.mockImplementation(async (path: string) => path === "/work/paper.md"
      ? `${PAPER}\n${"paper search page with reported values\n".repeat(1000)}PAPER_SEARCH_TAIL`
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
        call("paper-first", "read_file", { path: "/work/paper.md", max_chars: 40000 }),
        call("inventory", "list_files", { path: "/work" }),
      ]);
      if (turn === 2) return completion(null, [call("archive-index", "read_reproduction_context", {})]);
      if (turn === 3) return completion('{"notice":"Archived unchanged; not scientific evidence."}');
      if (turn === 4) return completion(null, [
        call("paper-targeted", "read_file", { path: "/work/paper.md", offset: 12000, max_chars: 20000 }),
      ]);
      if (turn === 5) return completion('{"notice":"Retrieval only; this is not scientifically valid evidence."}');
      if (turn === 6) {
        expect(JSON.stringify(request)).toContain("LATEST ACTION — EXTRACT");
        return completion(null, [call("register-actual", "record_result", {
          id: "R1", claim, status: "pending", original_value: "0.91",
          ...sourceArgs(1, 40000),
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
        call("read-a", "read_file", { path: "/work/paper.md", offset: 0 }),
        call("list-a", "list_files", { path: "/work" }),
      ]);
      if (turn === 2) return completion(null, [
        call("read-b", "read_file", { path: "/work/paper.md", offset: 12000 }),
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
        call("paper-source", "read_file", { path: "/work/paper.md", max_chars: 40000 }),
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