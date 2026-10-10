import { posix } from "node:path";
import type { ToolCallRecord } from "./model-service";

type Call = Pick<ToolCallRecord, "index" | "name" | "args" | "result" | "error">;

/**
 * Narrow Python pattern check, not a dependency solver or scientific classifier.
 * Recognizes ROOT_DIR = Path(__file__).resolve().parent.parent and literal
 * ROOT_DIR / "..." arguments to a function that reads and rewrites that path.
 * Never executes source or initializes a missing file.
 */
export function preparationIssue(path: string, source: string, calls: readonly Call[]): string | undefined {
  if (!path.endsWith(".py") || !/^ROOT_DIR\s*=\s*Path\(__file__\)\.resolve\(\)\.parent\.parent\s*$/m.test(source)) return;
  const functions = Array.from(source.matchAll(/^def (\w+)\((\w+)[^\n]*\n((?:[ \t]+[^\n]*\n|\n)+)/gm));
  const lastWrite = [...calls].reverse().find(c => c.name === "write_file" && c.args.path === path
    && !c.error && c.result === `Wrote ${String(c.args.content ?? "").length} chars to ${path}.`);
  const reads = calls.filter(c => c.name === "read_file" && !c.error && c.index > (lastWrite?.index ?? -1));
  for (const fn of functions) {
    if (!fn[3].includes(`${fn[2]}.read_text()`) || !fn[3].includes(`${fn[2]}.write_text(`)) continue;
    for (const assignment of Array.from(source.matchAll(/^\s*(\w+)\s*=\s*\(ROOT_DIR((?:\s*\/\s*["'][^"'\n]+["'])+)\)\.resolve\(\)/gm))) {
      if (!new RegExp(`\\b${fn[1]}\\(\\s*${assignment[1]}\\s*[,)]`).test(source)) continue;
      const segments = Array.from(assignment[2].matchAll(/["']([^"']+)["']/g)).map(m => m[1]);
      const dependency = posix.resolve(posix.dirname(posix.dirname(path)), ...segments);
      if (!dependency.startsWith("/work/")) continue;
      const inspectedFunction = reads.some(c => c.args.path === path
        && c.result.startsWith(`Verified file: ${path}\n`)
        && c.result.includes(fn[0].trimEnd()));
      const inspectedInput = reads.some(c => c.args.path === dependency
        && c.result.startsWith(`Verified file: ${dependency}\n`));
      if (!inspectedFunction || !inspectedInput)
        return `Refused before execution: preparation check found ${fn[1]} reads then rewrites ${dependency}. Read ${path} with query="def ${fn[1]}" and inspect ${dependency} before running. Determine from source whether this is scientific input or bookkeeping; filenames alone do not decide. Restore only legitimate inputs. Initialize bookkeeping only when inspected code justifies its schema and it cannot supply scientific measurements. Otherwise request a plan revision for an authorized source repair or evidenced limitation. No files or results were created by this check.`;
    }
  }
}
