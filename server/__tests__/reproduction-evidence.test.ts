import { expect, it } from "vitest";
import { captureReproductionEvidence } from "../reproduction-evidence";
import type { ToolCallRecord } from "../model-service";

const call = (result: string, index = 1): ToolCallRecord => ({
  index, name: "run_command", args: { command: "python analysis.py" }, result, error: false, durationMs: 1,
});
it("keeps execution values and source while redacting credential-shaped content", () => {
  const saved = captureReproductionEvidence([call("peak=0.142 layer=9\nAPI_KEY=private-value\nhttps://example.com/private"), {
    ...call("print(mean(data))", 2), name: "read_file", args: { path: "/work/analysis.py" },
  }]);
  expect(saved.records).toHaveLength(2);
  expect(saved.records[0].output).toContain("peak=0.142 layer=9");
  expect(saved.records[1].output).toBe("print(mean(data))");
  expect(JSON.stringify(saved)).not.toContain("private-value");
  expect(JSON.stringify(saved)).not.toContain("example.com");
});
it("bounds archive size and explicitly reports truncated and omitted evidence", () => {
  const saved = captureReproductionEvidence(Array.from({ length: 20 }, (_, i) => call("metric 0.142\n".repeat(30000), i)));
  expect(saved.records.some(r => r.truncated)).toBe(true);
  expect(saved.omitted).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(4_001_000);
});
