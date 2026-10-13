import { expect, it } from "vitest";
import { reproductionProgress } from "../reproduction-navigation";

it("separates source evidence IDs from charged calls without hiding genuine overruns", () => {
  expect(reproductionProgress(80, 24, 10, 100)).toEqual({
    usedCalls: 66, label: "[66/100 calls; evidence #80]",
  });
  expect(reproductionProgress(114, 24, 10, 100).usedCalls).toBe(100);
  expect(reproductionProgress(115, 24, 10, 100).usedCalls).toBe(101);
  expect(reproductionProgress(44, 20, 7, 100).usedCalls).toBe(31);
  expect(reproductionProgress(1, 0, 0, 100).usedCalls).toBe(1);
});
