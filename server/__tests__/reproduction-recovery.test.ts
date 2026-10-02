import { describe, expect, it } from "vitest";
import { ReproductionRecovery } from "../reproduction-recovery";

describe("non-renewable recovery stages", () => {
  it("allows the reported command/retrieval/CSV/second-command sequence and reserves finalization", () => {
    const r = new ReproductionRecovery();
    r.begin(62);
    r.observe(63, "read_reproduction_context", "{}");
    r.observe(64, "run_command", "exit code 0 (3.4s)\nprobe_results.csv");
    expect(r.stage).toBe("analysis");
    for (const count of [65, 66, 67]) {
      r.advance(count);
      expect(r.allows("run_command")).toBe(true);
    }
    r.observe(67, "run_command", "exit code 0\ncomputed results");
    expect(r.remaining(67)).toBe(3); // Additional commands never renew it.
    r.advance(70);
    expect(r.stage).toBe("finalization");
    expect(r.allows("run_command")).toBe(false);
    expect(r.allows("read_file")).toBe(false);
    expect(r.allows("read_tool_result")).toBe(true);
    expect(r.allows("record_result")).toBe(true);
    r.advance(73);
    expect(r.remaining(73)).toBe(0);
  });
  it.each(["Refused: qP gate", "Tool error: not executed"])("does not grant analysis for %s", output => {
    const r = new ReproductionRecovery();
    r.begin(0);
    r.observe(1, "run_command", output);
    expect(r.stage).toBe("preparation");
    r.advance(4);
    expect(r.stage).toBe("finalization");
    r.observe(5, "run_command", "exit code 0");
    r.advance(7);
    expect(r.remaining(7)).toBe(0);
  });
  it("permits analysis of a real dependency failure without granting a verdict", () => {
    const r = new ReproductionRecovery();
    r.begin(0);
    r.observe(4, "run_command", "exit code 1\nModuleNotFoundError");
    expect(r.stage).toBe("analysis");
    r.advance(10);
    expect(r.stage).toBe("finalization");
  });
});