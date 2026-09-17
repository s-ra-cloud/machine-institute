export function canRetryReproduction(input: {
  status: string;
  overallVerdict?: string | null;
}): boolean {
  return input.status === "failed"
    || (input.status === "completed" && input.overallVerdict === "inconclusive");
}