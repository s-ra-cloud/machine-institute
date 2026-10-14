import { expect, it, vi } from "vitest";
vi.mock("../model-service", () => ({ runToolLoop: vi.fn(), generateWithConfig: vi.fn(), getContextWindow: () => 32768 }));
import { extractionSkipReason } from "../reproduction-extraction";
import { validateCandidate } from "../reproduction-packets";
import { comparisonCountMismatch, hasRoundingOnlyRationale } from "../reproduction-judge";
import { captureProcessStream } from "../reproduction-stream";

it("does not count analysis labels or citation years as measurements", () => {
  expect(extractionSkipReason("Analysis 3 uses activation patching (Zhang, 2024).", [])).toBe("no-measurement");
  expect(extractionSkipReason("Analysis 3 measured accuracy 0.95 on 72 tasks.", [])).toBeUndefined();
});
it("rejects word fragments using canonical source, including packet edges", () => {
  const source = "Evidence correct-margin difference is -0.095 with a confidence interval spanning zero.";
  const claim = source.slice(2);
  expect(validateCandidate({ claim, source_quote: claim }, { id: "p", start: 2, end: source.length, text: claim }, source))
    .toContain("claim cuts through a source word; quote a complete finding, not a packet-edge fragment");
});
it("deduplicates contained findings but keeps different measured values", () => {
  const a = "Activation patching on a selected 18-task lower-margin subset improved the final correct margin by 0.375.";
  expect(extractionSkipReason(a, [a])).toBe("duplicate");
  expect(extractionSkipReason(a.replace("0.375", "0.500"), [a])).toBeUndefined();
});
it("detects explicit incompatible counts without assuming a missing count is a mismatch", () => {
  expect(comparisonCountMismatch("On 72 binary tasks accuracy was 1.", "96 tasks, accuracy 0.969")).toBe(true);
  expect(comparisonCountMismatch("On 72 binary tasks accuracy was 1.", "72 tasks, accuracy 0.969")).toBe(false);
  expect(comparisonCountMismatch("On 72 binary tasks accuracy was 1.", "accuracy 0.969")).toBe(false);
});
it("retains progress when an output stream fails", async () => {
  let n = 0;
  const stream = new ReadableStream<string>({
    pull(controller) {
      if (n++ === 0) controller.enqueue("processing batch 17\n");
      else controller.error(new Error("terminated"));
    },
  });
  const output = await captureProcessStream(Object.assign(stream, { readText: async () => "" }));
  expect(output).toContain("processing batch 17");
  expect(output).toContain("stream interrupted");
});
it("captures normal output unchanged", async () => {
  const stream = new ReadableStream<string>({ start(c) { c.enqueue("done\n"); c.close(); } });
  expect(await captureProcessStream(Object.assign(stream, { readText: async () => "" }))).toBe("done\n");
});
it("flags rounding-based rationales without suppressing ordinary material discrepancies", () => {
  expect(hasRoundingOnlyRationale("Both differences exceed rounding tolerance.")).toBe(true);
  expect(hasRoundingOnlyRationale("The point estimates differ beyond rounding tolerance.")).toBe(true);
  expect(hasRoundingOnlyRationale("The effect is negative with an interval excluding zero, unlike the reported positive effect.")).toBe(false);
});
