import { describe, expect, it } from "vitest";
import { ReproductionReadGuard } from "../reproduction-read-guard";

const page = (start: number, end: number, total = 32000) =>
  `Verified file: /work/paper.md\nReturned characters: ${start}-${end} of ${total}\n---\n${"x".repeat(end - start)}`;
const state = { acceptedClaims: 0, assessed: false };

describe("reproduction read guard", () => {
  it("recognizes overlapping repeated pages and gives a real unread offset without losing the verified source", () => {
    const guard = new ReproductionReadGuard();
    expect(guard.observe("read_file", page(0, 8000), state)).toContain("Returned characters: 0-8000");
    expect(guard.observe("read_file", page(6000, 18000), state)).not.toContain("Repeated inspection");
    expect(guard.observe("read_file", page(2000, 9000), state)).not.toContain("Repeated inspection");
    const repeated = guard.observe("read_file", page(1, 10001), state);
    expect(repeated).toContain("Repeated inspection 2/7");
    expect(repeated).toContain("offset=18000");
    expect(repeated).toContain("Returned characters: 1-10001");
    expect(guard.stopReason).toBeNull();
  });

  it("allows sequential reading, new directories and genuine claim/assessment progress", () => {
    const guard = new ReproductionReadGuard();
    for (let offset = 0; offset < 32000; offset += 4000) {
      expect(guard.observe("read_file", page(offset, offset + 4000), state)).not.toContain("Repeated inspection");
    }
    const listed = "Verified directory: /work/materials\nf README.md";
    guard.observe("list_files", listed, state);
    guard.observe("list_files", listed, state);
    expect(guard.observe("list_files", listed, state)).toContain("Repeated inspection 2/7");
    expect(guard.observe("record_result", "Registered R1 as pending", { acceptedClaims: 1, assessed: false })).toBe("Registered R1 as pending");
    expect(guard.observe("list_files", listed, { acceptedClaims: 1, assessed: false })).not.toContain("Repeated inspection");
    guard.observe("list_files", listed, { acceptedClaims: 1, assessed: false });
    expect(guard.observe("list_files", listed, { acceptedClaims: 1, assessed: true })).not.toContain("Repeated inspection");
  });

  it("does not treat archive retrieval, refused reads, or repeated registrations as new source evidence", () => {
    const guard = new ReproductionReadGuard();
    const listed = "Verified directory: /work/materials\nf README.md";
    guard.observe("list_files", listed, state);
    guard.observe("read_reproduction_context", '{"text":"prior history","next_offset":10}', state);
    guard.observe("list_files", listed, state);
    expect(guard.observe("list_files", listed, state)).toContain("Repeated inspection 2/7");
    expect(guard.observe("read_file", "Refused: inaccessible", state)).toBe("Refused: inaccessible");
    guard.observe("record_result", "Unchanged: R1 remains pending", state);
    for (let i = 0; i < 5; i++) guard.observe("list_files", listed, state);
    expect(guard.stopReason).toMatch(/Repeated already-delivered/);
  });

  it("does not mark a middle-truncated page as delivered when only its prefix was visible", () => {
    const guard = new ReproductionReadGuard();
    const partial = "Verified file: /work/paper.md\nReturned characters: 0-24000 of 32000\n---\n"
      + "x".repeat(8100) + "\n\n[... 12000 chars truncated ...]\n\n" + "x".repeat(3500);
    guard.observe("read_file", partial, state);
    guard.observe("read_file", partial, state);
    expect(guard.observe("read_file", partial, state)).toContain("offset=8100");
    expect(guard.observe("read_file", page(8100, 16000), state)).not.toContain("Repeated inspection");
  });

  it("treats a changed experiment output and a changed directory listing as new information", () => {
    const guard = new ReproductionReadGuard();
    const output = (text: string) =>
      `Verified file: /work/results/metrics.json\nReturned characters: 0-${text.length} of ${text.length}\n---\n${text}`;
    const original = output('{"epoch":1}');
    const revised = output('{"epoch":2}');
    guard.observe("read_file", original, state);
    guard.observe("read_file", original, state);
    expect(guard.observe("read_file", original, state)).toContain("Repeated inspection 2/7");
    expect(guard.observe("read_file", revised, state)).not.toContain("Repeated inspection");
    expect(guard.observe("read_file", revised, state)).not.toContain("Repeated inspection");

    const first = "Verified directory: /work/results\nf metrics.json (11 B)";
    const second = "Verified directory: /work/results\nf metrics.json (11 B)\nf experiment-2.csv (99 B)";
    guard.observe("list_files", first, state);
    guard.observe("list_files", first, state);
    expect(guard.observe("list_files", first, state)).toContain("Repeated inspection 2/7");
    expect(guard.observe("list_files", second, state)).not.toContain("Repeated inspection");
    for (let i = 0; i < 4; i++) {
      const next = `Verified directory: /work/results\nf new-${i}.csv`;
      expect(guard.observe("list_files", next, state)).not.toContain("Repeated inspection");
    }
    expect(guard.stopReason).toBeNull();
  });
});