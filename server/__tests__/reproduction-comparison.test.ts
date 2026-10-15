import { expect, it } from "vitest";
import { falsificationRejection, type FalsificationAssessment } from "../reproduction-comparison";
import { parseJudgeOutput } from "../prompts/reproduce";
import type { ToolCallRecord } from "../model-service";

const execution = (result: string): ToolCallRecord => ({
  index: 1, name: "run_command", args: { command: "python analysis.py" }, result,
});
const assessment = (quote: string): FalsificationAssessment => ({
  conditionsMatch: true,
  comparisonExplanation: "Same dataset, subset, metric and intervention.",
  substantiveContradiction: true,
  contradictionExplanation: "The measured effect contradicts the stated effect.",
  toleranceBasis: "uncertainty-separated",
  toleranceExplanation: "Compare the reported experimental uncertainty.",
  evidenceToolCallId: 1, evidenceQuote: quote,
});
const recorded = (claim: string) => ({
  id: "R1", claim, status: "falsified" as const, evidenceToolCallIds: [1],
});

it.each([
  ["R9", "Mean +0.001 [-0.031, 0.035]", "Measured mean -0.026 [-0.076, 0.021], 43.3% improved"],
  ["R10", "Mean +0.132 [0.085, 0.188]", "Measured mean +0.108 [0.067, 0.151], 68.9% improved"],
  ["R15", "Mean -0.046 [-0.087, -0.005]", "Measured mean -0.077 [-0.130, -0.030]"],
])("rejects the disputed %s rationale irrespective of wording", (_, claim, output) => {
  expect(falsificationRejection(assessment(output), recorded(claim), output, [execution(output)]))
    .toContain("overlap");
  expect(falsificationRejection(undefined, recorded(claim), output, [execution(output)]))
    .toContain("Missing structured");
});

it("accepts grounded nonoverlapping uncertainty with an explicit comparison", () => {
  const output = "Measured negative effect -0.3 [-0.4, -0.2]";
  expect(falsificationRejection(assessment(output), recorded("Positive effect [0.1, 0.3]"),
    output, [execution(output)])).toBeUndefined();
});

it("rejects fabricated citations, invalid intervals and compound ambiguous intervals", () => {
  const output = "Measured negative effect -0.3 [-0.4, -0.2]";
  for (const value of [{ ...assessment(output), evidenceToolCallId: 9 },
    { ...assessment(output), evidenceQuote: "Invented experimental observation" }]) {
    expect(falsificationRejection(value, recorded("Effect [0.1, 0.3]"), output, [execution(output)]))
      .toContain("exact quote");
  }
  expect(falsificationRejection(assessment(output), recorded("Effect [0.3, 0.1]"), output, [execution(output)]))
    .toContain("invalid");
  expect(falsificationRejection(assessment(output), recorded("Effects [0.1, 0.3] and [0.4, 0.5]"), output, [execution(output)]))
    .toContain("unambiguous");
});

it("requires documented numerical tolerance and rejects invented precision", () => {
  const output = "The measured experimental score was 0.50.";
  const source: ToolCallRecord = { index: 2, name: "read_file", args: { path: "/work/materials/protocol.md" },
    result: "The prespecified absolute tolerance for this score is 0.05." };
  const a = { ...assessment(output), toleranceBasis: "documented-tolerance",
    originalEstimate: 0.9, reproducedEstimate: 0.5, documentedTolerance: 0.05,
    toleranceToolCallId: 2, toleranceQuote: source.result };
  const r = recorded("The experimental score was 0.90.");
  expect(falsificationRejection(a, r, output, [execution(output), source])).toBeUndefined();
  expect(falsificationRejection({ ...a, documentedTolerance: 0 }, r, output, [execution(output), source]))
    .toContain("grounded");
  expect(falsificationRejection(a, r, output, [execution(output), source,
    { index: 3, name: "write_file", args: { path: source.args.path }, result: "written" }]))
    .toContain("grounded");
});

it("parses assessment fields without changing verified verdicts", () => {
  const result = parseJudgeOutput(JSON.stringify({ results: [
    { id: "R1", claim: "Claim", verdict: "falsified", falsification_assessment: assessment("A measured result from execution") },
    { id: "R2", claim: "Other claim", verdict: "verified" },
  ] }));
  expect(result.results[0].falsificationAssessment).toHaveProperty("conditionsMatch", true);
  expect(result.results[1].verdict).toBe("verified");
});
