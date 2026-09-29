/**
 * Run-local guard for repeated source inspection. Never changes the canonical
 * source or evidence IDs; a duplicate still returns the actual verified page.
 */
export class ReproductionReadGuard {
  private ranges = new Map<string, Array<{ start: number; text: string }>>();
  private directories = new Map<string, string>();
  private repeats = 0;
  private stalled = false;
  private acceptedClaims = 0;
  private assessment = false;

  get stopReason(): string | null {
    return this.stalled
      ? "Repeated already-delivered source reads without registering a claim or advancing the assessment"
      : null;
  }

  observe(
    name: string,
    result: string,
    state: { acceptedClaims: number; assessed: boolean },
  ): string {
    if (state.acceptedClaims !== this.acceptedClaims || state.assessed !== this.assessment) {
      this.acceptedClaims = state.acceptedClaims;
      this.assessment = state.assessed;
      this.repeats = 0;
    }
    const page = name === "read_file"
      ? /^Verified file: (\/work\/[^\n]+)\nReturned characters: (\d+)-(\d+) of (\d+)\n---\n/.exec(result)
      : null;
    const directory = name === "list_files"
      ? /^Verified directory: (\/work(?:\/[^\n]*)?)\n/.exec(result)
      : null;
    if (!page && !directory) return result;

    let duplicate = false;
    let next = "";
    if (page) {
      const path = page[1];
      const start = Number(page[2]);
      const statedEnd = Number(page[3]);
      const total = Number(page[4]);
      // The tool loop may shorten a large page in the middle. Only the
      // contiguous prefix that actually reached the model counts as delivered.
      const content = result.slice(page[0].length);
      const omittedAt = content.search(/\n\n\[\.\.\. \d+ chars truncated \.\.\.\]\n\n/);
      const visible = content.slice(0, Math.min(statedEnd - start, omittedAt < 0 ? content.length : omittedAt));
      let ranges = this.ranges.get(path) ?? [];
      let cursor = 0;
      let changed = false;
      // Check actual overlapping content, not just offsets: experiment outputs
      // can be rewritten at the same path between inspections.
      for (const range of ranges.slice().sort((a, b) => a.start - b.start)) {
        const from = Math.max(start, range.start);
        const to = Math.min(start + visible.length, range.start + range.text.length);
        if (from >= to) continue;
        if (range.text.slice(from - range.start, to - range.start) !== visible.slice(from - start, to - start)) {
          changed = true;
          break;
        }
        if (from <= start + cursor) cursor = Math.max(cursor, to - start);
      }
      if (changed) {
        ranges = [];
        this.ranges.set(path, ranges);
      }
      const covered = !changed && cursor >= visible.length;
      // Partially overlapping reads can be useful for precise quotes; only
      // pages wholly covered by the union of earlier reads are repetitions.
      duplicate = covered && visible.length > 0;
      if (!duplicate) {
        ranges.push({ start, text: visible });
        this.ranges.set(path, ranges);
      }
      let firstGap = 0;
      for (const range of ranges.slice().sort((a, b) => a.start - b.start)) {
        if (range.start > firstGap) break;
        firstGap = Math.max(firstGap, range.start + range.text.length);
      }
      next = firstGap < total
        ? `Unread text remains in ${path}; use read_file offset=${firstGap}, or use the page already returned to register an exact source-grounded claim.`
        : `All of ${path} has already been returned in overlapping pages; use the existing verified read's tool-call ID to register source-grounded claims.`;
    } else if (directory) {
      duplicate = this.directories.get(directory[1]) === result;
      this.directories.set(directory[1], result);
      next = `Directory ${directory[1]} was already listed. Open a specific shipped file or register a source-grounded claim instead.`;
    }
    if (!duplicate) {
      this.repeats = 0;
      return result;
    }
    this.repeats++;
    if (this.repeats >= 7) this.stalled = true;
    if (this.repeats < 2) return result;
    return `${result}\n\n[Repeated inspection ${this.repeats}/7: ${next} If earlier tool output was compacted, retrieve its original ID with read_tool_result rather than rereading the source. Repeated browsing is not a reproduced result.]`;
  }
}