import { expect, it } from "vitest";
import { verificationConflict } from "../reproduction-verification";
import type { ClaimVerdict } from "../prompts/reproduce";

const result: ClaimVerdict = { id: "R14", claim: "Rates 0.292 and 0.222", verdict: "inconclusive",
  verificationAssessment: { conditionsMatch: true, allQuantitativeStatementsChecked: true,
    differences: "small", propertiesPreserved: true, explanation: "0.306 and 0.236, ordering unchanged" } };
it("flags inconsistent inconclusive reasoning without upgrading a verdict", () => {
  expect(verificationConflict(result)).toContain("all comparison checks passing");
  expect(result.verdict).toBe("inconclusive");
});
it("refuses verification when a compound claim or comparison was not checked", () => {
  expect(verificationConflict({ ...result, verdict: "verified", verificationAssessment: {
    ...(result.verificationAssessment as object), allQuantitativeStatementsChecked: false,
  } })).toContain("verified conflicts");
});
it("preserves genuine uncertainty and historical verdicts without a checklist", () => {
  expect(verificationConflict({ ...result, verificationAssessment: undefined })).toBeUndefined();
  expect(verificationConflict({ ...result, verificationAssessment: {
    ...(result.verificationAssessment as object), propertiesPreserved: false,
  } })).toBeUndefined();
});
