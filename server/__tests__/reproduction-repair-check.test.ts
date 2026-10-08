import { describe, expect, it } from "vitest";
import { missingFileRepairIssue } from "../reproduction-repair-check";
const paths = ["/work/materials/analyze.py"];
const command = "python /work/materials/analyze.py";
const missing = "/work/data/history.json";
const call = (index: number, name: string, args: Record<string, unknown>, result: string, error = false) =>
  ({ index, name, args, result, error });
const failed = call(1, "run_command", { command },
  `exit code 1\nFileNotFoundError: [Errno 2] No such file or directory: '${missing}'`);
const read = (index: number, path = missing, error = false) =>
  call(index, "read_file", { path }, `Verified file: ${path}\nReturned characters: 0-2 of 2\n---\n{}`, error);
describe("missing-file retry preflight", () => {
  it("blocks the observed mkdir-only repair before another full experiment", () => {
    expect(missingFileRepairIssue([failed, call(2, "run_command", { command: "mkdir -p /work/data" }, "exit code 0")], paths, { command }))
      .toContain("mkdir alone does not restore a file");
  });
  it("allows inspection of the restored exact file, without claiming scientific validity", () => {
    expect(missingFileRepairIssue([failed, read(2)], paths, { command })).toBeUndefined();
  });
  it.each([read(0), read(2, "/work/data/other.json"), read(2, missing, true)])("rejects stale, unrelated or failed inspection", evidence => {
    expect(missingFileRepairIssue([evidence, failed], paths, { command })).toContain("Refused before retrying");
  });
  it("permits an inspected source repair, but not source inspection alone", () => {
    expect(missingFileRepairIssue([failed, read(2, paths[0])], paths, { command })).toBeDefined();
    expect(missingFileRepairIssue([failed, call(2, "write_file", { path: paths[0] }, "Refused: unauthorized"),
      read(3, paths[0])], paths, { command })).toBeDefined();
    expect(missingFileRepairIssue([failed, call(2, "write_file", { path: paths[0] }, `Wrote 0 chars to ${paths[0]}.`),
      read(3, paths[0])], paths, { command })).toBeUndefined();
  });
  it("leaves new experiments, successful repeats and unrelated errors to their existing guards", () => {
    expect(missingFileRepairIssue([], paths, { command })).toBeUndefined();
    expect(missingFileRepairIssue([failed, call(2, "run_command", { command }, "exit code 0")], paths, { command })).toBeUndefined();
    expect(missingFileRepairIssue([failed], paths, { command: "python -c 'print(1)'"})).toBeUndefined();
    expect(missingFileRepairIssue([{ ...failed, result: "exit code 1\nValueError: incompatible shapes" }], paths, { command })).toBeUndefined();
  });
});
