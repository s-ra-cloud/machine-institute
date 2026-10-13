/** Evidence IDs include host-created source records; they are not budget counters. */
export function reproductionProgress(evidenceId: number, sourceRecords: number, extractionCalls: number, limit: number) {
  const usedCalls = extractionCalls + Math.max(0, evidenceId - sourceRecords);
  return { usedCalls, label: `[${usedCalls}/${limit} calls; evidence #${evidenceId}]` };
}
