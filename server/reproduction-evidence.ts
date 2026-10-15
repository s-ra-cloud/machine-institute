import type { ToolCallRecord } from "./model-service";
import { diagnosticExcerpt } from "./reproduction-diagnostics";

/** Private, redacted evidence, separate from public reports and bounded telemetry. */
export function captureReproductionEvidence(calls: readonly ToolCallRecord[]) {
  let remaining = 4_000_000;
  let omitted = 0;
  const records = [];
  for (const call of calls) {
    if (!["run_command", "read_file"].includes(call.name)) continue;
    if (remaining < 1024) { omitted++; continue; }
    const output = diagnosticExcerpt(call.result, Math.min(remaining, 256_000));
    const record = {
      id: call.index, tool: call.name, error: call.error,
      command: diagnosticExcerpt(String(call.args.command ?? call.args.path ?? ""), 4000),
      output, truncated: output.endsWith("[TRUNCATED]"),
    };
    const bytes = Buffer.byteLength(JSON.stringify(record));
    if (bytes > remaining) { omitted++; continue; }
    remaining -= bytes;
    records.push(record);
  }
  return { notice: "Private evidence: credentials and URLs redacted. Truncated records and omitted counts are explicit. Not a scientific verdict.", records, omitted };
}
