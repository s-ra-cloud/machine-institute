import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// The reproduction module imports the application storage through its paper
// context dependencies. None of these orchestration tests should touch a DB.
vi.mock("../storage", () => ({ storage: {} }));
vi.mock("../ethics-review", () => ({ loadPaperContext }));
vi.mock("../fs-materials", () => ({
  fetchContributionMaterials,
  materialSandboxPath: (file: { name: string }) => `/work/materials/${file.name}`,
  formatMaterialsInventory: () => "- /work/materials/reproduce.py (py, 0.1 KB)",
}));
vi.mock("../modal-sandbox", () => ({
  isModalConfigured: () => true,
  ReproductionSandbox: { create: createSandbox },
}));
vi.mock("../provider-credit-preflight", () => ({ assertReproductionRuntimeProviderCredits }));

import { REPRODUCTION_BUDGET } from "../reproduce";
import { runLegacyBaseline as runReproduction } from "./legacy-reproduction-baseline";
import { buildEffectiveReproducerPrompt } from "../prompts/reproduce";
import { getReproductionFailureDiagnostics } from "../reproduction-diagnostics";
import type { ModelProviderConfig } from "../model-service";

const config: ModelProviderConfig = {
  providerMode: "platform",
  provider: "openai",
  modelName: "openai/gpt-4o",
};

const logbook = [
  "## Claims",
  "Every extracted claim has an accepted final status.",
  "## Reproduction Log",
  "The shipped commands were executed and their original outputs were cited.",
  "## Discrepancies",
  "The reproduced values were compared with the reported values.",
  "## Limitations",
  "The sandbox and supplied materials define the scope of this run.",
].join("\n");

const completion = (content: string | null, toolCalls?: unknown[]) => ({
  choices: [{
    finish_reason: toolCalls ? "tool_calls" : "stop",
    message: {
      content,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    },
  }],
});

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

const claims = ["R1 claim", "R2 claim", "R3 claim", "R4 claim", "R5 claim", "Data-dependent result requires data.csv", "Full model result"];
const sourceQuote = (claim: string) => `The paper states that ${claim} is a core quantitative result.`;
const PAPER = `# Shipped paper\n\n${claims.map(sourceQuote).join("\n")}`;
const sourceRead = () => call("paper-source", "read_file", { path: "/work/paper.md", max_chars: 40000 });
const pendingCall = (id: string, claim = `${id} claim`, sourceToolCallId = 1) =>
  call(`pending-${id}`, "record_result", {
    id, claim, status: "pending", source_quote: sourceQuote(claim),
    source_location: `characters 0-${PAPER.length}`, source_tool_call_id: sourceToolCallId,
  });

const judgeCompletion = (
  ids: string[] = ["R1"],
  verdict: "verified" | "inconclusive" = "verified",
  reproducedValues: Record<string, string> = {},
) => completion(JSON.stringify({
  summary: "The accepted claims were independently checked.",
  results: ids.map(id => ({
    id,
    claim: `${id} claim`,
    verdict,
    original_value: "reported",
    reproduced_value: reproducedValues[id] ?? "reproduced",
    evidence: "The shipped command output supports this result.",
    confidence: "high",
  })),
}));

function makeSandbox() {
  let terminated = false;
  const files = new Map<string, string>();
  const lifecycle = {
    sandboxId: "sandbox-repair-test",
    image: "test-image",
    writeText: vi.fn(async (path: string, content: string) => {
      if (terminated) throw new Error("sandbox used after termination");
      files.set(path, content);
    }),
    exec: vi.fn(async (command: string[]) => {
      if (terminated) throw new Error("sandbox used after termination");
      const text = command.join(" ");
      if (text.includes("nvidia-smi")) {
        return { stdout: "Test GPU, 16 GB\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
      }
      if (text.includes("bad-r4")) {
        return { stdout: "wrong command failed", stderr: "", exitCode: 1, timedOut: false, durationMs: 1 };
      }
      if (text.includes("r4-correct")) {
        return { stdout: "R4 output=4.2", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
      }
      if (text.includes("missing-material")) {
        return { stdout: "No such file: data.csv", stderr: "", exitCode: 1, timedOut: false, durationMs: 1 };
      }
      if (text.includes("oom")) {
        return { stdout: "CUDA out of memory", stderr: "", exitCode: 1, timedOut: false, durationMs: 1 };
      }
      if (text.includes("timeout-command")) {
        return { stdout: "", stderr: "", exitCode: null, timedOut: true, durationMs: 1 };
      }
      if (text.includes("expensive")) {
        return { stdout: "expensive output metric=0.91", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
      }
      if (text.includes("r2")) return { stdout: "R2 accuracy=0.82", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
      if (text.includes("r3")) return { stdout: "R3 loss=0.10", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
      if (text.includes("r5")) return { stdout: "R5 score=0.77", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
      return { stdout: "exit-success", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
    }),
    listFiles: vi.fn(async () => []),
    readText: vi.fn(async (path: string) => files.get(path) ?? ""),
    terminate: vi.fn(async () => {
      terminated = true;
    }),
  };
  return lifecycle;
}

function setupContext() {
  loadPaperContext.mockResolvedValue({
    title: "A Reproduction Repair Paper",
    authors: "Test Authors",
    date: "2026",
    abstract: "A short abstract.",
    url: "https://example.test/paper",
    fullText: "# Paper\n\nThe paper reports five claims.",
    fsAbstracts: [],
  });
  fetchContributionMaterials.mockResolvedValue({
    documentId: "paper-1",
    files: [{
      name: "reproduce.py",
      url: "https://example.test/reproduce.py",
      ext: "py",
      mime: "text/plain",
      kind: "text",
      source: "additional",
      text: "print('test')",
      bytes: 13,
    }, {
      name: "README.md", url: "https://example.test/README.md", ext: "md", mime: "text/markdown",
      kind: "text", source: "additional", text: "Run the supplied reproduction.", bytes: 31,
    }, ...[
      "expensive.py", "r2.py", "r3.py", "bad-r4.py", "r5.py", "r4-correct.py",
      "timeout-command.py", "deadline-command.py", "oom.py",
      ...Array.from({ length: REPRODUCTION_BUDGET.maxToolCalls }, (_, index) => `budget-${index}.py`),
      ...Array.from({ length: REPRODUCTION_BUDGET.maxToolCalls }, (_, index) => `fallback-${index}.py`),
    ].map(name => ({
      name, url: `https://example.test/${name}`, ext: "py", mime: "text/plain",
      kind: "text" as const, source: "additional" as const, text: "print('test')", bytes: 13,
    }))],
    readme: "Run the supplied reproduction.",
    paperMarkdown: PAPER,
    textFileCount: 2,
    binaryFileCount: 0,
    totalTextBytes: 13,
  });
}

function options(reproducerPrompt = "CUSTOM SAVED REPAIR INSTRUCTION") {
  return {
    reproductionId: "repro-1",
    projectId: "project-1",
    journalId: "journal-1",
    initiativeDocId: "initiative-1",
    initiativeSlug: "initiative",
    journalDisplayName: "Test Journal",
    documentId: "paper-1",
    paperTitle: "A Reproduction Repair Paper",
    reproducerPrompt,
    judgePrompt: "Judge this reproduction.",
    modelConfig: config,
    judgeModelConfig: config,
    gpu: "T4" as const,
    emitEvent: vi.fn(async (_phase: string, _message: string) => {}),
  };
}

beforeEach(() => {
  createCompletion.mockReset();
  createSandbox.mockReset();
  loadPaperContext.mockReset();
  fetchContributionMaterials.mockReset();
  vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_API_KEY", "test-key");
  vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", "https://managed.example.test");
  vi.stubEnv("LAB_ALLOWED_MODELS", "openai/gpt-4o");
  setupContext();
});

afterEach(() => {
  // In particular, do not let a failed deadline assertion leave Date.now
  // mocked for the following orchestration scenario.
  vi.restoreAllMocks();
});

describe("runReproduction provider funding failures", () => {
  it("replays the eight-call failure without misclassifying payment or repeating paid work", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    createCompletion
      .mockResolvedValueOnce(completion(null, [sourceRead()]))
      .mockResolvedValueOnce(completion(null, [call("page", "read_file", { path: "/work/paper.md", offset: 100 })]))
      .mockResolvedValueOnce(completion(null, [call("eof", "read_file", { path: "/work/paper.md", offset: 24000 })]))
      .mockResolvedValueOnce(completion(null, [call("inventory", "read_file", { path: "/work/MATERIALS_INDEX.md" })]))
      .mockResolvedValueOnce(completion(null, [call("recover-1", "read_tool_result", { tool_call_id: 1 })]))
      .mockResolvedValueOnce(completion(null, [call("recover-2", "read_tool_result", { tool_call_id: 2 })]))
      .mockResolvedValueOnce(completion(null, [pendingCall("R1"), pendingCall("R2")]))
      .mockRejectedValueOnce(Object.assign(new Error(
        "This request would exceed your credits; use fewer max_tokens. PRIVATE_PROVIDER_BODY",
      ), { status: 402 }));
    const opts = options();
    const error = await runReproduction(opts).catch(error => error);
    expect(error).toMatchObject({ code: "PROVIDER_PAYMENT_REQUIRED", status: 402 });
    const snapshot = getReproductionFailureDiagnostics(error);
    expect(snapshot).toMatchObject({ stage: "tool-loop", stopReason: "provider-payment", rounds: 8, callCount: 8 });
    expect(snapshot?.claims).toEqual([
      expect.objectContaining({ id: "R1", status: "pending" }),
      expect.objectContaining({ id: "R2", status: "pending" }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_PROVIDER_BODY");
    expect(error.message).not.toContain("PRIVATE_PROVIDER_BODY");
    expect(opts.emitEvent.mock.calls.some(([phase]) => phase === "reproduction-context")).toBe(false);
    expect(createCompletion).toHaveBeenCalledTimes(8);
    expect(sandbox.exec).toHaveBeenCalledTimes(1); // Environment probe only.
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
  });

  it("does not publish a self-graded report when the judge is refused for payment", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    createCompletion
      .mockResolvedValueOnce(completion(null, [sourceRead(), pendingCall("R1")]))
      .mockResolvedValueOnce(completion(null, [call("experiment", "run_command", { command: "python /work/materials/expensive.py" })]))
      .mockResolvedValueOnce(completion(null, [call("result", "record_result", {
        id: "R1", status: "verified", reproduced_value: "0.91", method: "rerun",
        evidence_tool_call_ids: [3], evidence_excerpt: "expensive output metric=0.91",
      })]))
      .mockResolvedValueOnce(completion(logbook))
      .mockRejectedValueOnce(Object.assign(new Error("Insufficient credits"), { status: 402 }));
    const error = await runReproduction(options()).catch(error => error);
    expect(error).toMatchObject({ code: "PROVIDER_PAYMENT_REQUIRED", status: 402 });
    expect(getReproductionFailureDiagnostics(error)).toMatchObject({ stage: "judge", stopReason: "provider-payment" });
    expect(createCompletion).toHaveBeenCalledTimes(5);
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
  });
});

describe("runReproduction orchestration repair", () => {
  it("repairs accepted claims with real tools, preserves rejected state, and judges only after validation", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);

    const pending = [sourceRead(), ...["R1", "R2", "R3", "R4", "R5"].map(id => pendingCall(id))];
    const commands = [
      call("expensive", "run_command", { command: "python /work/materials/expensive.py" }),
      call("r2", "run_command", { command: "python /work/materials/r2.py" }),
      call("r3", "run_command", { command: "python /work/materials/r3.py" }),
      call("bad-r4", "run_command", { command: "python /work/materials/bad-r4.py" }),
      call("r5", "run_command", { command: "python /work/materials/r5.py" }),
    ];
    const rejectedAndAccepted = [
      call("bad-r1-final", "record_result", {
        id: "R1", status: "verified", reproduced_value: "0.91", method: "rerun",
        evidence_tool_call_ids: [7], evidence_excerpt: "expensive output",
      }),
      call("bad-r4-final", "record_result", {
        id: "R4", status: "falsified", reproduced_value: "4.2", method: "rerun",
        evidence_tool_call_ids: [10], evidence_excerpt: "wrong command failed",
      }),
      call("r2-final", "record_result", {
        id: "R2", status: "verified", reproduced_value: "0.82", method: "rerun",
        evidence_tool_call_ids: [8], evidence_excerpt: "R2 accuracy=0.82",
      }),
      call("r3-final", "record_result", {
        id: "R3", status: "verified", reproduced_value: "0.10", method: "rerun",
        evidence_tool_call_ids: [9], evidence_excerpt: "R3 loss=0.10",
      }),
      call("r5-final", "record_result", {
        id: "R5", status: "verified", reproduced_value: "0.77", method: "rerun",
        evidence_tool_call_ids: [11], evidence_excerpt: "R5 score=0.77",
      }),
    ];
    const corrections = [
      call("read-expensive", "read_tool_result", { tool_call_id: 7, offset: 0, max_chars: 8000 }),
    ];
    const r4Run = call("r4-correct", "run_command", { command: "python /work/materials/r4-correct.py" });
    const finalCorrections = [
      call("r1-final", "record_result", {
        id: "R1", status: "verified", reproduced_value: "0.91", method: "rerun",
        evidence_tool_call_ids: [7], evidence_excerpt: "metric=0.91",
      }),
      call("r4-final", "record_result", {
        id: "R4", status: "verified", reproduced_value: "4.2", method: "rerun",
        evidence_tool_call_ids: [18], evidence_excerpt: "R4 output=4.2",
      }),
    ];

    // Blank responses are deliberately interleaved with productive calls. The
    // progress high-water mark must permit more than two total recoveries while
    // still bounding a genuinely stuck agent.
    createCompletion
      .mockResolvedValueOnce(completion(null, pending))
      .mockResolvedValueOnce(completion(""))
      .mockResolvedValueOnce(completion(null, commands))
      .mockResolvedValueOnce(completion(""))
      .mockResolvedValueOnce(completion(null, rejectedAndAccepted))
      .mockResolvedValueOnce(completion(""))
      .mockResolvedValueOnce(completion(null, corrections))
      .mockResolvedValueOnce(completion(""))
      .mockResolvedValueOnce(completion(null, [r4Run]))
      .mockResolvedValueOnce(completion(""))
      .mockResolvedValueOnce(completion(null, finalCorrections))
      .mockResolvedValueOnce(completion(""))
      .mockResolvedValueOnce(completion(logbook))
      .mockResolvedValueOnce(judgeCompletion(["R1", "R2", "R3", "R4", "R5"]));

    const result = await runReproduction(options());

    expect(result.counts.total).toBe(5);
    expect(result.results.map(r => r.id)).toEqual(["R1", "R2", "R3", "R4", "R5"]);
    expect(result.stoppedBy).toBe("model");
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
    expect(sandbox.exec.mock.calls.some(args => String(args[0]).includes("expensive.py"))).toBe(true);
    expect(sandbox.exec.mock.calls.filter(args => String(args[0]).includes("expensive.py"))).toHaveLength(1);
    expect(sandbox.exec.mock.calls.some(args => String(args[0]).includes("r4-correct.py"))).toBe(true);
    expect(Math.max(...sandbox.exec.mock.invocationCallOrder)).toBeLessThan(sandbox.terminate.mock.invocationCallOrder[0]);
    expect(sandbox.terminate.mock.invocationCallOrder[0]).toBeLessThan(createCompletion.mock.invocationCallOrder.at(-1)!);
    expect(createCompletion).toHaveBeenCalledTimes(14);

    const firstRequest = createCompletion.mock.calls[0][0];
    expect(firstRequest.messages[0].content).toContain("CUSTOM SAVED REPAIR INSTRUCTION");
    expect(firstRequest.messages[0].content).toContain("# Mandatory runtime evidence and completion contract");
    expect(firstRequest.messages[0].content).toContain("read_tool_result");
    const rejected = createCompletion.mock.calls.find((entry: any[]) =>
      entry[0]?.messages?.some((message: any) => String(message.content).includes("Refused finalization of R1")),
    );
    expect(rejected).toBeDefined();
    expect(createCompletion.mock.calls.some((entry: any[]) =>
      entry[0]?.messages?.some((message: any) => String(message.content).includes("Accepted state remains pending")),
    )).toBe(true);
    expect(createCompletion.mock.calls.at(-1)?.[0].messages[0].content).toBe("Judge this reproduction.");
  });

  it("fails a no-progress repair without judging and terminates exactly once", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    createCompletion
      .mockResolvedValueOnce(completion(null, [sourceRead(), pendingCall("R1")]))
      .mockResolvedValueOnce(completion(""))
      .mockResolvedValueOnce(completion(""))
      .mockResolvedValueOnce(completion(""));

    await expect(runReproduction(options())).rejects.toThrow(/no-progress|before completing required work/);
    expect(createCompletion).toHaveBeenCalledTimes(4);
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
    expect(createCompletion.mock.calls.every((entry: any[]) => entry[0]?.messages?.[0]?.content !== "Judge this reproduction.")).toBe(true);
  });

  it("compacts old tool output, then recovers the original command with read_tool_result", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    sandbox.readText.mockImplementation(async (path: string) =>
      path === "/work/paper.md" ? PAPER : "bulk-read-output-".repeat(900));

    const requestSnapshots: any[][] = [];
    let agentCalls = 0;
    createCompletion.mockImplementation(async (request: any) => {
      // OpenAI request objects are retained and their messages are mutated by
      // later compaction rounds. Snapshot at invocation, not via mock.calls
      // after the loop has finished.
      requestSnapshots.push(JSON.parse(JSON.stringify(request.messages)));
      if (!request.tools) {
        return judgeCompletion(["R1"], "verified", { R1: "0.91" });
      }
      agentCalls++;
      if (agentCalls === 1) {
        return completion(null, [
          sourceRead(), pendingCall("R1"),
        ]);
      }
      if (agentCalls === 2) {
        return completion(null, [
          call("expensive", "run_command", { command: "python /work/materials/expensive.py" }),
        ]);
      }
      // Seventeen default read_file results are over 192k characters, which
      // exceeds the 64k-model context budget (the loop's 3x character budget).
      if (agentCalls <= 19) {
        return completion(null, [
          call(`bulk-${agentCalls}`, "read_file", { path: `/work/materials/bulk-${agentCalls}.txt` }),
        ]);
      }
      if (agentCalls === 20) {
        return completion(null, [
          call("recover", "read_tool_result", { tool_call_id: 3, offset: 0, max_chars: 8000 }),
        ]);
      }
      if (agentCalls === 21) {
        return completion(null, [
          call("final", "record_result", {
            id: "R1", status: "verified", reproduced_value: "0.91", method: "rerun",
            evidence_tool_call_ids: [3], evidence_excerpt: "EXPENSIVE_METRIC=0.91",
          }),
        ]);
      }
      return completion(logbook);
    });
    sandbox.exec.mockImplementation(async (command: string[]) => {
      if (command.join(" ").includes("nvidia-smi")) {
        return { stdout: "Test GPU, 16 GB\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
      }
      return { stdout: "expensive output EXPENSIVE_METRIC=0.91", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
    });

    const result = await runReproduction(options());

    expect(result.results[0]).toMatchObject({ id: "R1", verdict: "verified", reproducedValue: "0.91" });
    expect(sandbox.exec.mock.calls.filter(args => String(args[0]).includes("expensive.py"))).toHaveLength(1);
    expect(requestSnapshots.some(messages => messages.some((message: any) =>
      message.role === "tool"
       && String(message.content).includes("[Tool call #3]\n[Earlier output elided. Use read_tool_result with the original tool call ID"),
    ))).toBe(true);
    const recoveryRequest = requestSnapshots[20];
    expect(recoveryRequest.some((message: any) =>
      message.role === "tool"
       && String(message.content).includes("Original evidence tool call #3")
      && String(message.content).includes("EXPENSIVE_METRIC=0.91"),
    )).toBe(true);
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
  });

  it("preserves a deep source metric for judge evidence after paged recovery", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    const metric = "DISTINCTIVE_METRIC=0.9137";
    const stdout = `${"A".repeat(17_000)}${metric}${"B".repeat(17_000)}`;
    sandbox.exec.mockImplementation(async (command: string[]) => {
      if (command.join(" ").includes("nvidia-smi")) {
        return { stdout: "Test GPU, 16 GB\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
      }
      return { stdout, stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
    });

    const requestSnapshots: any[][] = [];
    let agentCalls = 0;
    let judgeRequest: any;
    createCompletion.mockImplementation(async (request: any) => {
      const snapshot = JSON.parse(JSON.stringify(request));
      requestSnapshots.push(snapshot.messages);
      if (!request.tools) {
        judgeRequest = snapshot;
        return judgeCompletion(["R1"], "verified", { R1: "0.9137" });
      }
      agentCalls++;
      if (agentCalls === 1) {
        return completion(null, [
          sourceRead(), pendingCall("R1"),
        ]);
      }
      if (agentCalls === 2) {
        return completion(null, [
          call("expensive", "run_command", { command: "python /work/materials/expensive.py" }),
        ]);
      }
      if (agentCalls === 3) {
        // The metric is deliberately in the middle of the source output,
        // requiring a page rather than relying on the elided model result.
        return completion(null, [
          call("recover-page", "read_tool_result", { tool_call_id: 3, offset: 16_000, max_chars: 8_000 }),
        ]);
      }
      if (agentCalls === 4) {
        return completion(null, [
          call("final", "record_result", {
            id: "R1", status: "verified", reproduced_value: "0.9137", method: "rerun",
            evidence_tool_call_ids: [3], evidence_excerpt: metric,
          }),
        ]);
      }
      return completion(logbook);
    });

    const result = await runReproduction(options());

    expect(result.results[0]).toMatchObject({ id: "R1", verdict: "verified", reproducedValue: "0.9137" });
    expect(sandbox.exec.mock.calls.filter(args => String(args[0]).includes("expensive.py"))).toHaveLength(1);
    const initialCommandRequest = requestSnapshots[2];
    const initialCommandTool = initialCommandRequest.find((message: any) =>
      message.role === "tool" && String(message.content).includes("[Tool call #3]"),
    );
    expect(initialCommandTool).toBeDefined();
    expect(String(initialCommandTool.content)).not.toContain(metric);
    const recoveryRequest = requestSnapshots[3];
    expect(recoveryRequest.some((message: any) =>
      message.role === "tool"
      && String(message.content).includes("Original evidence tool call #3")
      && String(message.content).includes(metric),
    )).toBe(true);

    const judgeInput = String(judgeRequest.messages[1].content);
    const originalEvidence = judgeInput.split("# ORIGINAL CITED TOOL OUTPUTS (server-extracted, before chronological transcript truncation)")[1]
      .split("# TOOL TRANSCRIPT")[0];
    const transcript = judgeInput.split("# TOOL TRANSCRIPT")[1];
    expect(originalEvidence).toContain("Original tool #3");
    expect(originalEvidence).toContain(metric);
    expect(originalEvidence).toContain("Output status: exit code 0");
    expect(originalEvidence).toContain('"command":"python /work/materials/expensive.py"');
    expect(transcript.slice(0, 3_000)).not.toContain(metric);
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
  });
});

describe("runReproduction enforced resource stops", () => {
  it("turns a pending claim into honest inconclusive evidence after a command crosses the deadline", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    const now = vi.spyOn(Date, "now");
    let clock = 1_000;
    now.mockImplementation(() => clock);
    sandbox.exec.mockImplementation(async (command: string[]) => {
      if (command.join(" ").includes("nvidia-smi")) {
        return { stdout: "Test GPU, 16 GB\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
      }
      clock = 1_000 + REPRODUCTION_BUDGET.wallClockMs + 1;
      return { stdout: "", stderr: "", exitCode: null, timedOut: true, durationMs: 1 };
    });
    createCompletion
      .mockResolvedValueOnce(completion(null, [
        sourceRead(), pendingCall("R1"),
      ]))
      .mockResolvedValueOnce(completion(null, [
        call("timeout", "run_command", { command: "python /work/materials/timeout-command.py" }),
      ]))
      .mockResolvedValueOnce(completion(logbook))
      .mockResolvedValueOnce(judgeCompletion(["R1"], "inconclusive"));

    const result = await runReproduction(options());

    expect(result.stoppedBy).toBe("deadline");
    expect(result.results[0]).toMatchObject({ id: "R1", verdict: "inconclusive" });
    expect(sandbox.exec.mock.calls.filter(args => !String(args[0]).includes("nvidia-smi"))).toHaveLength(1);
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
  });

  it("falls back deterministically when the forced-final reproducer call fails after a deadline", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    const now = vi.spyOn(Date, "now");
    let clock = 1_000;
    now.mockImplementation(() => clock);
    sandbox.exec.mockImplementation(async (command: string[]) => {
      if (command.join(" ").includes("nvidia-smi")) {
        return { stdout: "Test GPU, 16 GB\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
      }
      clock = 1_000 + REPRODUCTION_BUDGET.wallClockMs + 1;
      return { stdout: "command completed before claim finalization", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
    });

    let agentCalls = 0;
    let forcedFinalAttempted = false;
    let judgeRequest: any;
    createCompletion.mockImplementation(async (request: any) => {
      if (request.messages[0]?.content === "Judge this reproduction.") {
        judgeRequest = JSON.parse(JSON.stringify(request));
        return judgeCompletion(["R1"], "inconclusive");
      }
      agentCalls++;
      if (agentCalls === 1) {
        return completion(null, [
          sourceRead(), pendingCall("R1"),
        ]);
      }
      if (agentCalls === 2) {
        return completion(null, [
          call("command", "run_command", { command: "python /work/materials/deadline-command.py" }),
        ]);
      }
      forcedFinalAttempted = true;
      throw new Error("forced-final reproducer request failed");
    });

    const result = await runReproduction(options());

    expect(forcedFinalAttempted).toBe(true);
    expect(result.stoppedBy).toBe("deadline");
    expect(result.results[0]).toMatchObject({ id: "R1", verdict: "inconclusive" });
    expect(result.logbook).toContain("System-generated resource-stop summary");
    expect(judgeRequest).toBeDefined();
    const proposalsText = String(judgeRequest.messages[1].content).match(
      /# AGENT'S RECORDED RESULTS \(proposals, not verdicts\)\n([\s\S]*?)\n\n# AGENT'S LOGBOOK/,
    )?.[1];
    const proposals = JSON.parse(proposalsText!);
    expect(proposals[0]).toMatchObject({
      id: "R1",
      status: "inconclusive",
      method: "blocked",
      blockerKind: "budget",
      evidenceToolCallIds: [],
    });
    expect(sandbox.exec.mock.calls.filter(args => !String(args[0]).includes("nvidia-smi"))).toHaveLength(1);
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
  });

  it("finalizes pending work when the fixed tool budget is exhausted without another command", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    const calls = [
      sourceRead(), pendingCall("R1"),
      ...Array.from({ length: REPRODUCTION_BUDGET.maxToolCalls }, (_, index) =>
        call(`command-${index}`, "run_command", { command: `python /work/materials/budget-${index}.py` }),
      ),
    ];
    createCompletion
      .mockResolvedValueOnce(completion(null, calls))
      .mockResolvedValueOnce(completion(logbook))
      .mockResolvedValueOnce(judgeCompletion(["R1"], "inconclusive"));

    const result = await runReproduction(options());

    expect(result.stoppedBy).toBe("tool-budget");
    expect(result.results[0]).toMatchObject({ id: "R1", verdict: "inconclusive" });
    expect(sandbox.exec.mock.calls.filter(args => !String(args[0]).includes("nvidia-smi"))).toHaveLength(REPRODUCTION_BUDGET.maxToolCalls - 2);
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
  });

  it("uses the structured fallback logbook when budget exhaustion leaves the logbook empty", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    const calls = [
      sourceRead(), pendingCall("R1"),
      ...Array.from({ length: REPRODUCTION_BUDGET.maxToolCalls }, (_, index) =>
        call(`command-${index}`, "run_command", { command: `python /work/materials/fallback-${index}.py` }),
      ),
    ];
    let judgeRequest: any;
    createCompletion
      .mockResolvedValueOnce(completion(null, calls))
      .mockResolvedValueOnce(completion(""))
      .mockImplementationOnce(async (request: any) => {
        judgeRequest = JSON.parse(JSON.stringify(request));
        return judgeCompletion(["R1"], "inconclusive");
      });

    const result = await runReproduction(options());

    expect(result.stoppedBy).toBe("tool-budget");
    expect(result.logbook).toContain("System-generated resource-stop summary");
    const judgeUserMessage = String(judgeRequest.messages[1].content);
    const proposalsText = judgeUserMessage.match(
      /# AGENT'S RECORDED RESULTS \(proposals, not verdicts\)\n([\s\S]*?)\n\n# AGENT'S LOGBOOK/,
    )?.[1];
    expect(proposalsText).toBeTruthy();
    const proposals = JSON.parse(proposalsText!);
    expect(proposals).toEqual([expect.objectContaining({
      id: "R1",
      status: "inconclusive",
      method: "blocked",
      blockerKind: "budget",
      evidenceToolCallIds: [],
    })]);
    expect(proposals[0].evidenceToolCallIds).not.toContain(2);
    expect(result.results[0].verdict).toBe("inconclusive");
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
  });
});

describe("runReproduction concrete blockers", () => {
  it("accepts missing-material and OOM blockers with matching command evidence", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    createCompletion
      .mockResolvedValueOnce(completion(null, [
        sourceRead(),
        pendingCall("R1", "Data-dependent result requires data.csv"),
        pendingCall("R2", "Full model result"),
      ]))
      .mockResolvedValueOnce(completion(null, [
        call("inventory", "read_file", { path: "/work/MATERIALS_INDEX.md" }),
        call("readme", "read_file", { path: "/work/materials/README.md" }),
        call("missing", "list_files", { path: "/work/materials/data.csv" }),
        call("oom", "run_command", { command: "python /work/materials/oom.py" }),
      ]))
      .mockResolvedValueOnce(completion(null, [
        call("final-r1", "record_result", {
          id: "R1", status: "inconclusive", method: "blocked", blocker_kind: "missing-material",
          required_material: "data.csv", evidence: "The required data.csv was not shipped.",
          evidence_tool_call_ids: [4, 5, 6], evidence_excerpt: "(empty directory or not found)",
        }),
        call("final-r2", "record_result", {
          id: "R2", status: "inconclusive", method: "blocked", blocker_kind: "oom",
          evidence: "The full run failed with CUDA out of memory.", evidence_tool_call_ids: [7],
          evidence_excerpt: "CUDA out of memory",
        }),
      ]))
      .mockResolvedValueOnce(completion(logbook))
      .mockResolvedValueOnce(judgeCompletion(["R1", "R2"], "inconclusive"));

    const result = await runReproduction(options());

    expect(result.results).toHaveLength(2);
    expect(result.results.every(r => r.verdict === "inconclusive")).toBe(true);
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
  });
});

describe("reproducer prompt contract", () => {
  it("preserves saved instructions while appending mandatory evidence rules", () => {
    const prompt = buildEffectiveReproducerPrompt("SAVED PROMPT");
    expect(prompt).toContain("SAVED PROMPT");
    expect(prompt).toContain("# Mandatory runtime evidence and completion contract");
    expect(prompt).toContain('"Refused" means not accepted');
    expect(prompt).toContain("read_tool_result");
  });
});