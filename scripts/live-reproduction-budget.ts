export type BudgetStop = {
  code: "SPENDING_CAP" | "INVALID_COST";
  resource: "DeepSeek" | "Modal";
  message: string;
  accountedDollars: number;
  reservationDollars: number;
  capDollars: number;
};

/** Retain local guard errors even if a provider SDK sanitizes their message. */
export function createSpendingGuard(onStop: (stop: BudgetStop) => void) {
  let stopped: BudgetStop | undefined;
  return {
    get failure() { return stopped; },
    check(resource: BudgetStop["resource"], accounted: number, reservation: number, cap: number) {
      const valid = [accounted, reservation, cap].every(Number.isFinite)
        && accounted >= 0 && reservation > 0 && cap > 0;
      if (valid && accounted + reservation <= cap) return;
      stopped = {
        code: valid ? "SPENDING_CAP" : "INVALID_COST", resource,
        message: valid
          ? `${resource} $${cap} spending guard stopped this run before dispatch.`
          : `${resource} cost could not be verified; stopped before dispatch.`,
        accountedDollars: accounted, reservationDollars: reservation, capDollars: cap,
      };
      onStop(stopped);
      throw Object.assign(new Error(stopped.message), { code: stopped.code });
    },
  };
}
