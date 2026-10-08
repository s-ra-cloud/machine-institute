/**
 * Render a verified source read without exceeding the tool-result byte budget.
 * Offsets and lengths are canonical JavaScript string (UTF-16) character offsets,
 * matching the source-location ranges used by reproduction evidence.
 */
const PAGE_SERIALIZED_BYTE_LIMIT = 9_000;
const MAX_REQUESTED_CHARS = 40_000;

/** A targeted read is still a literal, contiguous source page, not a summary. */
export function readTargetedSourcePage(path: string, text: string, args: Record<string, unknown>): string {
  const offset = args.offset === undefined ? 0 : args.offset;
  const max = args.max_chars === undefined ? 12_000 : args.max_chars;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
    || offset > text.length || splitsSurrogate(text, offset))
    return "Refused: offset must be a valid canonical character offset at a Unicode character boundary.";
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1)
    return "Refused: max_chars must be a positive integer.";
  if (args.query === undefined) return renderSourcePage(path, text, offset, max);
  if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 128)
    return "Refused: query must be a nonblank literal string of at most 128 characters.";
  const match = text.indexOf(args.query, offset);
  if (match < 0)
    return `No literal match at or after offset ${offset}. This is navigation feedback, not evidence that a scientific material or result is missing. Try another exact symbol or read_file without query.`;
  return renderSourcePage(path, text, match, max);
}

function splitsSurrogate(text: string, index: number): boolean {
  return index > 0 && index < text.length
    && text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff
    && text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff;
}

/**
 * Navigation only: search the immutable canonical paper, never a sandbox path.
 * Match offsets are UTF-16 source coordinates, not claims or read evidence.
 * Limit both scanning work and output; overlap the scan boundary so a literal
 * spanning it is found on this page without losing its starting offset.
 */
export function searchPaperSource(text: string, args: Record<string, unknown>): string {
  const query = args.query;
  const offset = args.offset === undefined ? 0 : args.offset;
  if (Object.keys(args).some(key => key !== "query" && key !== "offset")) {
    return "Refused: search_paper accepts only query and offset; it cannot inspect other paths.";
  }
  if (typeof query !== "string" || !query.trim() || query.length > 128) {
    return "Refused: query must be a nonblank literal string of at most 128 characters.";
  }
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
    || offset > text.length || splitsSurrogate(text, offset)) {
    return "Refused: offset must be a valid canonical character offset at a Unicode character boundary.";
  }
  let scanEnd = Math.min(text.length, offset + 250_000);
  if (splitsSurrogate(text, scanEnd)) scanEnd--;
  const window = text.slice(offset, Math.min(text.length, scanEnd + query.length));
  const literal = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const matches: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  let next = scanEnd;
  while ((match = literal.exec(window)) !== null) {
    const start = offset + match.index;
    if (start >= scanEnd) break;
    const end = start + match[0].length;
    if (splitsSurrogate(text, start) || splitsSurrogate(text, end)) continue;
    matches.push({ start, end });
    if (matches.length === 12) { next = end; break; }
  }
  return JSON.stringify({
    path: "/work/paper.md", query, matches, total: text.length,
    next_offset: next < text.length ? next : null,
    instruction: "Navigation only, not evidence. Matches are literal occurrences, not verified Results or claims. Use read_file path=/work/paper.md offset=MATCH_START, then follow its continuation to read surrounding results/tables. Register only an exact quote and page range from that actual read_file and its ORIGINAL read ID, never this search ID. Use next_offset with search_paper for more matches; no matches in a scan does not imply no result in the paper.",
  });
}

export function renderSourcePage(path: string, text: string, offset = 0, requested = 12_000): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || splitsSurrogate(text, offset)) {
    return `Refused: invalid source offset; use a character offset from 0 to ${text.length} at a Unicode character boundary.`;
  }
  if (!Number.isSafeInteger(requested) || requested < 1) {
    return "Refused: max_chars must be a positive integer.";
  }

  let maxEnd = Math.min(text.length, offset + Math.min(requested, MAX_REQUESTED_CHARS));
  if (splitsSurrogate(text, maxEnd)) maxEnd--;
  const render = (end: number): string => {
    const more = end < text.length
      ? `\n\n[... ${text.length - end} more chars; total ${text.length}. Use offset=${end} to continue ...]`
      : "";
    return `Verified file: ${path}\nReturned characters: ${offset}-${end} of ${text.length}\n---\n${text.slice(offset, end)}${more}`;
  };
  const fits = (page: string) => Buffer.byteLength(JSON.stringify(page), "utf8") <= PAGE_SERIALIZED_BYTE_LIMIT;

  // The continuation is computed from the actual delivered end, not the
  // requested end. Binary search keeps even highly escaped source text bounded.
  let low = offset;
  let high = maxEnd;
  while (low < high) {
    let mid = Math.ceil((low + high) / 2);
    if (splitsSurrogate(text, mid)) mid++;
    if (fits(render(mid))) low = mid;
    else {
      high = mid - 1;
      if (splitsSurrogate(text, high)) high--;
    }
  }
  if (low === offset && offset < text.length) {
    return "Refused: no complete Unicode character fits within the source page budget and requested max_chars.";
  }
  const page = render(low);
  if (!fits(page)) return "Refused: source page metadata exceeds the 9000-byte serialized budget.";
  return page;
}