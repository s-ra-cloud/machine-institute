import { describe, expect, it, vi } from "vitest";
import { createSpendingGuard } from "../../scripts/live-reproduction-budget";

describe("live-run spending guard (offline)", () => {
  it("records an over-cap stop before an SDK can replace its error", () => {
    const save = vi.fn();
    const guard = createSpendingGuard(save);
    expect(() => guard.check("DeepSeek", 4.76, 0.3, 5)).toThrow("before dispatch");
    try {
      guard.check("DeepSeek", 4.76, 0.3, 5);
    } catch (error) {
      expect(error).toMatchObject({ code: "SPENDING_CAP" });
    }
    const wrapped = new Error("BYOK provider request failed (unknown)");
    expect(guard.failure?.message ?? wrapped.message).toContain("$5 spending guard");
    expect(guard.failure).toMatchObject({
      code: "SPENDING_CAP", accountedDollars: 4.76, reservationDollars: 0.3, capDollars: 5,
    });
    expect(save).toHaveBeenCalledTimes(2);
  });
  it("keeps legitimate provider errors distinct when the cap has not fired", () => {
    const save = vi.fn();
    const guard = createSpendingGuard(save);
    guard.check("DeepSeek", 4.5, 0.5, 5);
    expect(guard.failure).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });
  it("protects the Modal cap and distinguishes unverifiable costs", () => {
    const guard = createSpendingGuard(() => {});
    expect(() => guard.check("Modal", 9.5, 5, 10)).toThrow("$10 spending guard");
    const invalid = createSpendingGuard(() => {});
    expect(() => invalid.check("DeepSeek", 1, NaN, 5)).toThrow("could not be verified");
    expect(invalid.failure?.code).toBe("INVALID_COST");
  });
});
