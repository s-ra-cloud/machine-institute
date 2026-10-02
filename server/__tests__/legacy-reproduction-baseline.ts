import { runReproduction, type RunReproductionOptions } from "../reproduce";

/**
 * Historical transcript baseline, not acceptance tests of the stage controller.
 * Retained for offline before/after comparisons and regression investigation.
 * Public run/retry routes cannot select this controller.
 */
export const runLegacyBaseline = (options: RunReproductionOptions) =>
  runReproduction({ ...options, legacyControllerForComparison: true });