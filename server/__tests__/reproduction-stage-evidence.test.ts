import { describe, expect, it } from "vitest";
import { executionEvidenceIndex, executionRecoveryExcerpt, rerunEvidenceIssue, repeatExecutionRefusal } from "../reproduction-stage-evidence";
const paths = ["/work/materials/analyze.py"];
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
  it("does not combine a successful unrelated command with a failed source run", () => {
    expect(rerunEvidenceIssue([run(1, "exit code 1\nscore=0.966667"), run(2, "exit code 0\nscore=0.966667", "cat results.csv")],
      paths, { ...args, evidence_tool_call_ids: [1, 2] })).toContain("not a standalone");
  });
});
