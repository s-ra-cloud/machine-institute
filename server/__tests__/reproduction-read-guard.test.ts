import { describe, expect, it } from "vitest";
import { ReproductionReadGuard } from "../reproduction-read-guard";
import { renderSourcePage } from "../reproduction-source-page";
import { ReproductionSession } from "../reproduction-session";

const page = (start: number, end: number, total = 32000) =>
  `Verified file: /work/paper.md\nReturned characters: ${start}-${end} of ${total}\n---\n${"x".repeat(end - start)}`;
const state = { acceptedClaims: 0, assessed: false };

describe("reproduction read guard", () => {
  it("keeps repeated retrievals resizable with truthful displayed continuation offsets", () => {
    const session = new ReproductionSession(() => []);
    const guard = new ReproductionReadGuard();
    session.observeToolCall({ index: 1, name: "run_command", args: { command: "mock" },
      result: "x".repeat(10000), error: false, durationMs: 0 });
    const original = session.readToolResult({ tool_call_id: 1 });
    for (let i = 0; i < 3; i++) {
      expect(guard.observe("read_tool_result", original, state, i + 2)).toBe(original);
    }
    const resized = session.resizeRetrieval("read_tool_result", { tool_call_id: 1 }, original, 800)!;
    expect(resized).toBeDefined();
    const end = Number(resized.match(/characters 0-(\d+)/)![1]);
    expect(resized).toContain(`Use offset=${end} to continue`);
    expect(end).toBeLessThan(Number(original.match(/characters 0-(\d+)/)![1]));
    expect(guard.navigationInstruction).toContain("displayed output page's continuation offset");
    expect(session.progress).toBe(1); // Only the original mock command, not retrieval.
    expect(session.toolCalls).toHaveLength(1);
  });
  it("bounds entire Unicode source pages with exact contiguous metadata and explicit offsets", () => {
    const text = '🧪"\\\n測定'.repeat(4000);
    const guard = new ReproductionReadGuard();
    let offset = 0;
    let index = 1;
    while (offset < text.length) {
      const result = renderSourcePage("/work/paper.md", text, offset, 12000);
      const header = /^Verified file: \/work\/paper.md\nReturned characters: (\d+)-(\d+) of (\d+)\n---\n/.exec(result);
      expect(header).not.toBeNull();
      const end = Number(header![2]);
      expect(Number(header![1])).toBe(offset);
      expect(Number(header![3])).toBe(text.length);
      expect(result).toContain(text.slice(offset, end));
      if (end < text.length) expect(result).toContain(`Use offset=${end}`);
      expect(end).toBeGreaterThan(offset);
      expect(text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff).toBe(false);
      guard.observe("read_file", result, state, index++);
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(9000);
      offset = end;
    }
    expect(offset).toBe(text.length);
    expect(guard.navigationInstruction).toBeNull();
    expect(renderSourcePage("/work/paper.md", text, 182, 300))
      .toContain("Returned characters: 182-482");
    expect(Buffer.byteLength(JSON.stringify(guard.navigationInstruction), "utf8")).toBeLessThanOrEqual(500);
  });

  it("keeps active extraction and source navigation concise and grounded in original source IDs", () => {
    const guard = new ReproductionReadGuard();
    guard.observe("read_file", page(0, 8000), state, 3);
    expect(guard.navigationInstruction).toContain('read_file path="/work/paper.md", offset=8000');
    const text = "## Results\nRecovery was 0.99 on 10 samples.";
    guard.observe("read_file",
      `Verified file: /work/paper.md\nReturned characters: 8000-${8000 + text.length} of 32000\n---\n${text}`, state, 4);
    expect(guard.navigationInstruction).toContain("source_tool_call_id=4");
    expect(guard.navigationInstruction).toContain("original read_file #4");
    expect(guard.navigationInstruction).not.toContain("source_tool_call_id=3");
    expect(Buffer.byteLength(JSON.stringify(guard.navigationInstruction), "utf8")).toBeLessThanOrEqual(500);
  });

  it("counts repeated archived output prefixes without resetting source repetition or treating retrieval as source", () => {
    const guard = new ReproductionReadGuard();
    const original = (start: number, end: number) =>
      `Original evidence tool call #9 (read_file); characters ${start}-${end} of 100. Cite #9, not this retrieval call. Sandbox capture elision markers mean uncaptured output; inspect saved output files for those portions.\n${"x".repeat(end - start)}\n[Use offset=${end} to continue.]`;
    guard.observe("read_file", page(0, 100), state, 1);
    guard.observe("read_file", page(0, 100), state, 2);
    guard.observe("read_tool_result", original(0, 20), state, 3);
    expect(guard.navigationInstruction).toContain("read_file");
    guard.observe("read_tool_result", original(20, 40), state, 4);
    expect(guard.pagingDiagnostics.outputNewRangeCount).toBe(2);
    expect(guard.observe("read_file", page(0, 100), state, 5)).toContain("Repeated inspection 2/7");
    for (let i = 0; i < 5; i++) guard.observe("read_tool_result", original(0, 20), state, i + 6);
    expect(guard.pagingDiagnostics.outputRepeatCount).toBe(5);
    expect(guard.pagingDiagnostics.navigation).toBe("source");
    expect(guard.stopReason).toMatch(/Repeated already-delivered/);
    expect(JSON.stringify(guard.pagingDiagnostics)).not.toContain("/work");
  });

  it("provides archived index/output continuation coordinates when paper is complete", () => {
    const guard = new ReproductionReadGuard();
    const index = "Evidence index characters 0-5 of 30.\nabcde\n[Use read_tool_result offset=5 to continue evidence index.]";
    guard.observe("read_tool_result", index, state, 2);
    expect(guard.navigationInstruction).toContain("displayed index page's continuation offset");
    const output = "Original evidence tool call #1 (run_command); characters 0-3 of 50. Cite #1, not this retrieval call. Sandbox capture elision markers mean uncaptured output; inspect saved output files for those portions.\nabc\n[Use offset=3 to continue.]";
    guard.observe("read_tool_result", output, state, 3);
    expect(guard.navigationInstruction).toContain("tool_call_id=1");
    expect(guard.navigationInstruction).toContain("displayed output page's continuation offset");
    expect(guard.navigationInstruction).toContain("Cite original evidence #1");
  });
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

  it("hands off a visible Results passage using its original numbered read and exact page range", () => {
    const guard = new ReproductionReadGuard();
    const text = "## 3. Results\nThe held-out evaluation reports 0.992 recovery and 16/16 donor answers.";
    const result = `Verified file: /work/paper.md\nReturned characters: 11412-${11412 + text.length} of 32245\n---\n${text}`;
    const guided = guard.observe("read_file", result, state, 12);
    expect(guided).toContain(text);
    expect(guided).toContain("source_tool_call_id=12");
    expect(guided).toContain(`source_location="characters 11412-${11412 + text.length}"`);
    expect(guided).toContain('status="pending"');
    expect(guided).not.toContain('claim="');
    expect(guard.extractionInstruction).toContain("read_tool_result");
    guard.observe("read_reproduction_context", '{"error":"Refused: ref must identify archived reproduction context."}', state, 13);
    for (let i = 0; i < 2; i++) guard.observe("list_files", "Verified directory: /work\nf paper.md", state, 14 + i);
    expect(guard.observe("list_files", "Verified directory: /work\nf paper.md", state, 16))
      .toContain("source_tool_call_id=12");
    expect(guard.observe("record_result", "Registered R1 as pending", { acceptedClaims: 1, assessed: false }, 17))
      .not.toContain("NEXT ACTION");
    expect(guard.extractionInstruction).toBeNull();
    expect(guard.stopReason).toBeNull();
  });

  it("finds numeric results in deeper subsections but not a later sibling section", () => {
    const nested = new ReproductionReadGuard();
    const text = "## 4 Results\n### 4.1 Primary outcome\nObserved recovery was 0.91 across 12 runs.\n## Discussion\n";
    const read = (body: string, id: number, guard: ReproductionReadGuard) =>
      guard.observe("read_file",
        `Verified file: /work/paper.md\nReturned characters: 0-${body.length} of 3000\n---\n${body}`, state, id);
    expect(read(text, 31, nested)).toContain("source_tool_call_id=31");
    expect(nested.navigationInstruction).toContain("original read_file #31");

    const sibling = new ReproductionReadGuard();
    read("## Results\n### Qualitative finding\nNo measurement yet.\n## Discussion\nReported 0.91 elsewhere.", 32, sibling);
    expect(sibling.extractionInstruction).toBeNull();
  });

  it("clears the old Results source ID if overlapping paper text changed without a new quantitative result", () => {
    const guard = new ReproductionReadGuard();
    const original = "## Results\nRecovery was 0.91 in 12 trials.";
    const revised = "## Results\nRecovery was discussed without measurements.";
    const read = (text: string, id: number) => guard.observe("read_file",
      `Verified file: /work/paper.md\nReturned characters: 0-${text.length} of 3000\n---\n${text}`, state, id);
    read(original, 41);
    expect(guard.extractionInstruction).toContain("source_tool_call_id=41");
    read(revised, 42);
    expect(guard.extractionInstruction).toBeNull();
    expect(guard.navigationInstruction).toContain("read_file path=");
    expect(guard.pagingDiagnostics.navigation).toBe("source");
  });

  it("does not promote unverified pages, non-results numbers, or clipped results to a source handoff", () => {
    const guard = new ReproductionReadGuard();
    guard.observe("read_file", "Refused: unavailable", state, 1);
    guard.observe("read_file", "Verified file: /work/paper.md\nReturned characters: 0-32 of 200\n---\n## Introduction\nStudy 2024.", state, 2);
    guard.observe("read_file", "Verified file: /work/paper.md\nReturned characters: 0-48 of 200\n---\n## 3. Results\nNo numerical claim is reported here.", state, 3);
    guard.observe("read_file", "Verified file: /work/paper.md\nReturned characters: 0-300 of 500\n---\n## Introduction\n"
      + "x".repeat(100) + "\n\n[... 200 chars truncated ...]\n\n## 3. Results\nAccuracy is 0.91.", state, 4);
    guard.observe("read_file",
      "Verified file: /work/paper.md\nReturned characters: 500-542 of 1000\n---\n## Introduction\nA study of 50 participants.\n## Results", state, 5);
    guard.observe("read_file",
      "Verified file: /work/paper.md\nReturned characters: 542-568 of 1000\n---\n## Results\nQualitative only.", state, 6);
    expect(guard.extractionInstruction).toBeNull();
  });
});