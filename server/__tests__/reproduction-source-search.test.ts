import { describe, expect, it } from "vitest";
import { searchPaperSource } from "../reproduction-source-page";
import { QuestioningState } from "../reproduction-questioning";

describe("canonical paper navigation", () => {
  it("returns literal case-insensitive UTF-16 offsets, not source quotes", () => {
    const text = '😀 Intro\nRESULTS\nTable [1].\nresults\n.*\n';
    const page = JSON.parse(searchPaperSource(text, { query: "Results" }));
    expect(page.matches).toEqual([
      { start: text.indexOf("RESULTS"), end: text.indexOf("RESULTS") + 7 },
      { start: text.indexOf("results"), end: text.indexOf("results") + 7 },
    ]);
    expect(page.next_offset).toBeNull();
    expect(page).not.toHaveProperty("text");
    expect(JSON.parse(searchPaperSource(text, { query: ".*" })).matches).toEqual([
      { start: text.indexOf(".*"), end: text.indexOf(".*") + 2 },
    ]);
    expect(JSON.parse(searchPaperSource(text, { query: "absent" })).matches).toEqual([]);
  });

  it("bounds result pages and resumes without duplicating matches", () => {
    const text = "Results\n".repeat(50);
    const offsets: number[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const output = searchPaperSource(text, { query: "Results", offset });
      expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(9000);
      const page = JSON.parse(output);
      expect(page.matches.length).toBeLessThanOrEqual(12);
      offsets.push(...page.matches.map((m: { start: number }) => m.start));
      if (page.next_offset !== null) expect(page.next_offset).toBeGreaterThan(offset);
      offset = page.next_offset;
    }
    expect(offsets).toEqual(Array.from({ length: 50 }, (_, i) => i * 8));
  });

  it("bounds scan work without losing matches across scan boundaries", () => {
    const text = "x".repeat(249_997) + "Results" + "x".repeat(250_001) + "RESULTS";
    const first = JSON.parse(searchPaperSource(text, { query: "results" }));
    expect(first.matches).toEqual([{ start: 249_997, end: 250_004 }]);
    expect(first.next_offset).toBe(250_000);
    const second = JSON.parse(searchPaperSource(text, { query: "results", offset: first.next_offset }));
    expect(second.matches).toEqual([]);
    const third = JSON.parse(searchPaperSource(text, { query: "results", offset: second.next_offset }));
    expect(third.matches).toEqual([{ start: 500_005, end: 500_012 }]);
    expect(third.next_offset).toBeNull();
  });

  it("refuses invalid arguments and arbitrary inspection paths", () => {
    for (const args of [
      {}, { query: "" }, { query: " " }, { query: 12 }, { query: "x".repeat(129) },
      { query: "a", offset: -1 }, { query: "a", offset: 1.5 },
      { query: "a", offset: "0" }, { query: "a", offset: 100 },
      { query: "a", offset: 1 }, // inside the emoji
      { query: "a", path: "/proc/self/environ" },
    ]) expect(searchPaperSource("😀abc", args)).toMatch(/^Refused:/);
    expect(JSON.parse(searchPaperSource("", { query: "Results" })).next_offset).toBeNull();
  });

  it("does not change qP inspection or execution gates", () => {
    const state = new QuestioningState();
    expect(state.gate("search_paper")).toBeUndefined();
    expect(state.gate("run_command")).toMatch(/Refused/);
    expect(state.readKnownSource("/proc/self/environ")).toBeUndefined();
    expect(state.readKnownSource("/work/results/link")).toBeUndefined();
  });
});