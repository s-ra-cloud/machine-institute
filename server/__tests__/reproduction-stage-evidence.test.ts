import { describe, expect, it } from "vitest";
import { containsExcerpt, excerptMismatchHint, executionEvidenceIndex, executionRecoveryExcerpt, findExcerpt, rerunEvidenceIssue, repeatExecutionRefusal, sharedMeasurementIssue } from "../reproduction-stage-evidence";
const paths = ["/work/materials/analyze.py"];
describe("shared measurement handoffs", () => {
  const calls = [{ index: 7, name: "run_command", args: {}, result: "exit code 0\ncondition_1=0.91\ncondition_2=0.90" }];
  const entries = [
    { claimId: "R1", evidence_tool_call_id: 7, evidence_excerpt: "condition_1=0.91" },
    { claimId: "R2", evidence_tool_call_id: 7, evidence_excerpt: "condition_2=0.90" },
  ];
  it("requires every member without silently accepting missing measurements", () => {
    expect(sharedMeasurementIssue(["R1"], undefined, calls)).toBeUndefined();
    expect(sharedMeasurementIssue(["R1", "R2"], undefined, calls)).toContain("every grouped claim");
    expect(sharedMeasurementIssue(["R1", "R2"], entries, calls)).toBeUndefined();
    expect(sharedMeasurementIssue(["R1", "R2"], [entries[0], entries[0]], calls)).toContain("exactly once");
    expect(sharedMeasurementIssue(["R1", "R2"], [entries[0], { claimId: "R2", limitation: "Raw observations unavailable." }], calls)).toBeUndefined();
  });
  it("rejects nonexistent, failed, read-only or invented measurement evidence", () => {
    for (const [call, reason] of [
      [{ ...calls[0], index: 8 }, "unknown original tool ID"],
      [{ ...calls[0], name: "read_file" }, "not an execution"],
      [{ ...calls[0], result: "exit code 137\ncondition_1=0.91" }, "did not succeed"],
      [{ ...calls[0], error: true }, "did not succeed"],
      [{ ...calls[0], result: "exit code 0\nunrelated output" }, "quote differs"],
    ] as const) expect(sharedMeasurementIssue(["R1", "R2"], entries, [call])).toContain(reason);
  });
  it("hands off original references without copying tables, but rejects fabricated rerun evidence", () => {
    const refs = entries.map(({ claimId, evidence_tool_call_id }) => ({ claimId, evidence_tool_call_id }));
    const original = { ...calls[0], args: { command: "python /work/materials/analyze.py" } };
    expect(sharedMeasurementIssue(["R1", "R2"], refs, [original], paths)).toBeUndefined();
    expect(sharedMeasurementIssue(["R1", "R2"], refs,
      [{ ...original, args: { command: "python -c \"print('condition_1=0.91')\"" } }], paths))
      .toContain("not a standalone planned source execution");
    expect(sharedMeasurementIssue(["R1", "R2"], refs, [{ ...original, name: "read_tool_result" }], paths))
      .toContain("not an execution");
  });
});
const run = (index: number, result: string, command = "python /work/materials/analyze.py") => ({
  index, name: "run_command", args: { command }, result,
});
const args = { evidence_tool_call_ids: [1], evidence_excerpt: "score=0.966667", reproduced_value: "0.966667" };
describe("stage evidence handoff", () => {
  it("requires an explicit reason for repeating a successful source execution without inventing evidence", () => {
    const previous = run(17, "exit code 0\nscore=0.966667");
    expect(repeatExecutionRefusal([previous], paths, previous.args)).toContain("original tool call #17");
    expect(repeatExecutionRefusal([previous], paths, { ...previous.args, repeat_reason: " " })).toContain("Refused");
    expect(repeatExecutionRefusal([previous], paths, { ...previous.args, repeat_reason: "An independent replicate is required." })).toBeUndefined();
    expect(repeatExecutionRefusal([previous], paths, { ...previous.args, repeat_reason: "Input data changed." })).toBeUndefined();
    expect(repeatExecutionRefusal([run(17, "exit code 137")], paths, previous.args)).toBeUndefined();
    expect(repeatExecutionRefusal([{ ...previous, error: true }], paths, previous.args)).toBeUndefined();
    expect(repeatExecutionRefusal([previous], paths, { command: `${previous.args.command} --seed 9` })).toBeUndefined();
    expect(repeatExecutionRefusal([previous], paths, { ...previous.args, working_directory: "/work/materials" })).toBeUndefined();
    expect(repeatExecutionRefusal([run(17, "exit code 0", "cat results.csv")], paths, { command: "cat results.csv" })).toBeUndefined();
  });
  it("keeps execution references after subsequent file reads without copying bulk output", () => {
    const source = run(1, `exit code 0\n${"noise".repeat(2000)}\nscore=0.966667`);
    const reads = Array.from({ length: 20 }, (_, n) => ({ index: n + 2, name: "read_file", args: {}, result: "source code" }));
    const index = executionEvidenceIndex([source, ...reads]);
    expect(index).toHaveLength(1);
    expect(index[0].id).toBe(1);
    expect(source.result.slice(index[0].retrieveTail.offset)).toContain("score=0.966667");
    expect(JSON.stringify(index).length).toBeLessThan(600);
  });
  it("retains failure details rather than only verbose stdout", () => {
    const excerpt = executionRecoveryExcerpt(run(1, `exit code 1\n${"stdout".repeat(2000)}\nFileNotFoundError: confidence_history.json`));
    expect(excerpt).toContain("FileNotFoundError: confidence_history.json");
    expect(excerpt.length).toBeLessThan(400);
  });
  it("distinguishes wrong IDs, failed commands, non-source commands and formatting errors", () => {
    expect(rerunEvidenceIssue([], paths, args)).toContain("original run_command ID");
    expect(rerunEvidenceIssue([run(1, "exit code 1\nscore=0.966667")], paths, args)).toContain("did not succeed");
    expect(rerunEvidenceIssue([run(1, "exit code 0\nscore=0.966667", "cat results.csv")], paths, args)).toContain("not a standalone");
    expect(rerunEvidenceIssue([run(1, "exit code 0\nscore=0.966667")], paths, { ...args, evidence_excerpt: "score = 0.966667" })).toContain("copied exactly");
    expect(rerunEvidenceIssue([run(1, "exit code 0\nscore=0.966667")], paths, { ...args, reproduced_value: "0.967" })).toContain("literally");
    expect(rerunEvidenceIssue([run(1, "exit code 0\nscore=0.966667")], paths, args)).toBeUndefined();
  });
  it("accepts a quote whose whitespace was collapsed while copying a table, and points at the divergence otherwise", () => {
    const table = "exit code 0\n  task      clean   misleading\n  parity    1.000   0.411\nmargin_mean = 0.3121\n";
    expect(rerunEvidenceIssue([run(1, table)], paths, { ...args, evidence_excerpt: "parity 1.000 0.411", reproduced_value: "0.411" })).toBeUndefined();
    const issue = rerunEvidenceIssue([run(1, table)], paths, { ...args, evidence_excerpt: "parity    1.000   0.412", reproduced_value: "0.412" })!;
    expect(issue).toContain("copied exactly from one cited successful source execution (#1)");
    expect(issue).toContain('matches the output through "parity 1.000 0.41", then diverges: the output continues "1 margin_mean = 0.3121" but the excerpt continues "2"');
    expect(rerunEvidenceIssue([run(1, table)], paths, { ...args, evidence_excerpt: "accuracy was perfect on parity" })).toContain("No 12-character run from the start of the excerpt occurs in the cited output");
  });
  it("does not combine a successful unrelated command with a failed source run", () => {
    expect(rerunEvidenceIssue([run(1, "exit code 1\nscore=0.966667"), run(2, "exit code 0\nscore=0.966667", "cat results.csv")],
      paths, { ...args, evidence_tool_call_ids: [1, 2] })).toContain("not a standalone");
  });
});

describe("excerpt location", () => {
  it("finds exact and whitespace-collapsed quotes with raw offsets", () => {
    const output = "exit code 0\nalpha\t=  0.91\n\nbeta = 0.5";
    expect(findExcerpt(output, "alpha\t=  0.91")).toEqual({ start: 12, end: 25 });
    const collapsed = findExcerpt(output, "alpha = 0.91 beta")!;
    expect(output.slice(collapsed.start, collapsed.end)).toBe("alpha\t=  0.91\n\nbeta");
    expect(containsExcerpt(output, "alpha=0.91")).toBe(false);
    expect(containsExcerpt(output, "  ")).toBe(false);
    expect(excerptMismatchHint(output, "beta = 0.6")).toContain("too short");
  });
});
