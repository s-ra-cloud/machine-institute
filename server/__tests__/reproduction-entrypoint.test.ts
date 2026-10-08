import { describe, expect, it } from "vitest";
import { isPlannedEntrypoint, rerunLaunchRefusal } from "../reproduction-entrypoint";
const paths = ["/work/materials/analysis1_baseline.py"];
describe("planned rerun launch contract", () => {
  it.each([
    "cd /work/materials && python analysis1_baseline.py 2>&1 | tee /work/results/analysis1_run.log",
    "python /work/materials/analysis1_baseline.py; cat /work/materials/results.csv",
    "python /work/materials/analysis1_baseline.py | tee /work/results/run.log",
    "cd /work && python materials/analysis1_baseline.py",
    "python /work/materials/analysis1_baseline.py > /work/results/log",
  ])("rejects before execution instead of accepting a shell wrapper: %s", command => {
    expect(isPlannedEntrypoint(command, paths)).toBe(false);
    expect(rerunLaunchRefusal(command, paths)).toContain("Refused before execution");
  });
  it.each(["python /work/materials/analysis1_baseline.py", "python3 materials/analysis1_baseline.py --seed 1"])("allows direct planned execution: %s", command => {
    expect(isPlannedEntrypoint(command, paths)).toBe(true);
    expect(rerunLaunchRefusal(command, paths)).toBeUndefined();
  });
  it("does not certify CSV displays, setup commands or unrelated sources", () => {
    for (const command of ["cat /work/materials/results.csv", "python -c \"import torch\""]) {
      expect(isPlannedEntrypoint(command, paths)).toBe(false);
      expect(rerunLaunchRefusal(command, paths)).toBeUndefined();
    }
  });
  it.each([
    "python /work/materials/analysis3_early_state_patching.py",
    "python3 materials/unplanned.py",
    "python '/work/materials/unplanned.py'",
    "cd /work && python materials/unplanned.py",
    "node materials/unplanned.mjs",
  ])("rejects an unplanned material script before paying for execution: %s", command => {
    expect(isPlannedEntrypoint(command, paths)).toBe(false);
    expect(rerunLaunchRefusal(command, paths)).toContain("not a source entrypoint in the accepted rerun plan");
    expect(rerunLaunchRefusal(command, paths, true)).toContain("request_plan_revision");
  });
});
