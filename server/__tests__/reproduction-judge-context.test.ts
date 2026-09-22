import { describe, expect, it, vi, beforeEach } from "vitest";

const generate = vi.fn();

vi.mock("../model-service", () => ({
  getContextWindow: () => 32_768,
  generateWithConfig: (...args: unknown[]) => generate(...args),
}));

import { runBoundedReproductionJudge } from "../reproduction-judge";
import type { RecordedResult } from "../prompts/reproduce";
import type { ToolCallRecord } from "../model-service";
import { ContextBudgetError, estimateRequestTokens } from "../llm-context";
import { QuestioningState } from "../reproduction-questioning";

const config = {
  providerMode: "platform" as const,
  provider: "openrouter",
  modelName: "test-model",
};

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
    expect(generate.mock.calls.reduce((sum, args) => sum + Number((args[3] as { maxTokens: number }).maxTokens), 0)).toBeLessThanOrEqual(6000);
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

  it("splits after a provider rejection, preserving raw provenance and the total output allowance", async () => {
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
    expect(generate.mock.calls.slice(1).reduce((sum, args) => sum + args[3].maxTokens, 0)).toBe(6000);
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
