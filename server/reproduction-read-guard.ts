/**
 * Run-local guard for repeated source inspection. Never changes the canonical
 * source or evidence IDs; a duplicate still returns the actual verified page.
 */
export interface ReproductionPagingDiagnostics {
  sourceReadCount: number;
  sourceRepeatCount: number;
  outputRepeatCount: number;
  outputNewRangeCount: number;
  paperFirstGap: number;
  paperTotal: number;
  outputNextOffset: number;
  originalOutputCallId: number;
  navigation: "extract" | "source" | "output" | "none";
  stalled: boolean;
}

export class ReproductionReadGuard {
  private ranges = new Map<string, Array<{ start: number; text: string }>>();
  private directories = new Map<string, string>();
  private sourcePage?: { callIndex: number; start: number; end: number };
  private paper?: { firstGap: number; total: number };
  private output?: { id?: number; end: number; total: number; index: boolean };
  private outputRanges = new Map<string, Array<{ start: number; text: string }>>();
  private sourceReadCount = 0;
  private sourceRepeatCount = 0;
  private outputRepeatCount = 0;
  private outputNewRangeCount = 0;
  private repeats = 0;
  private stalled = false;
  private acceptedClaims = 0;
  private assessment = false;

  get stopReason(): string | null {
    return this.stalled
      ? "Repeated already-delivered source reads without registering a claim or advancing the assessment"
      : null;
  }

  get extractionInstruction(): string | null {
    if (this.acceptedClaims > 0 || !this.sourcePage) return null;
    const { callIndex, start, end } = this.sourcePage;
    return `NEXT ACTION — EXTRACT: A verified Results passage was already returned by read_file tool call #${callIndex} (source_location="characters ${start}-${end}"). If it contains a core quantitative result, call record_result with a new id, status="pending", claim copied verbatim from that page, a substantial exact source_quote containing the claim, source_tool_call_id=${callIndex}, and original_value only if explicitly stated in the quote. Do not infer a claim or outcome. If the page was compacted, retrieve original #${callIndex} with read_tool_result; cite #${callIndex}, not the retrieval ID. read_reproduction_context requires an actual archived ref, not a paper location.`;
  }

  get navigationInstruction(): string | null {
    if (this.extractionInstruction && this.sourcePage) {
      const { callIndex, start, end } = this.sourcePage;
      return `NEXT: Extract only an explicit Results claim from original read_file #${callIndex}, source_location="characters ${start}-${end}". Use record_result with new id, status="pending", verbatim claim, substantial exact source_quote, source_tool_call_id=${callIndex}; original_value only if quoted. If compacted, read_tool_result tool_call_id=${callIndex}; continue at its displayed output-page end, NOT source offset. Cite #${callIndex}, never retrieval ID. Never infer claims.`;
    }
    if (this.acceptedClaims === 0 && this.paper && this.paper.firstGap < this.paper.total) {
      return `NEXT: Read unread paper source: read_file path="/work/paper.md", offset=${this.paper.firstGap}, or search_paper query="Results" / query="Table" to target a later passage. Search offsets are navigation, not evidence. This is a source character offset, not a read_tool_result output offset. Quote only an original read_file ID.`;
    }
    if (this.output && this.output.end < this.output.total) {
      const { id, index } = this.output;
      return index
        ? `NEXT ACTION — PAGE EVIDENCE INDEX: continue read_tool_result at the displayed index page's continuation offset (not source file characters).`
        : `NEXT ACTION — PAGE ARCHIVED OUTPUT: continue read_tool_result tool_call_id=${id} at the displayed output page's continuation offset, not read_file source characters. Cite original evidence #${id}, never the retrieval call ID.`;
    }
    return null;
  }

  get pagingDiagnostics(): ReproductionPagingDiagnostics {
    return {
      sourceReadCount: this.sourceReadCount,
      sourceRepeatCount: this.sourceRepeatCount,
      outputRepeatCount: this.outputRepeatCount,
      outputNewRangeCount: this.outputNewRangeCount,
      paperFirstGap: this.paper?.firstGap ?? 0,
      paperTotal: this.paper?.total ?? 0,
      outputNextOffset: this.output?.end ?? 0,
      originalOutputCallId: this.output?.id ?? 0,
      navigation: this.extractionInstruction ? "extract" : this.acceptedClaims === 0 && this.paper && this.paper.firstGap < this.paper.total
        ? "source" : this.output && this.output.end < this.output.total ? "output" : "none",
      stalled: this.stalled,
    };
  }

  observe(
    name: string,
    result: string,
    state: { acceptedClaims: number; assessed: boolean },
    callIndex?: number,
  ): string {
    if (state.acceptedClaims !== this.acceptedClaims || state.assessed !== this.assessment) {
      this.acceptedClaims = state.acceptedClaims;
      this.assessment = state.assessed;
      this.repeats = 0;
      this.stalled = false;
      if (state.acceptedClaims > 0) {
        this.sourcePage = undefined;
        this.output = undefined;
      }
    }
    if (name === "read_tool_result") {
      const evidence = /^Original evidence tool call #(\d+) \((?:run_command|read_file|list_files)\); characters (\d+)-(\d+) of (\d+)\. Cite #\1, not this retrieval call\.[^\n]*\n/.exec(result);
      const index = /^Evidence index characters (\d+)-(\d+) of (\d+)\.\n/.exec(result);
      if (evidence || index) {
        const header = (evidence ?? index)!;
        const id = evidence ? Number(evidence[1]) : undefined;
        const start = Number(header[evidence ? 2 : 1]);
        const end = Number(header[evidence ? 3 : 2]);
        const total = Number(header[evidence ? 4 : 3]);
        const key = evidence ? `e:${id}` : "index";
        const footer = evidence ? `\n[Use offset=${end} to continue.]`
          : `\n[Use read_tool_result offset=${end} to continue evidence index.]`;
        let text = result.slice(header[0].length);
        if (end < total && text.endsWith(footer)) text = text.slice(0, -footer.length);
        if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number.isSafeInteger(total)
          && start >= 0 && end >= start && end <= total && text.length === end - start) {
          const old = this.outputRanges.get(key) ?? [];
          // Retrieval does not change scientific progress. Count only complete
          // repeated output pages; never promote a retrieval to a source read.
          const duplicate = text.length > 0 && old.some(r =>
            r.start <= start && r.start + r.text.length >= end
            && r.text.slice(start - r.start, end - r.start) === text);
          if (duplicate) {
            this.outputRepeatCount++;
            this.repeats++;
            if (this.repeats >= 7) this.stalled = true;
          } else if (text.length) {
            this.outputNewRangeCount++;
            old.push({ start, text });
            this.outputRanges.set(key, old);
          }
          this.output = { id, end, total, index: !evidence };
          // Keep the structured retrieval envelope intact for byte-aware
          // resizing. The active instruction carries paging guidance.
        }
      }
      return result;
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
      this.sourceReadCount++;
      // The tool loop may shorten a large page in the middle. Only the
      // contiguous prefix that actually reached the model counts as delivered.
      const content = result.slice(page[0].length);
      const omittedAt = content.search(/\n\n\[\.\.\. \d+ chars truncated \.\.\.\]\n\n/);
      const visible = content.slice(0, Math.min(statedEnd - start, omittedAt < 0 ? content.length : omittedAt));
      const resultsHeading = /(?:^|\n)(#{1,4})\s*(?:\d+(?:\.\d+)*\.?\s+)?(?:results?|findings|evaluation|experiments?)\b[^\n]*\n/im.exec(visible);
      let resultsBody = resultsHeading ? visible.slice(resultsHeading.index + resultsHeading[0].length) : "";
      if (resultsHeading) {
        // A deeper heading (e.g. ### Performance below ## Results) is still
        // Results. Only a sibling or ancestor heading ends the section.
        for (const heading of Array.from(resultsBody.matchAll(/^#{1,6}[ \t]+/gm))) {
          if (heading[0].trimEnd().length <= resultsHeading[1].length) {
            resultsBody = resultsBody.slice(0, heading.index);
            break;
          }
        }
      }
      const usableResults = path === "/work/paper.md"
        && Boolean(resultsHeading)
        && /\b\d+(?:\.\d+)?(?:%|\/\d+)?\b/.test(resultsBody.replace(/^#{1,6}[^\n]*$/gm, ""));
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
        if (path === "/work/paper.md") this.sourcePage = undefined;
      }
      if (this.acceptedClaims === 0 && usableResults && Number.isSafeInteger(callIndex) && callIndex! > 0) {
        this.sourcePage = { callIndex: callIndex!, start, end: statedEnd };
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
      if (path === "/work/paper.md") this.paper = { firstGap, total };
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
      this.stalled = false;
      return this.sourcePage?.callIndex === callIndex && this.extractionInstruction
        ? `${result}\n\n[${this.extractionInstruction}]` : result;
    }
    if (page) this.sourceRepeatCount++;
    this.repeats++;
    if (this.repeats >= 7) this.stalled = true;
    if (this.repeats < 2) return result;
    return `${result}\n\n[Repeated inspection ${this.repeats}/7: ${this.extractionInstruction ?? next} If earlier tool output was compacted, retrieve its original ID with read_tool_result rather than rereading the source. Repeated browsing is not a reproduced result.]`;
  }
}