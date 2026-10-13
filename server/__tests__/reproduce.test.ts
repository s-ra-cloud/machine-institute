import { describe, it, expect, vi } from "vitest";

// paper-catalogue imports storage → db, which requires DATABASE_URL at import
// time; the pure helpers under test never touch the database.
vi.mock("../storage", () => ({ storage: {} }));

import {
  parseJudgeOutput,
  deriveOverallVerdict,
  countVerdicts,
  verdictsToRevisions,
  verdictsFromRecordedResults,
  buildReproductionTitle,
  buildReproductionAbstract,
  buildReproductionMarkdown,
  REPRODUCER_PROMPT,
  JUDGE_PROMPT,
  type ClaimVerdict,
} from "../prompts/reproduce";
import { isOwnPublication } from "../paper-catalogue";
import { buildConventionName, buildFsAgentDescription } from "../agent-naming";
import {
  normalizeAgentDescription,
  normalizeRevisions,
  _FS_TYPE_FALLBACKS_FOR_TEST,
} from "../future-science";
import {
  buildReproductionContinuation,
  finalizeBudgetExhaustedResults,
  getReproductionCompletionIssues,
  hasUsableReproductionEvidence,
  NO_USABLE_REPRODUCTION_EVIDENCE,
  getReproductionClaimIssues,
} from "../reproduce";
import { canRetryReproduction } from "../reproduction-retry";

const sample: ClaimVerdict[] = [
  { id: "R1", claim: "Cohen's d = 1.25", verdict: "verified", originalValue: "1.25", reproducedValue: "1.24" },
  { id: "R2", claim: "Kendall tau = 1.0", verdict: "falsified", originalValue: "1.0", reproducedValue: "0.6" },
  { id: "R3", claim: "29 heads carry 50% of signal", verdict: "toy" },
  { id: "R4", claim: "d = 31.1 in decomposition", verdict: "inconclusive" },
];

describe("Reproduction — judge output parsing", () => {
  it("parses a fenced JSON block with the hackathon verdict scale", () => {
    const text = `Here is my grading.\n\`\`\`json\n{"summary": "Two of four held.", "results": [{"id":"R1","claim":"d = 1.25","verdict":"Verified","original_value":"1.25","reproduced_value":"1.24","evidence":"analysis_3","confidence":"high"},{"id":"R2","claim":"tau = 1.0","verdict":"FALSIFIED","confidence":"medium"}]}\n\`\`\``;
    const parsed = parseJudgeOutput(text);
    expect(parsed.summary).toBe("Two of four held.");
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0]).toMatchObject({ id: "R1", verdict: "verified", originalValue: "1.25", reproducedValue: "1.24", confidence: "high" });
    expect(parsed.results[1].verdict).toBe("falsified");
  });

  it("parses a bare JSON object without a fence and maps unknown verdicts to inconclusive", () => {
    const parsed = parseJudgeOutput(`{"summary":"s","results":[{"id":"R1","claim":"c","verdict":"maybe"}]}`);
    expect(parsed.results[0].verdict).toBe("inconclusive");
  });

  it("returns empty results on unparseable output", () => {
    expect(parseJudgeOutput("no json here")).toEqual({ summary: "", results: [] });
    expect(parseJudgeOutput("```json\n{broken\n```")).toEqual({ summary: "", results: [] });
  });

  it("falls back to the agent's recorded statuses, mapping pending to inconclusive", () => {
    const out = verdictsFromRecordedResults([
      { id: "R1", claim: "a", status: "verified" },
      { id: "R2", claim: "b", status: "pending" },
    ]);
    expect(out.map(r => r.verdict)).toEqual(["verified", "inconclusive"]);
  });
});

describe("Reproduction — paper-level verdict", () => {
  it("any falsified result marks the paper falsified", () => {
    expect(deriveOverallVerdict(sample)).toBe("falsified");
  });
  it("all verified → verified; some verified → partially verified", () => {
    expect(deriveOverallVerdict([sample[0], { ...sample[0], id: "R9" }])).toBe("verified");
    expect(deriveOverallVerdict([sample[0], sample[2]])).toBe("partially verified");
  });
  it("toy-only → toy; nothing → inconclusive", () => {
    expect(deriveOverallVerdict([sample[2]])).toBe("toy");
    expect(deriveOverallVerdict([sample[3]])).toBe("inconclusive");
    expect(deriveOverallVerdict([])).toBe("inconclusive");
  });
  it("counts each verdict", () => {
    expect(countVerdicts(sample)).toEqual({ total: 4, verified: 1, falsified: 1, toy: 1, inconclusive: 1 });
  });
});

describe("Reproduction — usable execution evidence", () => {
  it("rejects the observed empty run with only two pending results and no logbook evidence", () => {
    const valid = hasUsableReproductionEvidence({
      recordedResults: [
        { id: "R1", claim: "Accuracy is 90%", status: "pending" },
        { id: "R2", claim: "Loss is 0.1", status: "pending" },
      ],
      toolCalls: [
        { name: "record_result" },
        { name: "record_result" },
      ],
    });

    expect(valid).toBe(false);
    expect(NO_USABLE_REPRODUCTION_EVIDENCE).toContain("no usable execution evidence");
  });

  it.each(["verified", "falsified", "toy", "inconclusive"] as const)(
    "accepts an evidence-backed %s result",
    status => {
      expect(hasUsableReproductionEvidence({
        recordedResults: [{
          id: "R1",
          claim: "A quantitative claim",
          status,
          evidence: "python reproduce.py produced results/output.json",
        }],
        toolCalls: [{ name: "record_result" }],
      })).toBe(true);
    },
  );

  it("accepts an inconclusive run when a real command was attempted", () => {
    expect(hasUsableReproductionEvidence({
      recordedResults: [{ id: "R1", claim: "A quantitative claim", status: "inconclusive" }],
      toolCalls: [{
        name: "run_command",
        args: { command: "python reproduce.py" },
        result: "exit code 1",
      }],
    })).toBe(true);
  });
});

describe("Reproduction — premature-stop recovery", () => {
  it("rejects an archive notice as a final response and asks for recovery", () => {
    const input = {
      recordedResults: [],
      toolCalls: [],
      logbook: JSON.stringify({
        notice: "Archived unchanged; not scientific evidence.",
        read: "read_reproduction_context({ref:\"12\"})",
      }),
    };
    expect(getReproductionCompletionIssues(input)).toContain(
      "the final response is only an archive/retrieval notice, not a reproduction logbook",
    );
    expect(buildReproductionContinuation(input)).toContain("Continue using the available tools now");
  });

  it("continues the observed two-pending-results and blank-response sequence", () => {
    const continuation = buildReproductionContinuation({
      recordedResults: [
        { id: "R1", claim: "Accuracy is 90%", status: "pending" },
        { id: "R2", claim: "Loss is 0.1", status: "pending" },
      ],
      toolCalls: [
        { name: "record_result" },
        { name: "record_result" },
      ],
      logbook: "",
    });

    expect(continuation).toContain("2 results are still pending (R1, R2)");
    expect(continuation).toContain("no command execution");
    expect(continuation).toContain("final logbook is missing");
    expect(continuation).toContain("Continue using the available tools now");
  });

  it("accepts a completed evidence-backed inconclusive reproduction", () => {
    const input = {
      recordedResults: [{
        id: "R1",
        claim: "A quantitative claim",
        status: "inconclusive" as const,
        evidence: "The command failed because the required dataset was not shipped.",
        method: "blocked" as const,
        evidenceToolCallIds: [1],
        evidenceExcerpt: "No such file: dataset.csv",
        blockerKind: "missing-material" as const,
      }],
      toolCalls: [{
        name: "run_command",
        args: { command: "python reproduce.py" },
        result: "exit code 1\nNo such file: dataset.csv",
      }],
      logbook: [
        "## Claims",
        "R1 is inconclusive.",
        "## Reproduction Log",
        "Attempted the shipped script.",
        "## Discrepancies",
        "None measurable.",
        "## Limitations",
        "Dataset unavailable.",
      ].join("\n"),
    };

    expect(getReproductionCompletionIssues(input)).toEqual([]);
    expect(buildReproductionContinuation(input)).toBeNull();
  });

  it("still rejects finalized evidence when the required logbook is missing", () => {
    const issues = getReproductionCompletionIssues({
      recordedResults: [{
        id: "R1",
        claim: "A quantitative claim",
        status: "verified",
        reproducedValue: "0.91",
        method: "rerun",
        evidenceToolCallIds: [1],
        evidenceExcerpt: "reproduced=0.91",
      }],
      toolCalls: [{
        name: "run_command",
        args: { command: "python reproduce.py" },
        result: "exit code 0\nreproduced=0.91",
      }],
      logbook: "Done.",
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("final logbook is missing");
  });

  it("requires supporting evidence for every finalized result", () => {
    const issues = getReproductionCompletionIssues({
      recordedResults: [
        {
          id: "R1",
          claim: "First claim",
          status: "verified",
          reproducedValue: "0.91",
          evidence: "results.json",
          method: "raw-data-rederived",
          evidenceToolCallIds: [1, 2],
          evidenceExcerpt: "recomputed=0.91",
          rawInputToolCallId: 1,
          rawInputPath: "/work/materials/raw.csv",
        },
        {
          id: "R2",
          claim: "Second claim",
          status: "inconclusive",
          method: "blocked",
          evidenceToolCallIds: [1],
          evidenceExcerpt: "exit code 0",
          blockerKind: "command-error",
        },
      ],
      toolCalls: [
        { name: "read_file", args: { path: "/work/materials/raw.csv" }, result: "raw rows" },
        { name: "run_command", args: { command: "python reproduce.py /work/materials/raw.csv" }, result: "exit code 0\nrecomputed=0.91" },
      ],
      logbook: [
        "## Claims",
        "R1 verified; R2 inconclusive.",
        "## Reproduction Log",
        "Ran the script.",
        "## Discrepancies",
        "None.",
        "## Limitations",
        "R2 could not be measured.",
      ].join("\n"),
    });

    expect(issues).toContain("1 finalized result has no reproduced value or supporting evidence (R2)");
  });

  it("does not accept required headings quoted inside prose", () => {
    const issues = getReproductionCompletionIssues({
      recordedResults: [{
        id: "R1",
        claim: "A claim",
        status: "verified",
        reproducedValue: "0.91",
        evidence: "results.json",
        method: "rerun",
        evidenceToolCallIds: [1],
        evidenceExcerpt: "reproduced=0.91",
      }],
      toolCalls: [{
        name: "run_command",
        args: { command: "python recompute.py" },
        result: "exit code 0\nreproduced=0.91",
      }],
      logbook: "I was asked to write ## Claims and ## Reproduction Log and ## Discrepancies and ## Limitations.",
    });

    expect(issues.some(issue => issue.includes("final logbook is missing"))).toBe(true);
  });

  it("continues the observed early finish when claims were skipped due to time with most budget unused", () => {
    const toolCalls = Array.from({ length: 18 }, (_, offset) => ({
      index: offset + 1,
      name: offset === 4 ? "run_command" : "read_file",
      args: offset === 4
        ? { command: "python 05_semantic_subspace.py" }
        : { path: `/work/materials/file-${offset}.csv` },
      result: offset === 4
        ? "exit code 1\nCUDA out of memory"
        : "author-provided summary data",
    }));
    const continuation = buildReproductionContinuation({
      recordedResults: [
        {
          id: "R1",
          claim: "Semantic subspace intervention",
          status: "inconclusive",
          evidence: "CUDA out of memory.",
          method: "blocked",
          evidenceToolCallIds: [5],
          evidenceExcerpt: "CUDA out of memory",
          blockerKind: "oom",
        },
        {
          id: "R2",
          claim: "Frozen-world propagation",
          status: "inconclusive",
          evidence: "The authors' CSV matches, but the script was not rerun due to time constraints.",
          method: "blocked",
          evidenceToolCallIds: [6],
          evidenceExcerpt: "author-provided summary data",
          blockerKind: "budget",
        },
        {
          id: "R3",
          claim: "Output robustness",
          status: "inconclusive",
          evidence: "The supplied chart matches, but there was not enough time to rerun it.",
          method: "blocked",
          evidenceToolCallIds: [7],
          evidenceExcerpt: "author-provided summary data",
          blockerKind: "budget",
        },
      ],
      toolCalls,
      logbook: [
        "## Claims", "Three inconclusive claims.",
        "## Reproduction Log", "One script attempted.",
        "## Discrepancies", "None measured.",
        "## Limitations", "Two scripts skipped due to time.",
      ].join("\n"),
      budgetExhausted: false,
    });

    expect(continuation).toContain("R2 cites time or budget as a blocker while useful budget remains");
    expect(continuation).toContain("R3 cites time or budget as a blocker while useful budget remains");
  });

  it("accepts a genuine OOM blocker with claim-specific command evidence", () => {
    const issues = getReproductionCompletionIssues({
      recordedResults: [{
        id: "R1",
        claim: "Full-scale intervention",
        status: "inconclusive",
        evidence: "The full experiment failed with CUDA out of memory.",
        method: "blocked",
        evidenceToolCallIds: [1],
        evidenceExcerpt: "CUDA out of memory",
        blockerKind: "oom",
      }],
      toolCalls: [{
        index: 1,
        name: "run_command",
        args: { command: "python full_experiment.py" },
        result: "exit code 1\nCUDA out of memory",
      }],
      logbook: [
        "## Claims", "R1 inconclusive.",
        "## Reproduction Log", "Attempted the full experiment.",
        "## Discrepancies", "None measurable.",
        "## Limitations", "A10G memory was insufficient.",
      ].join("\n"),
    });

    expect(issues).toEqual([]);
  });

  it("accepts an independent raw-data recomputation backed by a successful command", () => {
    const issues = getReproductionCompletionIssues({
      recordedResults: [{
        id: "R1",
        claim: "14 of 18 direct answers changed",
        status: "verified",
        originalValue: "14/18",
        reproducedValue: "14/18",
        evidence: "Python recomputed the count from raw per-example rows.",
        method: "raw-data-rederived",
        evidenceToolCallIds: [1, 2],
        evidenceExcerpt: "14/18",
        rawInputToolCallId: 1,
        rawInputPath: "/work/materials/raw.csv",
      }],
      toolCalls: [
        { index: 1, name: "read_file", args: { path: "/work/materials/raw.csv" }, result: "rows" },
        { index: 2, name: "run_command", args: { command: "python recompute.py /work/materials/raw.csv" }, result: "exit code 0\n14/18" },
      ],
      logbook: [
        "## Claims", "R1 verified.",
        "## Reproduction Log", "Recomputed from raw rows.",
        "## Discrepancies", "None.",
        "## Limitations", "None.",
      ].join("\n"),
    });

    expect(issues).toEqual([]);
  });

  it("rejects a generic successful exit status as claim evidence", () => {
    const issues = getReproductionCompletionIssues({
      recordedResults: [{
        id: "R1",
        claim: "A quantitative result",
        status: "inconclusive",
        evidence: "A command completed.",
        method: "rerun",
        evidenceToolCallIds: [1],
        evidenceExcerpt: "exit code 0",
      }],
      toolCalls: [{
        index: 1,
        name: "run_command",
        args: { command: "pip install pandas" },
        result: "exit code 0",
      }],
      logbook: [
        "## Claims", "R1 inconclusive.",
        "## Reproduction Log", "Installed a dependency.",
        "## Discrepancies", "None measured.",
        "## Limitations", "No experiment run.",
      ].join("\n"),
    });

    expect(issues).toContain("R1 method rerun does not quote evidence from a cited successful command");
  });

  it("rejects a README as the raw input for re-derivation", () => {
    const issues = getReproductionCompletionIssues({
      recordedResults: [{
        id: "R1",
        claim: "A quantitative result",
        status: "inconclusive",
        evidence: "Computed a diagnostic.",
        method: "raw-data-rederived",
        evidenceToolCallIds: [1, 2],
        evidenceExcerpt: "diagnostic complete",
        rawInputToolCallId: 1,
        rawInputPath: "/work/materials/README.md",
      }],
      toolCalls: [
        { index: 1, name: "read_file", args: { path: "/work/materials/README.md" }, result: "instructions" },
        {
          index: 2,
          name: "run_command",
          args: { command: "python helper.py /work/materials/README.md" },
          result: "exit code 0\ndiagnostic complete",
        },
      ],
      logbook: [
        "## Claims", "R1 inconclusive.",
        "## Reproduction Log", "Read instructions.",
        "## Discrepancies", "None measured.",
        "## Limitations", "No raw data.",
      ].join("\n"),
    });

    expect(issues).toContain("R1 raw-data re-derivation is not tied to a specific raw input read and computation");
  });

  it("does not let two claims reuse output that contains only one reproduced value", () => {
    const issues = getReproductionCompletionIssues({
      recordedResults: [
        {
          id: "R1",
          claim: "First metric",
          status: "verified",
          reproducedValue: "0.91",
          evidence: "Metrics command.",
          method: "rerun",
          evidenceToolCallIds: [1],
          evidenceExcerpt: "metric_a=0.91",
        },
        {
          id: "R2",
          claim: "Second metric",
          status: "verified",
          reproducedValue: "0.82",
          evidence: "Metrics command.",
          method: "rerun",
          evidenceToolCallIds: [1],
          evidenceExcerpt: "metric_a=0.91",
        },
      ],
      toolCalls: [{
        index: 1,
        name: "run_command",
        args: { command: "python metric_a.py" },
        result: "exit code 0\nmetric_a=0.91",
      }],
      logbook: [
        "## Claims", "Two claims.",
        "## Reproduction Log", "Ran metric A.",
        "## Discrepancies", "None.",
        "## Limitations", "Metric B was not run.",
      ].join("\n"),
    });

    expect(issues).toContain("R2 verified result does not include its reproduced value in the evidence excerpt");
  });

  it("does not let an inconclusive rerun reuse unrelated successful output", () => {
    const issues = getReproductionCompletionIssues({
      recordedResults: [{
        id: "R2",
        claim: "A second untested metric",
        status: "inconclusive",
        evidence: "A different command completed.",
        method: "rerun",
        evidenceToolCallIds: [1],
        evidenceExcerpt: "metric_a=0.91",
      }],
      toolCalls: [{
        index: 1,
        name: "run_command",
        args: { command: "python metric_a.py" },
        result: "exit code 0\nmetric_a=0.91",
      }],
      logbook: [
        "## Claims", "R2 inconclusive.",
        "## Reproduction Log", "Ran metric A only.",
        "## Discrepancies", "None measurable.",
        "## Limitations", "Metric B was not run.",
      ].join("\n"),
    });

    expect(issues).toContain("R2 inconclusive result does not include its reproduced value in the evidence excerpt");
  });

  it("rejects blocked claims that cite unrelated successful output", () => {
    const issues = getReproductionCompletionIssues({
      recordedResults: [{
        id: "R1",
        claim: "An experiment",
        status: "inconclusive",
        evidence: "Could not proceed.",
        method: "blocked",
        evidenceToolCallIds: [1],
        evidenceExcerpt: "accuracy,0.91",
        blockerKind: "command-error",
      }],
      toolCalls: [{
        index: 1,
        name: "read_file",
        args: { path: "/work/materials/summary.csv" },
        result: "accuracy,0.91",
      }],
      logbook: [
        "## Claims", "R1 inconclusive.",
        "## Reproduction Log", "Read a summary.",
        "## Discrepancies", "None.",
        "## Limitations", "Could not proceed.",
      ].join("\n"),
    });

    expect(issues).toContain("R1 blocker category and evidence excerpt do not match cited tool output: the cited output (#1) shows no failure: no non-zero exit code, TIMED OUT, Tool error, or not-found/missing message, so it cannot support a blocked result; cite the failing execution, or for an absent material a read_file/list_files call whose output reports it as not found");
  });

  describe("blocked-result refusals name the failed check", () => {
    const blocked = (overrides: Record<string, unknown>, output: string) => getReproductionClaimIssues({
      recordedResults: [{
        id: "R6", claim: "Patching improved the margin.", status: "inconclusive", method: "blocked",
        evidenceToolCallIds: [53], evidenceExcerpt: "exit code 137 (901.1s)", blockerKind: "timeout",
        evidence: "The patching script was killed after the full 900 s allotment (timeout).",
        ...overrides,
      } as any],
      toolCalls: [{ index: 53, name: "run_command", args: { command: "python analysis3.py" }, result: output }],
    });
    const killedOutput = "exit code 137 (901.1s)\n--- stdout ---\ntask 3/18\n--- stderr ---\n(empty)";
    const timedOutOutput = "TIMED OUT (901.1s)\n--- stdout ---\ntask 3/18\n--- stderr ---\n(empty)";

    it("accepts a timeout blocker once the host labels the Modal kill as TIMED OUT", () => {
      expect(blocked({ evidenceExcerpt: "TIMED OUT (901.1s)" }, timedOutOutput)).toEqual([]);
    });
    it("tells the model which kinds the cited output supports when the chosen kind does not fit", () => {
      expect(blocked({}, killedOutput)).toEqual([
        "R6 blocker category and evidence excerpt do not match cited tool output: blocker_kind timeout is not what the cited output (#53) shows; that output supports command-error",
      ]);
    });
    it("tells the model the excerpt is not a verbatim quote", () => {
      expect(blocked({ evidenceExcerpt: "exit code 137 after 901 seconds" }, killedOutput)).toEqual([
        "R6 blocker category and evidence excerpt do not match cited tool output: evidence_excerpt is not an exact quote from the cited tool output (#53). The excerpt matches the output through \"exit code 137 \", then diverges: the output continues \"(901.1s) --- stdout --- task 3/18 --- stderr --- (empty)\" but the excerpt continues \"after 901 seconds\".",
      ]);
    });
    it("tells the model which words the explanation must use for the chosen kind", () => {
      expect(blocked({ blockerKind: "command-error", evidence: "The script was killed after 901 seconds." }, killedOutput)).toEqual([
        "R6 blocker category and evidence excerpt do not match cited tool output: blocker_kind command-error requires the evidence or notes text to say error / failed / exception / dependency",
      ]);
      expect(blocked({ blockerKind: "command-error", evidence: "The script failed with exit code 137 after 901 seconds." }, killedOutput)).toEqual([]);
    });
  });

  it("rejects blocked as a conclusive result method", () => {
    const issues = getReproductionCompletionIssues({
      recordedResults: [{
        id: "R1",
        claim: "An experiment",
        status: "verified",
        reproducedValue: "0.91",
        evidence: "Command failed.",
        method: "blocked",
        evidenceToolCallIds: [1],
        evidenceExcerpt: "dependency failed",
        blockerKind: "command-error",
      }],
      toolCalls: [{
        index: 1,
        name: "run_command",
        args: { command: "python reproduce.py" },
        result: "exit code 1\ndependency failed",
      }],
      logbook: [
        "## Claims", "R1 verified.",
        "## Reproduction Log", "Command failed.",
        "## Discrepancies", "None.",
        "## Limitations", "Failure.",
      ].join("\n"),
    });

    expect(issues).toContain("R1 uses blocked method with non-inconclusive status verified");
  });

  it("deterministically finalizes pending claims when the deadline is exhausted", () => {
    const recordedResults = [{
      id: "R1",
      claim: "Long-running experiment",
      status: "pending" as const,
    }];
    const toolCalls = [{
      index: 4,
      name: "run_command",
      args: { command: "python long_run.py" },
      result: "TIMED OUT",
      durationMs: 900_000,
      error: true,
    }];

    finalizeBudgetExhaustedResults({
      recordedResults,
      toolCalls,
      stoppedBy: "deadline",
    });

    expect(recordedResults[0]).toMatchObject({
      status: "inconclusive",
      method: "blocked",
      evidenceToolCallIds: [],
      blockerKind: "budget",
    });
    expect(recordedResults[0].evidence).toContain("System-enforced deadline exhaustion");
  });
});

describe("Reproduction — rerun eligibility", () => {
  it("allows failed and completed inconclusive runs", () => {
    expect(canRetryReproduction({ status: "failed", overallVerdict: null })).toBe(true);
    expect(canRetryReproduction({ status: "completed", overallVerdict: "inconclusive" })).toBe(true);
  });

  it("rejects active and conclusive completed runs", () => {
    expect(canRetryReproduction({ status: "pending", overallVerdict: null })).toBe(false);
    expect(canRetryReproduction({ status: "generating", overallVerdict: null })).toBe(false);
    expect(canRetryReproduction({ status: "completed", overallVerdict: "verified" })).toBe(false);
    expect(canRetryReproduction({ status: "completed", overallVerdict: "falsified" })).toBe(false);
  });
});

describe("Reproduction — Future Science revisions", () => {
  it("maps falsified to major and toy/inconclusive to minor, verified to neither", () => {
    const { major, minor } = verdictsToRevisions(sample);
    expect(major).toHaveLength(1);
    expect(major[0].description).toContain("R2");
    expect(major[0].description).toContain("reported: 1.0");
    expect(minor.map(m => m.description.slice(0, 2))).toEqual(["R3", "R4"]);
  });
  it("produces revisions that survive FS normalisation", () => {
    const { major } = verdictsToRevisions(sample);
    expect(normalizeRevisions(major)).toHaveLength(1);
  });
  it("reproduction reports lead with the response-style FS type", () => {
    expect(_FS_TYPE_FALLBACKS_FOR_TEST.reproduction[0]).toBe("Response to a contribution");
  });
});

describe("Future Science — agent description normalization", () => {
  it("keeps descriptions at or below the limit unchanged", () => {
    const description = "x".repeat(255);
    expect(normalizeAgentDescription(description)).toBe(description);
  });

  it("cuts long descriptions to 255 characters including the ellipsis", () => {
    const normalized = normalizeAgentDescription("x".repeat(300));
    expect(normalized).toHaveLength(255);
    expect(normalized?.endsWith("…")).toBe(true);
  });
});

describe("Reproduction — report composition", () => {
  it("builds a title the catalogue filter recognises as an institute publication", () => {
    const title = buildReproductionTitle("Safety Heads Are Relational Assessment Heads");
    expect(title).toBe('Reproduction Report: "Safety Heads Are Relational Assessment Heads"');
    expect(isOwnPublication(title, "Some Author")).toBe(true);
  });
  it("recognises the P agent code as an institute author", () => {
    expect(isOwnPublication("Anything", buildConventionName("anthropic/claude-sonnet-4-5", "P"))).toBe(true);
    expect(buildConventionName("anthropic/claude-sonnet-4-5", "P")).toBe("MachInstit CS45P-N1");
  });
  it("stamps the judge model and sandbox into the FS agent description", () => {
    const desc = buildFsAgentDescription({ model: "openai/gpt-5", agentId: "P", providerMode: "platform", extra: ["Judge model: deepseek/deepseek-chat", "Sandbox: Modal A10G"] });
    expect(desc).toContain("Agent: P (Reproduction Agent)");
    expect(desc).toContain("Judge model: deepseek/deepseek-chat");
    expect(desc).toContain("Sandbox: Modal A10G");
  });
  it("writes a substantive abstract under the FS length cap", () => {
    const abstract = buildReproductionAbstract({ paperTitle: "T", overall: "falsified", counts: countVerdicts(sample), summary: "One result did not hold.", gpu: "A10G", realExecution: true });
    expect(abstract).toContain("overall verdict: falsified");
    expect(abstract).toContain("1 verified, 1 falsified, 1 toy-scale, 1 inconclusive");
    expect(abstract).toContain("A10G");
    expect(abstract.length).toBeLessThanOrEqual(1200);
  });
  it("renders every result, the logbook, and the executed commands in the markdown", () => {
    const md = buildReproductionMarkdown({
      paperTitle: "T", paperAuthors: "A", paperDate: "2026-01-01", paperUrl: "https://future-science.org/mirror/x", journalDisplayName: "Mirror",
      overall: "falsified", results: sample, judgeSummary: "Judge says.", logbook: "## Claims\n- R1", materialsInventory: "- /work/materials/README.md",
      materialsCounts: { text: 3, binary: 2 },
      environment: { gpu: "A10G", image: "img", reproducerModel: "m", judgeModel: "j", maxToolCalls: 100, wallClockMinutes: 120, perCommandMinutes: 15 },
      toolCalls: [
        { index: 1, name: "read_file", args: { path: "/work/paper.md" }, durationMs: 100, error: false, resultPreview: "..." },
        { index: 2, name: "run_command", args: { command: "python 01.py" }, durationMs: 61000, error: false, resultPreview: "exit code 0" },
      ],
      stoppedBy: "model", sandboxAvailable: true,
    });
    for (const r of sample) expect(md).toContain(`### ${r.id}`);
    expect(md).toContain("Judge says.");
    expect(md).toContain("## Reproduction Logbook");
    expect(md).toContain("`python 01.py`");
    expect(md).toContain("Modal GPU sandbox (A10G)");
  });
  it("prompts describe the four-verdict scale and the logbook contract", () => {
    for (const v of ["verified", "falsified", "toy", "inconclusive"]) {
      expect(REPRODUCER_PROMPT).toContain(v);
      expect(JUDGE_PROMPT).toContain(v);
    }
    expect(REPRODUCER_PROMPT).toContain("## Reproduction Log");
    expect(REPRODUCER_PROMPT).toContain("evidence_tool_call_ids");
    expect(REPRODUCER_PROMPT).toContain("raw-data-rederived");
    expect(JUDGE_PROMPT).toContain("```json");
  });
});
