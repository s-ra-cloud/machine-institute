import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Keep this stress replay at the original small serving window.
vi.mock("../../shared/model-catalog", async importOriginal => {
  const actual = await importOriginal<typeof import("../../shared/model-catalog")>();
  return { ...actual, MANAGED_MODELS: actual.MANAGED_MODELS.map(m => ({ ...m, contextWindow: 32768 })) };
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
  formatMaterialsInventory: () => "- /work/materials/reproduce.py (py, 0.1 KB)",
}));
vi.mock("../modal-sandbox", () => ({
  isModalConfigured: () => true,
  ReproductionSandbox: { create: createSandbox },
}));
vi.mock("../provider-credit-preflight", () => ({ assertReproductionRuntimeProviderCredits }));

import { REPRODUCTION_BUDGET } from "../reproduce";
import { runLegacyBaseline as runReproduction } from "./legacy-reproduction-baseline";
import { renderSourcePage } from "../reproduction-source-page";
import type { ModelProviderConfig } from "../model-service";
import { REPRODUCER_PROMPT, JUDGE_PROMPT, buildEffectiveReproducerPrompt } from "../prompts/reproduce";

const config: ModelProviderConfig = {
  providerMode: "platform",
  provider: "openai",
  modelName: "openai/gpt-4o",
};

const logbook = [
  "## Claims",
  "R1 was rerun from the shipped materials.",
  "## Reproduction Log",
  "The shipped command was executed and its original output was cited.",
  "## Discrepancies",
  "The reproduced value was compared with the reported value.",
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

const sourceQuote = (claim: string, originalValue?: string) =>
  `The paper states that ${claim} is a core quantitative result${originalValue ? ` with reported value ${originalValue}` : ""}.`;
let currentPaper = "";
const sourceRead = (offset = 0, maxChars = 40_000, id = "paper-source") =>
  call(id, "read_file", { path: "/work/paper.md", offset, max_chars: maxChars });
const groundedPending = (
  id: string, claim: string, sourceToolCallId = 1, originalValue?: string,
  offset = 0, maxChars = 40_000,
) => {
  const quote = sourceQuote(claim, originalValue);
  const page = renderSourcePage("/work/paper.md", currentPaper, offset, maxChars);
  const range = page.match(/^Returned characters: (\d+)-(\d+) of \d+$/m);
  if (!range || !page.includes(quote)) throw new Error(`Fixture quote for ${id} is not on source page`);
  return call(`pending-${id}`, "record_result", {
    id, claim, status: "pending", ...(originalValue ? { original_value: originalValue } : {}),
    source_quote: quote, source_location: `characters ${range[1]}-${range[2]}`,
    source_tool_call_id: sourceToolCallId,
  });
};

const judgeCompletion = (ids = ["R1"], values: Record<string, string> = {}) => completion(JSON.stringify({
  summary: "The bounded judge checked the accepted claims.",
  results: ids.map(id => ({
    id,
    claim: `${id} claim`,
    verdict: "verified",
    original_value: "reported",
    reproduced_value: values[id] ?? "0.91",
    evidence: "The shipped command output supports this result.",
    confidence: "high",
  })),
}));

function makeSandbox() {
  let terminated = false;
  const files = new Map<string, string>();
  const lifecycle = {
    sandboxId: "sandbox-context-test",
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
      if (text.includes("expensive")) {
        return { stdout: "EXPENSIVE_METRIC=0.91", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
      }
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

function setupContext(paperNoise = "") {
  currentPaper = `# Shipped paper\n\n${[
    "R1 claim", "R-pending claim", "R-accepted claim",
  ].map(claim => sourceQuote(claim)).join("\n")}${paperNoise}`;
  loadPaperContext.mockResolvedValue({
    title: "A Context-Safe Reproduction Paper",
    authors: "Test Authors",
    date: "2026",
    abstract: "A short abstract.",
    url: "https://example.test/paper",
    fullText: "# Paper\n\nThe paper reports one claim.",
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
      name: "expensive.py", url: "https://example.test/expensive.py", ext: "py",
      mime: "text/plain", kind: "text", source: "additional",
      text: "print('EXPENSIVE_METRIC=0.91')", bytes: 31,
    }],
    readme: "Run the supplied reproduction.",
    paperMarkdown: currentPaper,
    textFileCount: 2,
    binaryFileCount: 0,
    totalTextBytes: 13,
  });
}

function options(overrides: Partial<{
  reproducerPrompt: string;
  judgePrompt: string;
}> = {}) {
  return {
    reproductionId: "repro-context-1",
    projectId: "project-1",
    journalId: "journal-1",
    initiativeDocId: "initiative-1",
    initiativeSlug: "initiative",
    journalDisplayName: "Test Journal",
    documentId: "paper-1",
    paperTitle: "A Context-Safe Reproduction Paper",
    reproducerPrompt: overrides.reproducerPrompt ?? "CUSTOM SAVED CONTEXT INSTRUCTION",
    judgePrompt: overrides.judgePrompt ?? "Judge this reproduction.",
    modelConfig: config,
    judgeModelConfig: config,
    gpu: "T4" as const,
    emitEvent: vi.fn(async () => {}),
  };
}

function snapshotsAtInvocation() {
  const snapshots: any[] = [];
  createCompletion.mockImplementation(async (request: any) => {
    snapshots.push(JSON.parse(JSON.stringify(request)));
    return completion(logbook);
  });
  return snapshots;
}

function expectBoundedRequests(requests: readonly any[]) {
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request.max_tokens).toEqual(expect.any(Number));
    expect(
      estimateRequestTokens(request) + request.max_tokens + 1_024,
    ).toBeLessThanOrEqual(32_768);
  }
}

function requestText(request: any): string {
  return JSON.stringify(request.messages ?? []);
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
  vi.restoreAllMocks();
});

describe("runReproduction bounded context orchestration", () => {
  it("searches distant Results offsets without exposing source text, then reads the canonical quote before recording and verifying it", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    const claim = "R-search claim";
    const quote = sourceQuote(claim, "0.91");
    setupContext(`\n${"Background unrelated to the reported finding.\n".repeat(360)}\n# Results\n${"Methods and context separate heading from the actual table.\n".repeat(240)}\n| Measure | Value |\n| --- | --- |\n${quote}\n`);
    const headingOffset = currentPaper.indexOf("# Results");
    const quoteOffset = currentPaper.indexOf(quote);
    expect(headingOffset).toBeGreaterThan(12_000);
    expect(quoteOffset - headingOffset).toBeGreaterThan(12_000);
    const requests: any[] = [];
    let turn = 0;
    createCompletion.mockImplementation(async (request: any) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (!request.tools) return judgeCompletion(["R-search"]);
      turn++;
      const last = [...request.messages].reverse().find((message: any) => message.role === "tool");
      if (turn === 1) {
        expect(request.tools.map((tool: any) => tool.function.name)).toContain("search_paper");
        // The sandbox copy is mutable; searches must use the immutable loaded source.
        await sandbox.writeText("/work/paper.md", "A replaced sandbox copy with no Results or numeric result.");
        return completion(null, [call("find-heading", "search_paper", { query: "rEsUlTs" })]);
      }
      if (turn === 2) {
        const found = JSON.parse(String(last.content).replace(/^\[Tool call #\d+\]\n/, ""));
        expect(found).toMatchObject({ path: "/work/paper.md", query: "rEsUlTs", matches: [{ start: headingOffset + 2, end: headingOffset + 9 }], next_offset: null });
        expect(found.matches[0]).toEqual({ start: headingOffset + 2, end: headingOffset + 9 });
        expect(String(last.content)).not.toContain("Methods and context");
        expect(String(last.content)).not.toContain(quote);
        return completion(null, [call("find-number", "search_paper", { query: "0.91" })]);
      }
      if (turn === 3) {
        const found = JSON.parse(String(last.content).replace(/^\[Tool call #\d+\]\n/, ""));
        const numericOffset = currentPaper.indexOf("0.91", quoteOffset);
        expect(found).toMatchObject({ path: "/work/paper.md", query: "0.91", matches: [{ start: numericOffset, end: numericOffset + 4 }], next_offset: null });
        expect(String(last.content)).not.toContain(quote);
        await sandbox.writeText("/work/paper.md", currentPaper);
        return completion(null, [sourceRead(quoteOffset, quote.length, "read-found-quote")]);
      }
      if (turn === 4) {
        expect(String(last.content)).toContain(quote);
        expect(String(last.content)).toContain(`Returned characters: ${quoteOffset}-${quoteOffset + quote.length}`);
        // Search call #2 locates the number, but is NOT provenance for the quote.
        return completion(null, [groundedPending("R-search", claim, 2, "0.91", quoteOffset, quote.length)]);
      }
      if (turn === 5) {
        expect(String(last.content)).toMatch(/source_tool_call_id|read_file|Refused/i);
        return completion(null, [groundedPending("R-search", claim, 3, "0.91", quoteOffset, quote.length)]);
      }
      if (turn === 6) {
        expect(String(last.content)).toMatch(/pending/i);
        return completion(null, [call("run-found", "run_command", { command: "python /work/materials/expensive.py" })]);
      }
      if (turn === 7) {
        expect(String(last.content)).toContain("EXPENSIVE_METRIC=0.91");
        return completion(null, [call("verify-found", "record_result", {
          id: "R-search", status: "verified", method: "rerun", reproduced_value: "0.91",
          evidence_tool_call_ids: [6], evidence_excerpt: "EXPENSIVE_METRIC=0.91",
        })]);
      }
      expect(String(last.content)).toMatch(/verified|accepted/i);
      return completion(logbook);
    });

    const result = await runReproduction(options());
    expect(result.results).toEqual([expect.objectContaining({ id: "R-search", verdict: "verified", reproducedValue: "0.91" })]);
    expect(sandbox.exec.mock.calls.filter(args => String(args[0]).includes("expensive.py"))).toHaveLength(1);
    expect(requests.filter(request => request.tools)).toHaveLength(8);
    expectBoundedRequests(requests);
  });

  it("validates literal bounded search queries and paginates at twelve offsets without excerpts", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    setupContext(`\n${Array.from({ length: 20 }, (_, index) => `needle-${index}\n`).join("")}`);
    const starts = [...currentPaper.matchAll(/needle/gi)].map(match => match.index);
    const invalid = [
      call("missing-query", "search_paper", {}),
      call("empty-query", "search_paper", { query: "" }),
      call("long-query", "search_paper", { query: "x".repeat(129) }),
      call("negative-offset", "search_paper", { query: "needle", offset: -1 }),
      call("fractional-offset", "search_paper", { query: "needle", offset: 1.5 }),
    ];
    let turn = 0;
    let continuation = -1;
    createCompletion.mockImplementation(async (request: any) => {
      if (!request.tools) return judgeCompletion(["R1"]);
      turn++;
      const responses = request.messages.filter((message: any) => message.role === "tool");
      if (turn === 1) return completion(null, invalid);
      if (turn === 2) {
        for (const item of invalid) {
          const response = responses.find((message: any) => message.tool_call_id === item.id);
          expect(String(response?.content)).toMatch(/refused|invalid|query|offset|error/i);
          expect(String(response?.content)).not.toContain("needle-0");
        }
        return completion(null, [
          call("literal-query", "search_paper", { query: "needle[" }),
          call("first-twelve", "search_paper", { query: "NeEdLe" }),
        ]);
      }
      if (turn === 3) {
        const parse = (id: string) => JSON.parse(String(responses.find((message: any) => message.tool_call_id === id)?.content).replace(/^\[Tool call #\d+\]\n/, ""));
        const literal = parse("literal-query");
        expect(literal).toMatchObject({ path: "/work/paper.md", query: "needle[", matches: [], next_offset: null });
        const page = parse("first-twelve");
        expect(page).toMatchObject({ path: "/work/paper.md", query: "NeEdLe" });
        expect(page.matches).toEqual(starts.slice(0, 12).map((start: number) => ({ start, end: start + 6 })));
        expect(page.matches.every((match: any) => Object.keys(match).sort().join(",") === "end,start")).toBe(true);
        expect(JSON.stringify(page)).not.toContain("needle-");
        expect(page.next_offset).toBeGreaterThan(starts[11]);
        expect(page.next_offset).toBeLessThanOrEqual(starts[12]);
        continuation = page.next_offset;
        return completion(null, [call("remaining", "search_paper", { query: "needle", offset: continuation })]);
      }
      const remaining = JSON.parse(String(responses.find((message: any) => message.tool_call_id === "remaining")?.content).replace(/^\[Tool call #\d+\]\n/, ""));
      expect(remaining).toMatchObject({
        path: "/work/paper.md", query: "needle",
        matches: starts.slice(12).map((start: number) => ({ start, end: start + 6 })),
        next_offset: null,
      });
      if (turn === 4) {
        return completion(null, [
          sourceRead(), groundedPending("R1", "R1 claim", 9),
          call("run-needle", "run_command", { command: "python /work/materials/expensive.py" }),
          call("verify-needle", "record_result", {
            id: "R1", status: "verified", method: "rerun", reproduced_value: "0.91",
            evidence_tool_call_ids: [11], evidence_excerpt: "EXPENSIVE_METRIC=0.91",
          }),
        ]);
      }
      if (turn === 5) {
        expect(String(responses.find((message: any) => message.tool_call_id === "pending-R1")?.content)).toMatch(/pending/i);
        expect(String(responses.find((message: any) => message.tool_call_id === "verify-needle")?.content)).toMatch(/verified/i);
      }
      return completion(logbook);
    });
    const result = await runReproduction(options());
    expect(result.results).toEqual([expect.objectContaining({ id: "R1", verdict: "verified" })]);
    expect(turn).toBe(5);
  });

  it("paginates a long paper from the default 12000-character request to later Results and rejects invented provenance", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    const claim = "R-late claim";
    const quote = sourceQuote(claim, "0.91");
    setupContext(`\n# Background\n${"Unrelated historical discussion of the apparatus.\n".repeat(550)}\n# Results\n### detail\n${quote}\n`);
    const requests: any[] = [];
    const pages: Array<{ start: number; end: number; id: number }> = [];
    let nextOffset = 0;
    let toolIndex = 0;
    let commandCallId = 0;
    let stage: "reading" | "bad-provenance" | "pending" | "command" | "finalize" | "done" = "reading";
    createCompletion.mockImplementation(async (request: any) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (!request.tools) return judgeCompletion(["R-late"]);
      const last = [...request.messages].reverse().find((message: any) => message.role === "tool");
      if (stage === "reading") {
        if (last) {
          const text = String(last.content);
          const match = text.match(/Returned characters: (\d+)-(\d+) of (\d+)/);
          expect(match).not.toBeNull();
          const [, start, end, total] = match!.map(Number);
          expect(start).toBe(nextOffset);
          expect(end).toBeGreaterThan(start);
          expect(end).toBeLessThanOrEqual(start + 12_000);
          expect(Buffer.byteLength(JSON.stringify(renderSourcePage("/work/paper.md", currentPaper, start)))).toBeLessThanOrEqual(9_000);
          pages.push({ start, end, id: toolIndex });
          if (text.includes(quote)) {
            expect(start).toBeGreaterThan(0);
            expect(requestText(request)).toContain(`source_tool_call_id=${toolIndex}`);
            stage = "bad-provenance";
          } else {
            expect(end).toBeLessThan(total);
            expect(text).toContain(`Use offset=${end} to continue`);
            nextOffset = end;
          }
        } else {
          // The default max_chars, rather than an artificially small test request.
          return completion(null, [call("first-page", "read_file", { path: "/work/paper.md" })]);
        }
        if (stage === "reading") return completion(null, [call(`next-${pages.length}`, "read_file", { path: "/work/paper.md", offset: nextOffset })]);
      }
      const lastPage = pages.at(-1)!;
      if (stage === "bad-provenance") {
        stage = "pending";
        return completion(null, [call("invented-location", "record_result", {
          id: "R-late", claim, status: "pending", source_quote: quote,
          source_location: "characters 0-12000", source_tool_call_id: lastPage.id,
          original_value: "0.91",
        })]);
      }
      if (stage === "pending") {
        expect(String(last?.content)).toMatch(/source_location|source_quote|Refused/i);
        stage = "command";
        return completion(null, [groundedPending("R-late", claim, lastPage.id, "0.91", lastPage.start)]);
      }
      if (stage === "command") {
        expect(String(last?.content)).toMatch(/pending/i);
        stage = "finalize";
        commandCallId = toolIndex + 1;
        return completion(null, [call("run-late", "run_command", { command: "python /work/materials/expensive.py" })]);
      }
      if (stage === "finalize") {
        expect(String(last?.content)).toContain("EXPENSIVE_METRIC=0.91");
        stage = "done";
        return completion(null, [call("accepted-late", "record_result", {
          id: "R-late", status: "verified", method: "rerun", reproduced_value: "0.91",
          evidence_tool_call_ids: [commandCallId], evidence_excerpt: "EXPENSIVE_METRIC=0.91",
        })]);
      }
      return completion(logbook);
    });
    // One tool per reading turn; tool indices are stable even after history compaction.
    const originalCompletion = createCompletion.getMockImplementation()!;
    createCompletion.mockImplementation(async (request: any) => {
      const result = await originalCompletion(request);
      if (request.tools && result.choices[0].message.tool_calls) {
        toolIndex += result.choices[0].message.tool_calls.length;
      }
      return result;
    });

    const result = await runReproduction(options());
    expect(pages.length).toBeGreaterThan(2);
    expect(result.results).toEqual([expect.objectContaining({ id: "R-late", verdict: "verified" })]);
    expect(sandbox.exec.mock.calls.filter(args => String(args[0]).includes("expensive.py"))).toHaveLength(1);
    expect(requests.some(request => requestText(request).includes("characters 0-12000"))).toBe(true);
    expectBoundedRequests(requests);
  });

  it("stops repeated source prefixes without a claim instead of calling the judge", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    setupContext(`\n# Results\n${sourceQuote("R-loop claim", "0.91")}\n${"Supplementary discussion.\n".repeat(1000)}`);
    let reads = 0;
    let forcedFinals = 0;
    createCompletion.mockImplementation(async (request: any) => {
      if (!request.tools) {
        expect(String(request.messages.at(-1)?.content)).toContain("Repeated already-delivered source or archived pages");
        forcedFinals++;
        return completion(logbook);
      }
      reads++;
      return completion(null, [sourceRead(0, 12_000, `repeat-${reads}`)]);
    });
    await expect(runReproduction(options())).rejects.toThrow(/Repeated already-delivered source reads|no-progress/i);
    expect(reads).toBeLessThan(20);
    expect(forcedFinals).toBe(1);
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
    expect(createCompletion.mock.calls.filter(([request]) => !request.tools)).toHaveLength(1);
  });

  it("repairs a long latest draft and verbose multi-claim state through real paged retrieval, without repeating execution", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    const ids = Array.from({ length: 8 }, (_, i) => `R${i + 1}`);
    const claims = Object.fromEntries(ids.map(id => [id, `${id} scientific claim ${"detailed claim ".repeat(70)}`.trim()]));
    const originals = Object.fromEntries(ids.map(id => [id, `${id} original observations ${"reported value ".repeat(65)}`]));
    setupContext(`\n${ids.map(id => sourceQuote(claims[id], originals[id])).join("\n")}`);
    const sourceCalls = ids.flatMap((id, index) => {
      const quote = sourceQuote(claims[id], originals[id]);
      const offset = currentPaper.indexOf(quote);
      expect(offset).toBeGreaterThanOrEqual(0);
      return [
        sourceRead(offset, quote.length, `paper-source-${id}`),
        groundedPending(id, claims[id], index * 2 + 1, originals[id], offset, quote.length),
      ];
    });
    const expensiveCallIndex = sourceCalls.length + 1;
    const notes = `Full scientific notes: ${"important detail ".repeat(130)} END_NOTES`;
    const draft = `${logbook}\n${'Long proposed logbook "測定🧪"\n'.repeat(1800)}END_DRAFT`;
    const evidence = `${"noise".repeat(1400)}\nEXPENSIVE_METRIC=0.91`;
    sandbox.exec.mockImplementation(async (command: string[]) => ({
      stdout: command.join(" ").includes("nvidia-smi") ? "Test GPU, 16 GB" : evidence,
      stderr: "", exitCode: 0, timedOut: false, durationMs: 1,
    }));
    const requests: any[] = [];
    const judgeClaims: any[] = [];
    let turn = 0;
    let firstDraftPage: any;
    let recoveredDraft = "";
    let evidenceOffset = 0;
    let evidenceText = "";
    const toolMessage = (request: any) => [...request.messages].reverse().find((message: any) => message.role === "tool");
    createCompletion.mockImplementation(async (request: any) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (!request.tools) {
        const input = request.messages[1].content as string;
        const batch = JSON.parse(input.split("# AGENT'S RECORDED RESULTS (proposals, not verdicts)\n")[1].split("\n\n# AGENT'S LOGBOOK")[0]);
        judgeClaims.push(...batch);
         expect(input).toContain(`Original tool #${expensiveCallIndex}`);
        expect(input).toContain("EXPENSIVE_METRIC=0.91");
        return judgeCompletion(batch.map((claim: any) => claim.id));
      }
      expect(request.messages[0].content).toBe(buildEffectiveReproducerPrompt(REPRODUCER_PROMPT));
      turn++;
       if (turn === 1) return completion(null, sourceCalls);
      if (turn === 2) return completion(null, [call("expensive", "run_command", { command: "python /work/materials/expensive.py" })]);
      if (turn === 3) return completion(null, ids.map(id => call(`rejected-${id}`, "record_result", {
        id, status: "verified", reproduced_value: "0.91", method: "rerun",
        evidence_tool_call_ids: [999], evidence_excerpt: "EXPENSIVE_METRIC=0.91", notes,
      })));
      if (turn === 4) return completion(draft);
      if (turn === 5) {
        expect(requestText(request)).not.toContain("END_DRAFT");
        const archivedDraft = request.messages.find((message: any) =>
          message.role === "assistant" && !message.tool_calls && String(message.content).includes("read_reproduction_context"));
        expect(archivedDraft).toBeDefined();
        const notice = JSON.parse(archivedDraft.content);
        expect(notice.ref).toBeTruthy();
        return completion(null, [call("draft-page-1", "read_reproduction_context", { ref: notice.ref, max_chars: 3000 })]);
      }
      if (turn === 6 || turn === 7) {
        const raw = toolMessage(request).content.replace(/^\[Tool call #\d+\]\n/, "");
        const page = JSON.parse(raw);
        expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThanOrEqual(6000);
        expect(page.text).toBe(draft.slice(page.offset, page.end));
        if (turn === 6) {
          firstDraftPage = page;
          recoveredDraft = page.text;
          return completion(null, [call("draft-page-2", "read_reproduction_context", { ref: page.ref, offset: page.next_offset })]);
        }
        expect(page.offset).toBe(firstDraftPage.next_offset);
        recoveredDraft += page.text;
        expect(recoveredDraft).toBe(draft.slice(0, page.end));
        const state = [...request.messages].reverse().flatMap((message: any) => {
          if (message.role !== "user") return [];
          try {
            const parsed = JSON.parse(String(message.content));
            return parsed?.totals?.claims === 8 ? [parsed] : [];
          } catch {
            return [];
          }
        })[0];
        expect(state.totals.claims).toBe(8);
        expect(state.totals.pending).toBe(8);
        const repair = state.claims.find((claim: any) => claim.repair);
        expect(repair).toBeDefined();
        return completion(null, [call("claim-state", "read_reproduction_context", { ref: repair.ref })]);
      }
      if (turn === 8) {
        const page = JSON.parse(toolMessage(request).content.replace(/^\[Tool call #\d+\]\n/, ""));
        expect(page.notice).toMatch(/not scientifically valid evidence/);
        expect(page.text).toContain('"accepted"');
         return completion(null, [call("evidence-page-1", "read_tool_result", { tool_call_id: expensiveCallIndex, max_chars: 4000 })]);
      }
      if (turn === 9) {
        evidenceText = toolMessage(request).content;
         expect(evidenceText).toContain(`Original evidence tool call #${expensiveCallIndex}`);
        evidenceOffset = Number(evidenceText.match(/\[Use offset=(\d+) to continue/)[1]);
         return completion(null, [call("evidence-page-2", "read_tool_result", { tool_call_id: expensiveCallIndex, offset: evidenceOffset })]);
      }
      if (turn === 10) {
        const page = toolMessage(request).content;
        expect(page).toContain(`characters ${evidenceOffset}-`);
        expect(page).toContain("EXPENSIVE_METRIC=0.91");
         return completion(null, ids.map(id => call(`accepted-${id}`, "record_result", {
           id, status: "verified", method: "rerun", evidence_tool_call_ids: [expensiveCallIndex],
          evidence_excerpt: "EXPENSIVE_METRIC=0.91", reproduced_value: "0.91",
        })));
      }
      return completion(logbook);
    });
    const result = await runReproduction(options({ reproducerPrompt: REPRODUCER_PROMPT, judgePrompt: JUDGE_PROMPT }));
    expect(result.results).toHaveLength(8);
    expect(result.results.every(item => item.verdict === "verified")).toBe(true);
    expect(result.logbook).toBe(logbook);
    expect(judgeClaims.map(claim => claim.id).sort()).toEqual(ids);
    for (const claim of judgeClaims) {
      expect(claim.claim).toBe(claims[claim.id]);
      expect(claim.originalValue).toBe(originals[claim.id]);
      expect(claim.notes).toBe(notes);
       expect(claim.evidenceToolCallIds).toEqual([expensiveCallIndex]);
    }
    expect(sandbox.exec.mock.calls.filter(args => String(args[0]).includes("expensive.py"))).toHaveLength(1);
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
    expectBoundedRequests(requests);
    for (const request of requests) {
      const declarations = new Set(request.messages.flatMap((message: any) => (message.tool_calls ?? []).map((item: any) => item.id)));
      for (const message of request.messages) {
        if (message.role === "tool") expect(declarations.has(message.tool_call_id)).toBe(true);
      }
    }
  });

  it("recovers original evidence after a 35175/32768 provider rejection without rerunning the expensive command", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    // Leave removable history in the initial request. The provider rejection
    // lowers the input target to 75%, so the retry must have real prose/output
    // to compact while retaining the irreducible evidence and state.
    setupContext(`\n\n${"shipped-paper-history ".repeat(500)}`);
    const requests = snapshotsAtInvocation();
    let agentResponses = 0;
    createCompletion.mockImplementation(async (request: any) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (!request.tools) return judgeCompletion(["R1"], { R1: "0.91" });

      agentResponses++;
      if (agentResponses === 1) {
        return completion(null, [
          sourceRead(), groundedPending("R1", "R1 claim"),
        ]);
      }
      if (agentResponses === 2) {
        return completion(null, [
          call("expensive", "run_command", { command: "python /work/materials/expensive.py" }),
        ]);
      }
      if (agentResponses === 3) {
        throw {
          status: 400,
          error: {
            code: "context_length_exceeded",
            message: "maximum context length: 35175 > 32768",
          },
        };
      }
      if (agentResponses === 4) {
        return completion(null, [
          call("rejected", "record_result", {
            id: "R1",
            status: "verified",
            reproduced_value: "0.91",
            method: "rerun",
            evidence_tool_call_ids: [999],
            evidence_excerpt: "EXPENSIVE_METRIC=0.91",
          }),
        ]);
      }
      if (agentResponses === 5) {
        return completion(null, [
          call("recover", "read_tool_result", { tool_call_id: 3, offset: 0, max_chars: 8_000 }),
        ]);
      }
      if (agentResponses === 6) {
        return completion(null, [
          call("corrected", "record_result", {
            id: "R1",
            status: "verified",
            reproduced_value: "0.91",
            method: "rerun",
            evidence_tool_call_ids: [3],
            evidence_excerpt: "EXPENSIVE_METRIC=0.91",
          }),
        ]);
      }
      return completion(logbook);
    });

    const result = await runReproduction(options());

    expect(result.results).toEqual([expect.objectContaining({
      id: "R1",
      verdict: "verified",
      reproducedValue: "0.91",
    })]);
    expect(result.logbook).toBe(logbook);
    expect(result.judgeSummary).toBe("The bounded judge checked the accepted claims.");
    expect(sandbox.exec.mock.calls.filter(args => String(args[0]).includes("expensive.py"))).toHaveLength(1);
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
    expect(Math.max(...sandbox.exec.mock.invocationCallOrder))
      .toBeLessThan(sandbox.terminate.mock.invocationCallOrder[0]);
    expect(sandbox.terminate.mock.invocationCallOrder[0])
      .toBeLessThan(createCompletion.mock.invocationCallOrder.at(-1)!);

    const firstAgent = requests.find(request => request.tools);
    expect(firstAgent?.messages[0].content).toContain("CUSTOM SAVED CONTEXT INSTRUCTION");
    expect(firstAgent?.messages[0].content).toContain("read_tool_result");
    expect(requests.some(request =>
      requestText(request).includes("Refused finalization of R1")
      && requestText(request).includes("Accepted state remains pending"),
    )).toBe(true);
    expect(requests.some(request =>
      requestText(request).includes("Original evidence tool call #3")
      && requestText(request).includes("EXPENSIVE_METRIC=0.91"),
    )).toBe(true);

    // The canonical expensive call remains one assistant declaration with its
    // original ID; fitting later requests must not mutate or duplicate it.
    const recoveryRequest = requests.find(request =>
      requestText(request).includes('"tool_call_id":"recover"'),
    );
    const expensiveDeclarations = (recoveryRequest?.messages ?? [])
      .flatMap((message: any) => message.tool_calls ?? [])
      .filter((toolCall: any) => toolCall.id === "expensive");
    expect(expensiveDeclarations).toHaveLength(1);
    expect(expensiveDeclarations[0].function.arguments).toContain("expensive.py");
    expect(requests.flatMap(request => request.messages ?? [])
      .filter((message: any) => message.role === "assistant")
      .flatMap((message: any) => message.tool_calls ?? [])
      .map((toolCall: any) => toolCall.id)
      .filter((id: string) => id === "expensive")).not.toHaveLength(0);
    expectBoundedRequests(requests);
  });

  it("keeps a persistent HTTP-shaped context rejection bounded, with no repeated tools or judge call", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    const requests = snapshotsAtInvocation();
    let agentResponses = 0;
    createCompletion.mockImplementation(async (request: any) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (!request.tools) {
        throw new Error("judge must not be called after persistent context rejection");
      }
      agentResponses++;
      if (agentResponses === 1) {
        return completion(null, [
          sourceRead(), groundedPending("R1", "R1 claim"),
        ]);
      }
      if (agentResponses === 2) {
        return completion(null, [
          call("expensive", "run_command", { command: "python /work/materials/expensive.py" }),
        ]);
      }
      const error = new Error("provider rejected request");
      Object.assign(error, {
        status: 400,
        error: {
          code: "context_length_exceeded",
          message: "prompt is too long: 35175 > 32768",
        },
      });
      throw error;
    });

    await expect(runReproduction(options())).rejects.toThrow(/context|request|budget/i);
    expect(sandbox.exec.mock.calls.filter(args => String(args[0]).includes("expensive.py"))).toHaveLength(1);
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
    expect(requests.every(request => request.tools)).toBe(true);
    expectBoundedRequests(requests);
  });

  it("preserves large write arguments and newest output while retaining pending and accepted state", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    const largeCode = "print('intact')\n" + "C".repeat(16_000);
    const newestOutput = "LATEST_OUTPUT_METRIC=7.77\n" + "Y".repeat(18_000);
    sandbox.exec.mockImplementation(async (command: string[]) => {
      if (command.join(" ").includes("nvidia-smi")) {
        return { stdout: "Test GPU, 16 GB\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
      }
      return { stdout: newestOutput, stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
    });
    const requests = snapshotsAtInvocation();
    let agentResponses = 0;
    createCompletion.mockImplementation(async (request: any) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (!request.tools) {
        return judgeCompletion(["R-pending", "R-accepted"], {
          "R-pending": "7.77",
          "R-accepted": "7.77",
        });
      }
      agentResponses++;
      if (agentResponses === 1) {
        return completion(null, [
          sourceRead(),
          groundedPending("R-pending", "R-pending claim"),
          groundedPending("R-accepted", "R-accepted claim"),
        ]);
      }
      if (agentResponses === 2) {
        return completion(null, [
          call("write-large", "write_file", { path: "/work/results/reproduction.py", content: largeCode }),
        ]);
      }
      if (agentResponses === 3) {
        return completion(null, [
          call("newest-output", "run_command", { command: "python /work/results/reproduction.py" }),
        ]);
      }
      if (agentResponses === 4) {
        return completion(null, [
          call("accept-one", "record_result", {
            id: "R-accepted",
            status: "verified",
            reproduced_value: "7.77",
            method: "rerun",
            evidence_tool_call_ids: [5],
            evidence_excerpt: "LATEST_OUTPUT_METRIC=7.77",
          }),
        ]);
      }
      if (agentResponses === 5) {
        return completion(null, [
          call("accept-two", "record_result", {
            id: "R-pending",
            status: "verified",
            reproduced_value: "7.77",
            method: "rerun",
            evidence_tool_call_ids: [5],
            evidence_excerpt: "LATEST_OUTPUT_METRIC=7.77",
          }),
        ]);
      }
      return completion(logbook);
    });

    const result = await runReproduction(options());

    expect(result.results.map(item => item.id)).toEqual(["R-pending", "R-accepted"]);
    expect(result.results).toEqual([
      expect.objectContaining({ id: "R-pending", reproducedValue: "7.77", verdict: "verified" }),
      expect.objectContaining({ id: "R-accepted", reproducedValue: "7.77", verdict: "verified" }),
    ]);
    expect(sandbox.writeText.mock.calls.filter(args => args[0] === "/work/results/reproduction.py"))
      .toHaveLength(1);
    expect(sandbox.writeText.mock.calls.find(args => args[0] === "/work/results/reproduction.py")?.[1])
      .toBe(largeCode);
    expect(requests.some(request =>
      requestText(request).includes("R-pending")
      && requestText(request).includes("R-accepted"),
    )).toBe(true);
    expect(requests.some(request => requestText(request).includes("LATEST_OUTPUT_METRIC=7.77"))).toBe(true);

    const compactedWrite = requests.find(request =>
      requestText(request).includes("[old command arguments omitted"),
    );
    expect(compactedWrite).toBeDefined();
    const compactedWriteCall = requests
      .flatMap(request => request.messages ?? [])
      .flatMap((message: any) => message.tool_calls ?? [])
      .find((toolCall: any) => toolCall.id === "write-large");
    expect(compactedWriteCall).toBeDefined();
    const compactedWriteArgs = JSON.parse(compactedWriteCall.function.arguments);
    expect(compactedWriteArgs).toMatchObject({
      path: "/work/results/reproduction.py",
      _context_note: expect.stringContaining("old command arguments omitted"),
    });
    expect(compactedWriteArgs.content).toBeUndefined();
    expectBoundedRequests(requests);
    expect(sandbox.exec.mock.calls.filter(args => String(args[0]).includes("reproduction.py"))).toHaveLength(1);
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized custom system or judge prompt before creating a sandbox", async () => {
    const oversized = "X".repeat(80_000);

    let systemError: unknown;
    try {
      await runReproduction(options({ reproducerPrompt: oversized }));
    } catch (error) {
      systemError = error;
    }
    expect(String((systemError as Error)?.message)).toMatch(/reproduction(?:-judge)?|context|budget/i);
    expect(String((systemError as Error)?.message)).not.toContain("X".repeat(100));
    expect(createSandbox).not.toHaveBeenCalled();
    expect(createCompletion).not.toHaveBeenCalled();

    createSandbox.mockReset();
    createCompletion.mockReset();
    let judgeError: unknown;
    try {
      await runReproduction(options({ judgePrompt: oversized }));
    } catch (error) {
      judgeError = error;
    }
    expect(String((judgeError as Error)?.message)).toMatch(/reproduction(?:-judge)?|context|budget/i);
    expect(String((judgeError as Error)?.message)).not.toContain("X".repeat(100));
    expect(createSandbox).not.toHaveBeenCalled();
    expect(createCompletion).not.toHaveBeenCalled();
  });

  it("rejects fixed instructions that fit alone but leave no retrieval headroom, before paid work", async () => {
    let failure: Error | undefined;
    try {
      await runReproduction(options({ reproducerPrompt: "PRIVATE_CUSTOM_INSTRUCTION ".repeat(400) }));
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toContain("runtime state/retrieval headroom before sandbox startup");
    const estimated = Number(failure!.message.match(/estimated_input=(\d+)/)?.[1]);
    const limit = Number(failure!.message.match(/input_limit=(\d+)/)?.[1]);
    expect(estimated).toBeLessThan(limit);
    expect(failure?.message).not.toContain("PRIVATE_CUSTOM_INSTRUCTION");
    expect(failure?.message).toMatch(/instructions=\d+/);
    expect(failure?.message).toMatch(/schemas=\d+/);
    expect(createSandbox).not.toHaveBeenCalled();
    expect(createCompletion).not.toHaveBeenCalled();
  });

  it("does not retry a context rejection after the deadline or perform extra tool work", async () => {
    const sandbox = makeSandbox();
    createSandbox.mockResolvedValue(sandbox);
    const now = vi.spyOn(Date, "now");
    let clock = 1_000;
    now.mockImplementation(() => clock);
    const requests = snapshotsAtInvocation();
    let agentResponses = 0;
    sandbox.exec.mockImplementation(async (command: string[]) => {
      if (command.join(" ").includes("nvidia-smi")) {
        return { stdout: "Test GPU, 16 GB\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
      }
      return { stdout: "EXPENSIVE_METRIC=0.91", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 };
    });
    createCompletion.mockImplementation(async (request: any) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (!request.tools) return judgeCompletion(["R1"]);
      agentResponses++;
      if (agentResponses === 1) {
        return completion(null, [
          sourceRead(), groundedPending("R1", "R1 claim"),
        ]);
      }
      if (agentResponses === 2) {
        return completion(null, [
          call("expensive", "run_command", { command: "python /work/materials/expensive.py" }),
        ]);
      }
      // This request was accepted by the provider only far enough to return
      // its context error. The deadline changes while it is in flight; the
      // loop must not issue a reduced retry afterward.
      clock = 1_000 + REPRODUCTION_BUDGET.wallClockMs + 1;
      throw {
        status: 400,
        body: { code: "context_length_exceeded", message: "35175 > 32768" },
      };
    });

    const result = await runReproduction(options());

    expect(result.stoppedBy).toBe("deadline");
    expect(sandbox.exec.mock.calls.filter(args => !String(args[0]).includes("nvidia-smi"))).toHaveLength(1);
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
    // The rejected post-command request must not get context retries once the
    // deadline has passed, and the judge is the only subsequent no-tools call.
    expect(requests.filter(request => request.tools)).toHaveLength(3);
    expect(requests.at(-1)?.tools).toBeUndefined();
    expectBoundedRequests(requests);
  });
});