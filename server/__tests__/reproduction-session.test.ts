import { describe, it, expect, vi } from "vitest";
vi.mock("../storage", () => ({ storage: {} }));

import { ReproductionSession } from "../reproduction-session";
import { getReproductionClaimIssues, finalizeBudgetExhaustedResults } from "../reproduce";
import { buildEffectiveReproducerPrompt, REPRODUCTION_TOOL_CONTRACT, type RecordedResult } from "../prompts/reproduce";
import type { ToolCallRecord } from "../model-service";

function session() {
  return new ReproductionSession((recordedResults, toolCalls) =>
    getReproductionClaimIssues({ recordedResults, toolCalls }));
}
const command = (index: number, result = "exit code 0 (1.0s)\nmetric=0.91"): ToolCallRecord => ({
  index, name: "run_command", args: { command: "python experiment.py" }, result, durationMs: 1000, error: false,
});
const verified = {
  id: "R1", claim: "Accuracy is 0.91", status: "verified", reproduced_value: "0.91",
  method: "rerun", evidence_tool_call_ids: [1], evidence_excerpt: "metric=0.91",
};

describe("Reproduction session — immediate validation", () => {
  it("refuses bad evidence immediately, registers an omitted claim, and supports partial repairs", () => {
    const s = session();
    s.observeToolCall(command(1));
    const refused = s.recordResult({ ...verified, reproduced_value: "91%" });
    expect(refused).toContain("Refused finalization");
    expect(refused).toContain("does not include its reproduced value");
    expect(s.recorded.get("R1")?.status).toBe("pending");
    expect(s.repairContext()).toContain("R1");
    expect(s.recordResult({ id: "R1", status: "verified", reproduced_value: "0.91" })).toContain("evidence validated");
    expect(s.recorded.get("R1")?.status).toBe("verified");
  });

  it("retains accepted results on invalid updates and refuses pending downgrades", () => {
    const s = session();
    s.observeToolCall(command(1));
    s.recordResult(verified);
    const saved = s.recorded.get("R1");
    expect(s.recordResult({ ...verified, evidence_excerpt: "invented=0.91" })).toContain("Refused");
    expect(s.recorded.get("R1")).toEqual(saved);
    s.recordResult({ id: "R1", claim: "Accuracy", status: "pending" });
    expect(s.recorded.get("R1")).toEqual(saved);
  });

  it("does not count rejections, repeat registrations or cached reads as progress", () => {
    const s = session();
    s.observeToolCall(command(1));
    s.recordResult(verified);
    const progress = s.progress;
    s.recordResult(verified);
    s.recordResult({ ...verified, evidence_excerpt: "fabricated" });
    s.readToolResult({ tool_call_id: 1 });
    s.observeToolCall(command(2, "exit code 0 (42.0s)\nmetric=0.91"));
    expect(s.progress).toBe(progress);
    s.observeToolCall(command(3, "exit code 0 (1.0s)\nmetric=0.82"));
    expect(s.progress).toBe(progress + 1);
  });

  it.each([[9], [1, 9], [0], [-1], [1.2]].map(ids => ({ ids })))("rejects invalid or future evidence IDs $ids", ({ ids }) => {
    const s = session();
    s.observeToolCall(command(1));
    expect(s.recordResult({ ...verified, evidence_tool_call_ids: ids })).toContain("Refused");
  });

  it("rejects unknown methods and explicit invalid status rather than quietly falling back", () => {
    const s = session();
    s.observeToolCall(command(1));
    s.recordResult(verified);
    expect(s.recordResult({ ...verified, method: "read-summary" })).toContain("invalid reproduction method");
    expect(s.recordResult({ ...verified, status: "success" })).toContain("Refused");
    expect(s.recorded.get("R1")?.method).toBe("rerun");
  });

  it("recovers middle output omitted by transcript truncation without executing a new command", () => {
    const s = session();
    const full = `exit code 0\n${"x".repeat(15000)}\nmetric=0.91\n${"y".repeat(15000)}`;
    s.captureOutput("run_command", full);
    s.observeToolCall(command(1, "exit code 0\n[... truncated ...]"));
    expect(s.readToolResult({ tool_call_id: 1, offset: 15000, max_chars: 500 })).toContain("metric=0.91");
    expect(s.readToolResult({})).toContain("[1] run_command python experiment.py");
    expect(s.recordResult(verified)).toContain("evidence validated");
    expect(s.judgeEvidence()).toContain("Original tool #1");
    expect(s.judgeEvidence()).toContain("metric=0.91");
    expect(s.toolCalls).toHaveLength(1);
  });

  it("makes capture limits explicit and never reconstructs uncaptured numbers", () => {
    const s = session();
    s.observeToolCall(command(1, "exit code 0\nstart\n[... 20000 chars elided ...]\nend"));
    expect(s.readToolResult({ tool_call_id: 1 })).toContain("uncaptured output");
    expect(s.recordResult(verified)).toContain("Refused");
    expect(s.judgeEvidence()).not.toContain("metric=0.91");
  });

  it("does not accept a retrieval's own tool-call ID as execution evidence", () => {
    const s = session();
    s.observeToolCall(command(1));
    s.observeToolCall({ ...command(2), name: "read_tool_result", result: s.readToolResult({ tool_call_id: 1 }) });
    expect(s.recordResult({ ...verified, evidence_tool_call_ids: [2] })).toContain("Refused");
    expect(s.readToolResult({ tool_call_id: 2 })).toContain("Refused");
  });

  it.each([
    ["oom", "exit code 1\nCUDA out of memory", "CUDA out of memory", "The experiment ran out of memory."],
    ["missing-material", "exit code 1\nNo such file: raw.csv", "No such file: raw.csv", "Raw dataset is missing."],
    ["timeout", "TIMED OUT (900.0s)\nPartial epoch completed", "TIMED OUT (900.0s)", "The experiment timed out."],
  ])("accepts a concrete %s blocker", (kind, output, excerpt, explanation) => {
    const s = session();
    s.observeToolCall(command(1, output));
    expect(s.recordResult({
      id: "R1", claim: "Experiment", status: "inconclusive", method: "blocked",
      blocker_kind: kind, evidence: explanation, evidence_excerpt: excerpt, evidence_tool_call_ids: [1],
    })).toContain("evidence validated");
  });

  it("reserves budget finalization for the actual system stop, even with no commands", () => {
    const s = session();
    expect(s.recordResult({
      id: "R1", claim: "Unfinished", status: "inconclusive", method: "blocked", blocker_kind: "budget",
      evidence: "System-enforced deadline exhaustion", evidence_tool_call_ids: [],
    })).toContain("Refused");
    const results = Array.from(s.recorded.values());
    finalizeBudgetExhaustedResults({ recordedResults: results, toolCalls: [], stoppedBy: "model" });
    expect(results[0].status).toBe("pending");
    finalizeBudgetExhaustedResults({ recordedResults: results, toolCalls: [], stoppedBy: "deadline" });
    expect(getReproductionClaimIssues({ recordedResults: results, toolCalls: [], budgetExhausted: true })).toEqual([]);
    expect(results[0].evidenceToolCallIds).toEqual([]);
  });

  it("does not alter verified results at the resource limit", () => {
    const s = session();
    s.observeToolCall(command(1));
    s.recordResult(verified);
    const results: RecordedResult[] = [...s.recorded.values(), { id: "R2", claim: "Untested", status: "pending" }];
    finalizeBudgetExhaustedResults({ recordedResults: results, toolCalls: s.toolCalls, stoppedBy: "tool-budget" });
    expect(results.map(r => r.status)).toEqual(["verified", "inconclusive"]);
  });

  it("preserves custom/old prompts while appending mandatory live requirements", () => {
    const saved = "Custom scientific goal: investigate intervention strength. Legacy instruction: finish after two claims.";
    const effective = buildEffectiveReproducerPrompt(saved);
    expect(effective.startsWith(saved)).toBe(true);
    expect(effective.endsWith(REPRODUCTION_TOOL_CONTRACT)).toBe(true);
    expect(effective).toContain("read_tool_result");
    expect(effective).toContain("For ALL executed methods");
  });
});