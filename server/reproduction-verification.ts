import type { ClaimVerdict } from "./prompts/reproduce";

export const VERIFICATION_CHECK = `For each result include verification_assessment:
{conditionsMatch:boolean, allQuantitativeStatementsChecked:boolean, differences:"none|small|large|unknown", propertiesPreserved:boolean, explanation:string}.
Check EVERY quantitative clause against cited execution output, including every peak magnitude AND layer, not only the first matching value. Properties include sign, ordering, peak location and whether intervals exclude zero.
Apply the shared verification standard consistently. Small differences with every property preserved do not require a documented tolerance for verification. Overlapping intervals alone do not establish equivalence. Missing comparability or unexamined clauses cannot verify. If choosing inconclusive, explain the specific unresolved property or material discrepancy; absence of a documented tolerance alone is not enough for small differences. These fields describe your evidence assessment; they do not authorize inventing values or tolerances.`;

export function verificationConflict(result: ClaimVerdict): string | undefined {
  const a = result.verificationAssessment as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object") return undefined;
  if (result.verdict === "verified" && (a.conditionsMatch === false
    || a.allQuantitativeStatementsChecked === false || a.propertiesPreserved === false
    || a.differences === "large" || a.differences === "unknown")) {
    return `${result.id}: verified conflicts with the recorded comparison checks.`;
  }
  if (result.verdict === "inconclusive" && a.conditionsMatch === true
    && a.allQuantitativeStatementsChecked === true && a.propertiesPreserved === true
    && (a.differences === "none" || a.differences === "small")) {
    return `${result.id}: inconclusive conflicts with all comparison checks passing. Recheck the evidence; explain any unresolved property or apply the shared standard.`;
  }
}
