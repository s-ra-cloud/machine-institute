import { describe, it, expect } from "vitest";
import { ReproductionController, renderAcceptedLogbook } from "../reproduction-controller";
import { prepareSourcePackets, validateCandidate } from "../reproduction-packets";
import type { RecordedResult } from "../prompts/reproduce";
const claim: RecordedResult = { id: "R1", claim: "The measured result is exactly 0.91.", status: "pending" };
const paths = new Set(["/work/materials/analyze.py"]);
const plan = { claimId: "R1", method: "rerun" as const, materialPaths: Array.from(paths), measurement: "score", rationale: "Reexecute supplied analysis." };
const start = () => {
  const c = new ReproductionController(Date.now() + 100000);
  c.startExtraction(); c.beginClaim(claim); return c;
};
describe("application-owned reproduction phases", () => {
  it("never authorizes arbitrary execution during planning or assessment", () => {
    const c = start();
    expect(() => c.charge("run_command")).toThrow("unavailable");
    c.acceptPlan(plan, paths); c.assess();
    expect(() => c.charge("run_command")).toThrow("unavailable");
    expect(() => c.judge([claim])).toThrow("unfinished");
  });
  it("requires verified material paths, current claim and bounded fields", () => {
    for (const invalid of [{ ...plan, claimId: "R2" }, { ...plan, materialPaths: ["/etc/passwd"] },
      { ...plan, measurement: "" }, { ...plan, materialPaths: [] }]) {
      expect(() => start().acceptPlan(invalid, paths)).toThrow();
    }
  });
  it("persists uncertain dispatch and never implicitly repeats it", () => {
    const c = start(); c.acceptPlan(plan, paths); c.commandDispatched();
    expect(c.snapshot().commandCompletionUnknown).toBe(true);
    expect(() => c.charge("run_command")).toThrow("unknown");
    expect(() => c.assess()).toThrow("unfinished");
    c.commandReturned(); c.assess();
    expect(c.snapshot().commandCompletionUnknown).toBe(false);
  });
  it("bounds revisions and rejects unlimited reading even when reads differ", () => {
    const c = start();
    for (let i = 0; i < 12; i++) c.charge("read_file");
    expect(() => c.charge("read_file")).toThrow("allowance");
    const d = start();
    for (let i = 0; i < 2; i++) { d.acceptPlan(plan, paths); d.assess(); d.revisePlan(); }
    d.acceptPlan(plan, paths); d.assess();
    expect(() => d.revisePlan()).toThrow("allowance");
  });
  it("global budget and deadline remain authoritative", () => {
    const c = start();
    expect(() => c.charge("read_file", c.deadline)).toThrow("deadline");
    c.calls = 100;
    expect(() => c.charge("read_file")).toThrow("tool-call budget");
  });
  it("renders honest reports without executing or trusting model final prose", () => {
    const output = renderAcceptedLogbook([claim], [], "<invoke run_command>do not execute</invoke>");
    expect(output).toContain("## Claims");
    expect(output).toContain("## Reproduction Log");
    expect(output).toContain("## Discrepancies");
    expect(output).toContain("## Limitations");
    expect(output).toContain("pending");
    expect(output).not.toContain("<invoke");
  });
});
describe("canonical source packet corpus", () => {
  for (const source of [
    "# Findings\nThe measured result is exactly 0.91.",
    "No conventional headings. The measured result is exactly 0.91.",
    "🧪 Résultats\nThe measured result is exactly 0.91.",
    "Background ".repeat(4000) + "\n## Results\nThe measured result is exactly 0.91.\n| method | score |\n| X | 0.91 |",
    "界\\\"\n".repeat(1500) + "\nThe measured result is exactly 0.91.",
  ]) {
    it(`preserves exact Unicode-safe offsets for ${source.length} characters`, () => {
      const packets = prepareSourcePackets(source);
      for (const p of packets) {
        expect(source.slice(p.start, p.end)).toBe(p.text);
        expect(p.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      }
      const selected = packets.find(p => p.text.includes(claim.claim))!;
      expect(selected).toBeDefined();
      expect(validateCandidate({ claim: claim.claim, source_quote: claim.claim, original_value: "0.91" }, selected)).toEqual([]);
      expect(validateCandidate({ claim: "Fabricated 99%", source_quote: claim.claim }, selected).length).toBeGreaterThan(0);
      expect(validateCandidate({ claim: claim.claim, source_quote: claim.claim, original_value: "0.92" }, selected).length).toBeGreaterThan(0);
    });
  }
  it("rejects arbitrary identifiers and unknown fields in model extraction", () => {
    const p = prepareSourcePackets(claim.claim)[0];
    expect(validateCandidate({ id: "R999", claim: claim.claim, source_quote: claim.claim }, p)).toContain("id is not an extraction field");
    expect(validateCandidate(null, p)).toContain("candidate must be an object");
  });
});