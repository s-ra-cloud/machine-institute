/**
 * Render a verified source read without exceeding the tool-result byte budget.
 * Offsets and lengths are canonical JavaScript string (UTF-16) character offsets,
 * matching the source-location ranges used by reproduction evidence.
 */
const PAGE_SERIALIZED_BYTE_LIMIT = 9_000;
const MAX_REQUESTED_CHARS = 40_000;

function splitsSurrogate(text: string, index: number): boolean {
  return index > 0 && index < text.length
    && text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff
    && text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff;
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