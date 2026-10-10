import type { ToolCallRecord } from "./model-service";
import { isPlannedEntrypoint } from "./reproduction-entrypoint";
type Call = Pick<ToolCallRecord, "index" | "name" | "args" | "result" | "error">;

/**
 * A narrow preflight for an observed missing-file failure, not a static
 * dependency detector or scientific validation. Never create missing inputs.
 */
export function missingFileRepairIssue(calls: readonly Call[], paths: string[], args: Record<string, unknown>): string | undefined {
  const command = String(args.command ?? "").trim();
  if (!isPlannedEntrypoint(command, paths)) return;
  const last = [...calls].reverse().find(c => c.name === "run_command"
    && !c.result.startsWith("Refused")
    && String(c.args.command ?? "").trim() === command
    && (c.args.working_directory ?? "/work") === (args.working_directory ?? "/work"));
  if (!last || (!last.error && /^exit code 0\b/.test(last.result))) return;
  const missing = /FileNotFoundError: \[Errno 2\] No such file or directory: ['"](\/work\/[^'"\r\n]+)['"]/.exec(last.result.slice(-4000))?.[1];
  if (!missing) return;
  const after = calls.filter(c => c.index > last.index && !c.error);
  const inspected = (c: Call, path: string) => c.name === "read_file" && c.args.path === path
    && c.result.startsWith(`Verified file: ${path}\n`);
  // Actual file inspection is stronger than mkdir or a successful setup shell.
  if (after.some(c => inspected(c, missing))) return;
  // An authorized source repair can remove an obsolete file dependency.
  // Require reading the changed source after writing it; qP authorization is
  // still enforced by the normal write tool, never by this helper.
  if (after.some(write => write.name === "write_file" && isPlannedEntrypoint(command, [String(write.args.path)])
    && write.result === `Wrote ${String(write.args.content ?? "").length} chars to ${write.args.path}.`
    && after.some(read => read.index > write.index && inspected(read, String(write.args.path))))) return;
  return `Refused before retrying failed execution #${last.index}: its traceback names missing file ${missing}. Inspect the failing operation first. If it reads an input, restore a legitimate supplied input and read_file that exact path before rerunning; mkdir alone does not restore a file. If an authorized source repair removes the dependency, write and then inspect the repaired planned source. Do not invent scientific data. If the dependency cannot be restored safely, submit_for_assessment and report only an evidenced blocker or request_plan_revision.`;
}
