import { describe, expect, it, vi, beforeEach } from "vitest";

const generate = vi.fn();

vi.mock("../model-service", () => ({
  getContextWindow: () => 32_768,
  generateWithConfig: (...args: unknown[]) => generate(...args),
}));

import { runBoundedReproductionJudge } from "../reproduction-judge";
import type { RecordedResult } from "../prompts/reproduce";
import type { ToolCallRecord } from "../model-service";
import { ContextBudgetError, IncompleteGenerationError, estimateRequestTokens } from "../llm-context";
import { QuestioningState } from "../reproduction-questioning";

it("overrides a judge's falsified verdict when reproduced task counts are explicitly incompatible", async () => {
  generate.mockResolvedValueOnce({ content: JSON.stringify({
    summary: "Different accuracy.",
    results: [{ id: "R1", claim: "On 72 binary tasks accuracy was 1.000.", verdict: "falsified", reproduced_value: "96 tasks, accuracy 0.969", evidence: "Different accuracy." }],
  }) });
  const result = await runBoundedReproductionJudge({
    config, prompt: "Judge", title: "Test", abstract: "", logbook: "",
    recordedResults: [{ ...claim("R1"), claim: "On 72 binary tasks accuracy was 1.000." }],
    toolCalls: [call(1, "96 tasks, accuracy 0.969")],
  });
  expect(result.results[0].verdict).toBe("inconclusive");
  expect(result.results[0].evidence).toContain("counts differ");
});

const config = {
  providerMode: "platform" as const,
  provider: "openrouter",
  modelName: "test-model",
};

it("downgrades unsupported numerical falsification without relying on rounding wording", async () => {
  generate.mockResolvedValueOnce({ content: JSON.stringify({
    summary: "The quantitative claim is materially different.",
    results: [{ id: "R1", claim: "Effect +0.132 [0.085, 0.188]", verdict: "falsified",
      reproduced_value: "+0.108 [0.067, 0.151]",
      evidence: "The qualitative positive effect remains but the value is materially different." }],
  }) });
  const result = await runBoundedReproductionJudge({
    config, prompt: "Judge", title: "Test", abstract: "", logbook: "",
    recordedResults: [{ ...claim("R1"), claim: "Effect +0.132 [0.085, 0.188]" }],
    toolCalls: [call(1, "+0.108 [0.067, 0.151]")],
  });
  expect(result.results[0].verdict).toBe("inconclusive");
  expect(result.summary).toContain("superseded");
  expect(result.results[0].evidence).toContain("structured evidence");
});

it("does not finalize a scientific falsification justified by rounding tolerance alone", async () => {
  generate.mockResolvedValueOnce({ content: JSON.stringify({
    summary: "Falsified beyond rounding.",
    results: [{ id: "R1", claim: "Mean gain was 3.632.", verdict: "falsified", reproduced_value: "3.635", evidence: "The point estimate differs beyond rounding tolerance." }],
  }) });
  const result = await runBoundedReproductionJudge({
    config, prompt: "Judge", title: "Test", abstract: "", logbook: "",
    recordedResults: [{ ...claim("R1"), claim: "Mean gain was 3.632." }],
    toolCalls: [call(1, "gain 3.635")],
  });
  expect(result.results[0].verdict).toBe("inconclusive");
  expect(result.results[0].evidence).toContain("rounding precision alone");
  expect(result.summary).toContain("superseded");
});

function claim(id: string, n = 1): RecordedResult {
  return {
    id,
    claim: `${id} reports metric ${n}`,
    status: "verified",
    originalValue: String(n),
    evidence: `metric ${n}`,
    evidenceToolCallIds: [n],
    evidenceExcerpt: `metric=${n}`,
    method: "rerun",
  };
}

function call(index: number, output: string): ToolCallRecord {
  return {
    index,
    name: "run_command",
    args: { command: `python reproduce_${index}.py` },
    result: `exit code 0\n${output}`,
    durationMs: 1,
    error: false,
  };
}

beforeEach(() => {
  generate.mockReset();
  generate.mockResolvedValue({
    content: "```json\n{\"summary\":\"judged\",\"results\":[]}\n```",
  });
});

describe("bounded reproduction judge context handling", () => {
  it("starts DeepSeek V4 with reasoning room instead of retrying the known-small 6k allowance", async () => {
    generate.mockResolvedValue({ content: JSON.stringify({
      summary: "Graded", results: [{ id: "R1", claim: "R1", verdict: "verified" }],
    }) });
    const result = await runBoundedReproductionJudge({
      config: { ...config, modelName: "deepseek/deepseek-v4-pro-0813" },
      prompt: "judge", title: "paper", abstract: "", logbook: "",
      recordedResults: [claim("R1")], toolCalls: [call(1, "metric=1")],
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][3].maxTokens).toBe(12000);
    expect(result.results[0].verdict).toBe("verified");
  });

  it("stops dispatching on a local budget failure and preserves earlier independent verdicts", async () => {
    generate.mockResolvedValueOnce({ content: JSON.stringify({
      summary: "Graded", results: ["R1", "R2", "R3"].map(id => ({ id, claim: id, verdict: "verified" })),
    }) }).mockRejectedValue(Object.assign(new Error("Local spending limit reached"), { code: "SPENDING_CAP" }));
    const claims = Array.from({ length: 9 }, (_, i) => claim(`R${i + 1}`, i + 1));
    const result = await runBoundedReproductionJudge({
      config, prompt: "judge", title: "paper", abstract: "", logbook: "",
      recordedResults: claims, toolCalls: claims.map((_, i) => call(i + 1, `metric=${i + 1}`)),
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.results.slice(0, 3).every(r => r.verdict === "verified")).toBe(true);
    expect(result.results.slice(3).every(r => r.verdict === "inconclusive")).toBe(true);
    expect(result.summary).toContain("Local spending limit reached");
    expect(result.summary).toContain("R4, R5, R6, R7, R8, R9");
    expect(result.summary).not.toContain("provider request failed");
  });

  it("grades 14 claims in small batches and lets later batches finish after a timed-out request", async () => {
    const claims = Array.from({ length: 14 }, (_, i) => claim(`R${i + 1}`, i + 1));
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    generate.mockImplementation(async (_config, _prompt, input, opts) => {
      const ids = [...input.matchAll(/"id":\s*"(R\d+)"/g)].map(match => match[1]);
      expect(ids.length).toBeLessThanOrEqual(3);
      expect(opts.maxTokens).toBe(6000);
      expect(opts.timeoutMs).toBeLessThanOrEqual(240_000);
      if (ids.includes("R1")) {
        now += opts.timeoutMs;
        throw new Error("request timed out");
      }
      return { content: JSON.stringify({ summary: "Graded", results: ids.map(id => ({ id, claim: id, verdict: "verified" })) }) };
    });
    try {
      const result = await runBoundedReproductionJudge({
        config, prompt: "judge", title: "paper", abstract: "", logbook: "",
        recordedResults: claims, toolCalls: claims.map((_, i) => call(i + 1, `metric=${i + 1}`)),
      });
      expect(generate).toHaveBeenCalledTimes(5);
      expect(result.results.map(r => r.id)).toEqual(claims.map(r => r.id));
      expect(result.results.slice(0, 3).every(r => r.verdict === "inconclusive")).toBe(true);
      expect(result.results.slice(3).every(r => r.verdict === "verified")).toBe(true);
    } finally { clock.mockRestore(); }
  });

  it("splits on output exhaustion without shrinking child allowances or losing cited evidence", async () => {
    generate.mockRejectedValueOnce(new IncompleteGenerationError("length", "length"));
    generate.mockImplementation(async (_config, _prompt, input, opts) => {
      const ids = [...input.matchAll(/"id":\s*"(R\d+)"/g)].map(match => match[1]);
      expect(ids).toHaveLength(1);
      expect(opts.maxTokens).toBe(6000);
      expect(input).toContain(`metric=${ids[0].slice(1)}`);
      return { content: JSON.stringify({ summary: "Graded", results: ids.map(id => ({ id, claim: id, verdict: "verified" })) }) };
    });
    const result = await runBoundedReproductionJudge({
      config, prompt: "judge", title: "paper", abstract: "", logbook: "",
      recordedResults: [claim("R1"), claim("R2", 2)], toolCalls: [call(1, "metric=1"), call(2, "metric=2")],
    });
    expect(generate.mock.calls.map(args => args[3].maxTokens)).toEqual([6000, 6000, 6000]);
    expect(result.results.every(r => r.verdict === "verified")).toBe(true);
  });

  it("retains separate rows of a compound claim beyond the selected excerpt", async () => {
    const output = "band mean=-0.013 CI=[-0.052,0.027]\n" + "intermediate rows\n".repeat(500)
      + "layer=12 mean=0.132 CI=[0.085,0.188] improved=76.7%";
    await runBoundedReproductionJudge({
      config, prompt: "judge", title: "Study", abstract: "", logbook: "",
      recordedResults: [{ ...claim("R1"), claim: "Band and layer 12 effects.",
        evidenceExcerpt: "band mean=-0.013 CI=[-0.052,0.027]" }],
      toolCalls: [call(1, output)],
    });
    const input = String(generate.mock.calls[0][2]);
    expect(input).toContain("band mean=-0.013");
    expect(input).toContain("layer=12 mean=0.132 CI=[0.085,0.188] improved=76.7%");
  });
  it("retains the executed derivation source rather than trusting printed summaries", async () => {
    const recorded = { ...claim("R1", 3), method: "raw-data-rederived" as const };
    const source: ToolCallRecord = { index: 2, name: "write_file",
      args: { path: "/work/derive.py", content: "print(data['precomputed_summary'])" },
      result: "written", durationMs: 1, error: false };
    await runBoundedReproductionJudge({
      config, prompt: "judge", title: "study", abstract: "", logbook: "",
      recordedResults: [recorded],
      toolCalls: [source, { ...call(3, "metric=3"), args: { command: "python /work/derive.py" } }],
    });
    const user = String(generate.mock.calls[0][2]);
    expect(user).toContain("Original tool #2: write_file");
    expect(user).toContain("precomputed_summary");
  });

  it("independently receives suitability, code changes and executed version evidence without promoting adapted success", async () => {
    const q = new QuestioningState();
    q.assessment = { research_question: "Estimate a population mean", question_quote: "Estimate a population mean from the sample",
      decision: "adapt", rationale: "Unequal sampling requires weights.", claim_ids: ["R1"], evidence: [{ tool_call_id: 1, excerpt: "metric=1" }],
      intended_changes: "Use weighted mean", comparability: "Changed method is not original reproduction",
      planned_changes: [{ path: "/work/working/materials/analysis.py", reason: "Correct unequal sampling probabilities", claim_ids: ["R1"] }] };
    q.addOriginal("/work/materials/analysis.py", "unweighted_mean(sample)");
    q.write("/work/working/materials/analysis.py", "weighted_mean(sample)", "Correct unequal sampling probabilities");
    const execution = q.snapshot("python materials/analysis.py");
    execution.status = "executed";
    q.recordExecutionOutput(execution, "metric=1");
    generate.mockResolvedValue({ content: JSON.stringify({ summary: "Adaptation addresses sample weights, but comparability is not established.", results: [{ id: "R1", claim: "R1", verdict: "verified", evidence: "metric=1" }] }) });
    const judged = await runBoundedReproductionJudge({ config, prompt: "Custom independent judge", title: "Paper", abstract: "Abstract",
      logbook: "Agent asserts success", recordedResults: [claim("R1")], toolCalls: [call(1, "metric=1")], questioning: q });
    expect(generate.mock.calls[0][1]).toContain("scientifically defensible");
    const input = generate.mock.calls[0][2];
    expect(input).toContain("unweighted_mean(sample)");
    expect(input).toContain("weighted_mean(sample)");
    expect(input).toContain("/work/qp-executions/run-1");
    expect(input).toContain("metric=1");
    expect(judged.results[0].verdict).toBe("inconclusive");
    expect(judged.summary).toContain("comparability is not established");
  });
  it("drops redundant transcript while retaining a deep original cited metric", async () => {
    const deep = `${"x".repeat(34_000)} metric=1`;
    const calls = [call(1, deep), ...Array.from({ length: 30 }, (_, i) => call(i + 2, "old transcript ".repeat(300)))];
    await runBoundedReproductionJudge({
      config,
      prompt: "judge",
      title: "Paper",
      abstract: "Abstract",
      logbook: "Logbook",
      recordedResults: [claim("R1")],
      toolCalls: calls,
    });
    const user = String(generate.mock.calls[0]?.[2] || "");
    expect(user).toContain("# ORIGINAL CITED TOOL OUTPUTS");
    expect(user).toContain("metric=1");
    expect(user).toContain("preceding output omitted");
    expect(user).toContain("TOOL TRANSCRIPT");
    expect(user).not.toContain("old transcript ".repeat(300));
  });

  it("splits long claims into complete batches and keeps raw-input provenance", async () => {
    const claims = [claim("R1"), claim("R2", 2), claim("R3", 3)];
    for (const item of claims) item.claim = `${item.claim} ${"claim context ".repeat(1_500)}`;
    generate.mockImplementation(async (_config: unknown, _prompt: string, input: string) => {
      const ids = [...input.matchAll(/"id":\s*"(R\d+)"/g)].map(match => match[1]);
      return {
        content: JSON.stringify({
          summary: ids.join(","),
          results: ids.map(id => ({ id, claim: id, verdict: "verified" })),
        }),
      };
    });
    const output = await runBoundedReproductionJudge({
      config,
      prompt: "judge",
      title: "Paper",
      abstract: "Abstract",
      logbook: "Logbook",
      recordedResults: claims,
      toolCalls: [call(1, "metric=1"), call(2, "metric=2"), call(3, "metric=3")],
    });
    expect(output.results.map(result => result.id)).toEqual(["R1", "R2", "R3"]);
    expect(output.results.every(result => result.verdict === "verified")).toBe(true);
    expect(generate.mock.calls.length).toBeGreaterThan(1);
    expect(String(generate.mock.calls[0][2])).toContain("Original tool #1");
    for (const args of generate.mock.calls) expect(args[3].maxTokens).toBe(6000);
  });

  it("locally reduces after a wrapped provider overflow without losing the claim", async () => {
    generate
      .mockRejectedValueOnce(new Error("request failed: 35175 > 32768 context_length_exceeded"))
      .mockResolvedValueOnce({
        content: JSON.stringify({
          summary: "retried",
          results: [{ id: "R1", claim: "R1", verdict: "verified" }],
        }),
      });
    const output = await runBoundedReproductionJudge({
      config,
      prompt: "judge",
      title: "Paper",
      abstract: "Abstract",
      logbook: "Long logbook ".repeat(100),
      recordedResults: [claim("R1")],
      toolCalls: Array.from({ length: 10 }, (_, i) => call(i + 1, "chronological output ".repeat(25))),
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(output.results).toMatchObject([{ id: "R1", verdict: "verified" }]);
  });

  it("throws a clear budget error after wrapped context/provider errors", async () => {
    generate.mockRejectedValue(new Error("provider request failed: context_length 35175 > 32768"));
    await expect(runBoundedReproductionJudge({
      config,
      prompt: "judge",
      title: "Paper",
      abstract: "Abstract",
      logbook: "Logbook",
      recordedResults: [claim("R1")],
      toolCalls: [call(1, "metric=1")],
    })).rejects.toThrow(/context/i);
  });

  it("splits after a provider rejection, preserving raw provenance and each child's output allowance", async () => {
    const claims = [claim("R1"), claim("R2", 2)];
    claims.forEach(item => { item.claim += " context".repeat(1000); });
    claims[0].rawInputToolCallId = 9;
    claims[0].rawInputPath = "/work/raw.csv";
    const raw: ToolCallRecord = { ...call(9, "sample,value\nA,1"), name: "read_file", args: { path: "/work/raw.csv" } };
    generate.mockRejectedValueOnce(new Error("context_length_exceeded: max_num_tokens (32768)"));
    generate.mockImplementation(async (_config, _prompt, input) => {
      const ids = [...input.matchAll(/"id":\s*"(R\d+)"/g)].map(match => match[1]);
      return { content: JSON.stringify({ summary: "Graded", results: ids.map(id => ({ id, claim: id, verdict: "verified" })) }) };
    });
    const result = await runBoundedReproductionJudge({
      config, prompt: "judge", title: "paper", abstract: "", logbook: "",
      recordedResults: claims, toolCalls: [call(1, "metric=1"), call(2, "metric=2"), raw],
    });
    expect(generate).toHaveBeenCalledTimes(3);
    expect(result.results.map(item => [item.id, item.verdict])).toEqual([["R1", "verified"], ["R2", "verified"]]);
    const childInputs = generate.mock.calls.slice(1).map(args => args[2]);
    expect(childInputs.join("\n")).toContain("/work/raw.csv");
    expect(childInputs.join("\n")).toContain("sample,value");
    expect(generate.mock.calls.slice(1).map(args => args[3].maxTokens)).toEqual([6000, 6000]);
    for (const [, prompt, input, opts] of generate.mock.calls) {
      const request = { model: config.modelName, messages: [{ role: "system", content: prompt }, { role: "user", content: input }], max_tokens: opts.maxTokens, temperature: 0.1 };
      expect(estimateRequestTokens(request) + opts.maxTokens + 1024).toBeLessThanOrEqual(32768);
    }
  });

  it("fails explicitly if an exact essential excerpt cannot fit; never grades truncated evidence", async () => {
    const result = claim("R1");
    result.evidenceExcerpt = "EXACT_VALUE".repeat(4000);
    await expect(runBoundedReproductionJudge({
      config, prompt: "judge", title: "paper", abstract: "", logbook: "",
      recordedResults: [result], toolCalls: [call(1, result.evidenceExcerpt)],
    })).rejects.toThrow(ContextBudgetError);
    expect(generate).not.toHaveBeenCalled();
  });

  it("retries a singleton with a larger output budget when the model ran out of tokens before its verdict", async () => {
    const diagnostics: string[] = [];
    generate
      .mockRejectedValueOnce(new IncompleteGenerationError("BYOK provider did not return a complete answer (finish_reason=length, max_tokens=6000)", "length", 6000))
      .mockResolvedValueOnce({ content: JSON.stringify({ summary: "Graded with more room", results: [
        { id: "R1", claim: "R1", verdict: "verified" }, { id: "R2", claim: "R2", verdict: "falsified" },
      ] }) });
    const result = await runBoundedReproductionJudge({
      config, prompt: "judge", title: "paper", abstract: "", logbook: "",
      recordedResults: [claim("R1")], toolCalls: [call(1, "metric=1")],
      onDiagnostic: message => { diagnostics.push(message); },
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0][3].maxTokens).toBe(6000);
    expect(generate.mock.calls[1][3].maxTokens).toBe(12000);
    expect(generate.mock.calls[1][2]).toBe(generate.mock.calls[0][2]);
    expect(result.results.map(item => [item.id, item.verdict])).toEqual([["R1", "verified"]]);
    expect(diagnostics.join("\n")).toMatch(/output budget exhausted at max_tokens=6000.*max_tokens=12000/);
  });

  it("splits an exhausted batch immediately and bounds retries if a single claim still cannot be graded", async () => {
    const diagnostics: string[] = [];
    generate.mockRejectedValue(new IncompleteGenerationError("did not finish (finish_reason=length)", "length"));
    const result = await runBoundedReproductionJudge({
      config, prompt: "judge", title: "paper", abstract: "", logbook: "",
      recordedResults: [claim("R1"), claim("R2", 2)], toolCalls: [call(1, "metric=1"), call(2, "metric=2")],
      onDiagnostic: message => { diagnostics.push(message); },
    });
    const budgets = generate.mock.calls.map(args => args[3].maxTokens);
    // Pair splits immediately; neither singleton restarts with a smaller allowance.
    expect(budgets).toEqual([6000, 6000, 12000, 24000, 6000, 12000, 24000]);
    expect(result.results.map(item => [item.id, item.verdict])).toEqual([["R1", "inconclusive"], ["R2", "inconclusive"]]);
    expect(result.summary).toContain("The judge request failed for R1 (did not finish (finish_reason=length))");
    expect(diagnostics.some(message => /splitting 2 claims/.test(message))).toBe(true);
    expect(diagnostics.filter(message => /Judge batch failed \(did not finish/.test(message))).toHaveLength(2);
  });

  it("allocates at least 300 output tokens per claim so large batches can carry every verdict", async () => {
    const claims = Array.from({ length: 30 }, (_, i) => claim(`R${i + 1}`, i + 1));
    generate.mockImplementation(async (_config: unknown, _prompt: string, input: string) => {
      const ids = [...input.matchAll(/"id":\s*"(R\d+)"/g)].map(match => match[1]);
      return { content: JSON.stringify({ summary: "ok", results: ids.map(id => ({ id, claim: id, verdict: "verified" })) }) };
    });
    const result = await runBoundedReproductionJudge({
      config, prompt: "judge", title: "paper", abstract: "", logbook: "",
      recordedResults: claims, toolCalls: claims.map((_, i) => call(i + 1, `metric=${i + 1}`)),
    });
    expect(result.results.every(item => item.verdict === "verified")).toBe(true);
    for (const [, , , opts] of generate.mock.calls) expect(opts.maxTokens).toBeGreaterThanOrEqual(300 * 2);
    const graded = generate.mock.calls.map(args => [...String(args[2]).matchAll(/"id":\s*"(R\d+)"/g)].length);
    generate.mock.calls.forEach((args, i) => expect(args[3].maxTokens).toBeGreaterThanOrEqual(300 * graded[i]));
  });

  it("keeps ungraded claims inconclusive and discards foreign IDs", async () => {
    generate.mockResolvedValue({ content: JSON.stringify({ summary: "Partial", results: [
      { id: "R1", claim: "changed identity", verdict: "verified" },
      { id: "FOREIGN", claim: "not registered", verdict: "verified" },
    ] }) });
    const result = await runBoundedReproductionJudge({
      config, prompt: "judge", title: "paper", abstract: "", logbook: "",
      recordedResults: [claim("R1"), claim("R2", 2)],
      toolCalls: [call(1, "metric=1"), call(2, "metric=2")],
    });
    expect(result.results.map(item => [item.id, item.verdict])).toEqual([["R1", "verified"], ["R2", "inconclusive"]]);
    expect(result.results[0].claim).toBe(claim("R1").claim);
  });
});
