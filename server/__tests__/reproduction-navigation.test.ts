import { expect, it } from "vitest";
import { inspectionIndex } from "../reproduction-navigation";
const read = (index: number, text: string, start = 0) => ({
  index, name: "read_file", args: { path: "/work/data.csv" }, error: false,
  result: `Verified file: /work/data.csv\nReturned characters: ${start}-${start + text.length} of 10000\n---\n${text}`,
});
it("deduplicates identical captured pages while retaining original evidence IDs", () => {
  const index = inspectionIndex([read(1, "abc"), read(2, "abc")]);
  expect(index.pages).toHaveLength(1);
  expect(index.pages[0]).toMatchObject({ readToolCallId: 1, latestReadToolCallId: 2, identicalCaptures: 2, start: 0, end: 3 });
  expect(index.pages[0].retrieve.tool_call_id).toBe(1);
});
it("keeps changed content and distinct ranges separate without claiming freshness", () => {
  const index = inspectionIndex([read(1, "abc"), read(2, "xyz"), read(3, "abc", 50)]);
  expect(index.pages).toHaveLength(3);
  expect(index.pages[0].capturedPageSha256).not.toBe(index.pages[1].capturedPageSha256);
  expect(index.notice).toContain("not current file contents");
  expect(index.notice).toContain("read_file remains available");
});
it("ignores failed, mismatched and non-page records and bounds navigation without mutating evidence", () => {
  const calls = Array.from({ length: 40 }, (_, i) => read(i + 1, String(i)));
  const index = inspectionIndex([...calls, { ...read(41, "failed"), error: true },
    { ...read(42, "mismatch"), args: { path: "/elsewhere" } }, { ...read(43, "abc"), name: "run_command" }]);
  expect(index.pages).toHaveLength(30);
  expect(index.pages[0].readToolCallId).toBe(11);
  expect(calls).toHaveLength(40);
});
