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
  it("registers only verbatim claims from a verified canonical paper page", () => {
    const s = session();
    const paper = "Introduction.\nThe evaluation requires the Atlas test set and reports generic accuracy 92.3%, loss 0.15, and F1 0.87.\n";
    const quote = "The evaluation requires the Atlas test set and reports generic accuracy 92.3%, loss 0.15, and F1 0.87.";
    const start = paper.indexOf(quote);
    s.configureSourceGrounding({ paperPath: "/work/paper.md", paperText: paper });
    s.observeToolCall({
      ...command(1, `Verified file: /work/paper.md\nReturned characters: 0-${paper.length} of ${paper.length}\n---\n${paper}`),
      name: "read_file",
      args: { path: "/work/paper.md" },
    });

    expect(s.recordResult({ ...verified, evidence_tool_call_ids: [1] })).toContain("final-first submission cannot bypass");
    expect(s.recordResult({
      id: "R-bad-quote", claim: "Accuracy is 92.3%", status: "pending",
      original_value: "92.3%", source_quote: "Accuracy is 92.3% according to the paper.",
      source_location: "characters 0-41", source_tool_call_id: 1,
    })).toContain("Refused new claim");
    expect(s.recordResult({
      id: "R-paraphrase", claim: "Generic performance is excellent", status: "pending",
      source_quote: quote, source_location: `characters ${start}-${start + quote.length}`, source_tool_call_id: 1,
    })).toContain("claim must be a verbatim statement");
    expect(s.recordResult({
      id: "R1", claim: "generic accuracy 92.3%, loss 0.15, and F1 0.87", status: "pending",
      original_value: "92.3%", source_quote: quote,
      source_location: `characters 0-${paper.length}`, source_tool_call_id: 1,
      required_material: "Atlas test set",
    })).toContain("Registered R1 as pending");
  });

  it("keeps grounded original values and source provenance immutable across rejected repairs", () => {
    const s = session();
    const quote = "The paper reports held-out accuracy of 92.3% for the shipped evaluation.";
    s.configureSourceGrounding({ paperPath: "/work/paper.md", paperText: quote });
    s.observeToolCall({
      ...command(1, `Verified file: /work/paper.md\nReturned characters: 0-${quote.length} of ${quote.length}\n---\n${quote}`),
      name: "read_file", args: { path: "/work/paper.md" },
    });
    expect(s.recordResult({
      id: "R1", claim: "held-out accuracy of 92.3%", status: "pending", original_value: "92.3%",
      source_quote: quote, source_location: `characters 0-${quote.length}`, source_tool_call_id: 1,
    })).toContain("Registered");
    s.observeToolCall(command(2, "exit code 0 (1.0s)\nmetric=0.91"));

    expect(s.recordResult({
      id: "R1", status: "verified", original_value: "99.9%", reproduced_value: "0.91",
      method: "rerun", evidence_tool_call_ids: [2], evidence_excerpt: "metric=0.91",
    })).toContain("cannot replace its source-grounded original_value");
    expect(s.recorded.get("R1")).toMatchObject({
      status: "pending", originalValue: "92.3%", sourceQuote: quote,
      sourceLocation: `characters 0-${quote.length}`, sourceToolCallId: 1,
    });

    expect(s.recordResult({
      id: "R1", status: "verified", original_value: "92.3%", reproduced_value: "0.91",
      method: "rerun", evidence_tool_call_ids: [2], evidence_excerpt: "fabricated=0.91",
    })).toContain("Refused finalization");
    expect(s.recordResult({
      id: "R1", status: "verified", original_value: "88.8%", evidence_excerpt: "metric=0.91",
    })).toContain("cannot replace its source-grounded original_value");
    expect(s.recordResult({
      id: "R1", status: "verified", reproduced_value: "0.91",
      method: "rerun", evidence_tool_call_ids: [2], evidence_excerpt: "metric=0.91",
    })).toContain("evidence validated");
    expect(s.recorded.get("R1")).toMatchObject({
      status: "verified", originalValue: "92.3%", sourceQuote: quote,
      sourceLocation: `characters 0-${quote.length}`, sourceToolCallId: 1,
    });
  });

  it("refuses a direct guessed Python script but permits it after write_file provenance", () => {
    const s = session();
    s.configureMaterialGrounding({
      inventoryPath: "/work/MATERIALS_INDEX.md",
      shippedPaths: ["/work/materials/actual.py"],
    });
    expect(s.validateCommand("python /work/materials/train.py")).toContain("not a verified shipped or generated script");
    expect(s.validateCommand("python /work/materials/actual.py")).toBeUndefined();
    // Pipelines are intentionally not parsed or blocked as if this were a shell parser.
    expect(s.validateCommand("cat args.txt | python /work/materials/train.py")).toBeUndefined();
    s.noteGeneratedPath("/work/results/train.py");
    expect(s.validateCommand("python /work/results/train.py --seed 1")).toBeUndefined();
    expect(s.validateCommand("python /work/results/generated-by-command.py")).toContain("not a verified");
    s.observeToolCall({
      ...command(2, "Verified file: /work/results/generated-by-command.py\nReturned characters: 0-12 of 12\n---\nprint('ok')"),
      name: "read_file", args: { path: "/work/results/generated-by-command.py" },
    });
    expect(s.validateCommand("python /work/results/generated-by-command.py")).toBeUndefined();
  });

  it("accepts missing-material only after grounded requirement and shipped provenance inspection", () => {
    const s = session();
    const quote = "The reported score requires the Atlas test set and is 92.3%.";
    s.configureSourceGrounding({ paperPath: "/work/paper.md", paperText: quote });
    s.configureMaterialGrounding({
      inventoryPath: "/work/MATERIALS_INDEX.md",
      shippedPaths: ["/work/materials/README.md", "/work/materials/actual.py"],
      readmePaths: ["/work/materials/README.md"],
    });
    s.observeToolCall({
      ...command(1, `Verified file: /work/paper.md\nReturned characters: 0-${quote.length} of ${quote.length}\n---\n${quote}`),
      name: "read_file", args: { path: "/work/paper.md" },
    });
    expect(s.recordResult({
      id: "R1", claim: "score requires the Atlas test set and is 92.3%", status: "pending",
      original_value: "92.3%", source_quote: quote, source_location: `characters 0-${quote.length}`,
      source_tool_call_id: 1, required_material: "Atlas test set",
    })).toContain("Registered");
    s.observeToolCall({
      ...command(2, "Verified file: /work/MATERIALS_INDEX.md\n/work/materials/README.md\n/work/materials/actual.py"),
      name: "read_file", args: { path: "/work/MATERIALS_INDEX.md" },
    });
    s.observeToolCall({
      ...command(3, "Verified file: /work/materials/README.md\nRun actual.py; no dataset is included."),
      name: "read_file", args: { path: "/work/materials/README.md" },
    });
    s.observeToolCall({
      ...command(4, "Verified directory: /work/materials/Atlas\n(empty directory or not found)"),
      name: "list_files", args: { path: "/work/materials/Atlas" },
    });
    expect(s.recordResult({
      id: "R1", status: "inconclusive", method: "blocked", blocker_kind: "missing-material",
      required_material: "Atlas test set", evidence: "The Atlas test set was not shipped.",
      evidence_tool_call_ids: [2, 3, 4], evidence_excerpt: "(empty directory or not found)",
    })).toContain("evidence validated");
  });

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

  it("keeps recovery stage-aware and does not treat unique browsing as progress", () => {
    const s = session();
    expect(s.activeInstruction()).toMatch(/LATEST ACTION — EXTRACT.*targeted/s);
    const baseline = s.progress;
    s.observeToolCall({ ...command(1, "paper page one"), name: "read_file", args: { path: "/work/paper.md" } });
    s.observeToolCall({ ...command(2, "paper page two"), name: "read_file", args: { path: "/work/paper.md", offset: 12000 } });
    s.observeToolCall({ ...command(3, "f experiment.py"), name: "list_files", args: { path: "/work" } });
    expect(s.progress).toBe(baseline);
    s.recordResult({ id: "R1", claim: "Accuracy is 0.91", status: "pending", original_value: "0.91" });
    expect(s.activeInstruction()).toMatch(/LATEST ACTION — PREPARE\/EXECUTE.*no command has run/s);
    s.observeToolCall(command(4));
    expect(s.activeInstruction()).toMatch(/LATEST ACTION — ASSESS\/RECORD.*remain pending/s);
    s.recordResult({ ...verified, evidence_tool_call_ids: [4] });
    expect(s.activeInstruction()).toMatch(/LATEST ACTION — REPORT.*every accepted claim is finalized/s);
  });

  it("does not describe a paper-search command as scientific evidence", () => {
    const s = session();
    s.observeToolCall({
      ...command(1, "exit code 0\n42: reported accuracy was 0.91"),
      args: { command: "grep -n accuracy /work/paper.md" },
    });
    s.recordResult({ id: "R1", claim: "Accuracy is 0.91", status: "pending", original_value: "0.91" });
    const action = s.activeInstruction();
    expect(action).toContain("command output exists");
    expect(action).toContain("First assess whether output supports");
    expect(action).toContain("otherwise prepare/run the missing claim experiment");
    expect(action).not.toContain("execution evidence exists");
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