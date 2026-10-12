import { createHash } from "node:crypto";
import type { ToolCallRecord } from "./model-service";

/** Commands can be inspection too: new output must not replenish browsing. */
export function nextExecutionNavigationCount(count: number, call: Pick<ToolCallRecord, "name" | "error" | "result">): number {
  if (["read_file", "read_tool_result", "list_files"].includes(call.name)) return count + 1;
  if (call.name === "write_file" && !call.error && !call.result.startsWith("Refused:")) return 0;
  return count;
}

type Call = Pick<ToolCallRecord, "index" | "name" | "args" | "result" | "error">;

/** Historical navigation only. A captured page hash is not a current file hash. */
export function inspectionIndex(calls: readonly Call[]) {
  const pages = new Map<string, {
    path: string; start: number; end: number; capturedPageSha256: string;
    readToolCallId: number; latestReadToolCallId: number; identicalCaptures: number;
  }>();
  for (const call of calls) {
    if (call.name !== "read_file" || call.error) continue;
    const page = /^Verified file: ([^\n]+)\nReturned characters: (\d+)-(\d+) of \d+\n---\n([\s\S]*)$/.exec(call.result);
    if (!page || page[1] !== call.args.path) continue;
    const hash = createHash("sha256").update(page[4]).digest("hex");
    const key = JSON.stringify([page[1], page[2], page[3], hash]);
    const previous = pages.get(key);
    pages.delete(key);
    pages.set(key, {
      path: page[1], start: Number(page[2]), end: Number(page[3]), capturedPageSha256: hash,
      readToolCallId: previous?.readToolCallId ?? call.index,
      latestReadToolCallId: call.index, identicalCaptures: (previous?.identicalCaptures ?? 0) + 1,
    });
    // Keep the navigation packet bounded, not the original evidence archive.
    while (pages.size > 30 || JSON.stringify(Array.from(pages.values())).length > 16000)
      pages.delete(pages.keys().next().value!);
  }
  return {
    notice: "Historical inspected pages, not current file contents. Retrieve original evidence by readToolCallId before rereading unchanged passages. Commands or edits may have changed files: read_file remains available to inspect current contents. Hashes identify captured pages only. No scientific verdict or reuse authorization is implied.",
    pages: Array.from(pages.values()).map(page => ({
      ...page, retrieve: { tool_call_id: page.readToolCallId, offset: 0, max_chars: 2000 },
    })),
  };
}
