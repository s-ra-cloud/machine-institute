import type { ToolCallRecord } from "./model-service";
import type { RecordedResult } from "./prompts/reproduce";

/** Judge assertions are proposals: cited execution and interval arithmetic are checked locally. */
export interface FalsificationAssessment {
  conditionsMatch: boolean;
  comparisonExplanation: string;
  substantiveContradiction: boolean;
  contradictionExplanation: string;
  toleranceBasis: "uncertainty-separated" | "documented-tolerance";
  toleranceExplanation: string;
  evidenceToolCallId: number;
  evidenceQuote: string;
  documentedTolerance?: number;
  originalEstimate?: number;
  reproducedEstimate?: number;
  toleranceToolCallId?: number;
  toleranceQuote?: string;
}

const text = (x: unknown): x is string => typeof x === "string" && x.trim().length >= 20;
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const intervals = (text: string) => Array.from(text.matchAll(
  /\[\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*\]/g,
)).map(m => [Number(m[1]), Number(m[2])]);
const containsNumber = (text: string, value: number) =>
  Array.from(text.matchAll(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi))
    .some(m => Number(m[0]) === value);

export function falsificationRejection(
  value: unknown, recorded: RecordedResult, reproduced: string, calls: readonly ToolCallRecord[],
): string | undefined {
  const a = value as Partial<FalsificationAssessment> | undefined;
  if (!a || a.conditionsMatch !== true || a.substantiveContradiction !== true
    || !text(a.comparisonExplanation) || !text(a.contradictionExplanation)
    || !text(a.toleranceExplanation))
    return "Missing structured evidence of matching conditions, meaningful tolerance, and substantive contradiction.";
  const execution = calls.find(c => c.index === a.evidenceToolCallId && c.name === "run_command");
  if (!execution || !recorded.evidenceToolCallIds?.includes(execution.index)
    || !text(a.evidenceQuote) || !execution.result.includes(a.evidenceQuote))
    return "The comparison must cite an exact quote from this claim's recorded execution evidence.";
  if (a.toleranceBasis === "uncertainty-separated") {
    const original = intervals(recorded.claim);
    const actual = intervals(reproduced);
    if (original.length !== 1 || actual.length !== 1)
      return "A single unambiguous pair of uncertainty intervals is required; compound comparisons need a documented tolerance.";
    const [o, r] = [original[0], actual[0]];
    if (o[0] > o[1] || r[0] > r[1] || !r.every(n => containsNumber(a.evidenceQuote!, n)))
      return "Uncertainty intervals are invalid or not grounded in the cited execution.";
    if (Math.max(o[0], r[0]) <= Math.min(o[1], r[1]))
      return "The uncertainty intervals overlap; this does not establish equivalence or a substantive contradiction.";
    return undefined;
  }
  if (a.toleranceBasis === "documented-tolerance") {
    const source = calls.find(c => c.index === a.toleranceToolCallId && c.name === "read_file");
    // Do not let an agent-authored working file manufacture an exact-equality requirement.
    const authored = calls.some(c => c.name === "write_file" && c.args?.path === source?.args?.path);
    if (!source || authored || !text(a.toleranceQuote) || !source.result.includes(a.toleranceQuote)
      || !finite(a.documentedTolerance) || a.documentedTolerance < 0
      || !containsNumber(a.toleranceQuote, a.documentedTolerance)
      || !finite(a.originalEstimate) || !containsNumber(recorded.claim, a.originalEstimate)
      || !finite(a.reproducedEstimate) || !containsNumber(a.evidenceQuote!, a.reproducedEstimate)
      || !containsNumber(reproduced, a.reproducedEstimate))
      return "A numerical tolerance must be grounded in read source material, with both estimates grounded in claim and execution.";
    if (Math.abs(a.originalEstimate - a.reproducedEstimate) <= a.documentedTolerance)
      return "The numerical discrepancy does not exceed the documented tolerance.";
    return undefined;
  }
  return "No supported tolerance basis was supplied; fixed seeds or differing rounded values alone are insufficient.";
}
