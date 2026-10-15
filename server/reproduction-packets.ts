import { createHash } from "node:crypto";
import { renderSourcePage } from "./reproduction-source-page";

/** Coordinates are UTF-16 offsets in the immutable canonical source. */
export interface SourcePacket {
  id: string;
  start: number;
  end: number;
  text: string;
}

const PACKET_CHARS = 6000;
const PACKET_OVERLAP = 600;
/** How far an edge may move back to reach a line, sentence or word boundary. */
const BOUNDARY_WINDOW = 1200;

/**
 * Latest offset in (floor, limit] that begins a line or sentence, else a word.
 * A packet edge inside a word leaves an unquotable fragment that no
 * extraction repair can complete, so edges only fall on these boundaries.
 */
function boundaryAtOrBefore(source: string, limit: number, floor: number): number | undefined {
  const from = Math.max(0, floor);
  const window = source.slice(from, limit);
  for (const pattern of [/\n|[.!?][)"'\]*_]*[ \t]+/g, /\s+/g]) {
    let best: number | undefined;
    for (const match of window.matchAll(pattern)) best = match.index! + match[0].length;
    if (best !== undefined && best > 0) return from + best;
  }
  return undefined;
}

export function prepareSourcePackets(source: string): SourcePacket[] {
  const packets: SourcePacket[] = [];
  let start = 0;
  while (start < source.length) {
    const page = renderSourcePage("/work/paper.md", source, start, PACKET_CHARS);
    const range = /^Returned characters: (\d+)-(\d+) of \d+$/m.exec(page);
    if (!range) throw new Error("Source preparation failed: no bounded Unicode-safe packet.");
    let end = Number(range[2]);
    if (end < source.length) {
      const snapped = boundaryAtOrBefore(source, end, end - BOUNDARY_WINDOW);
      if (snapped !== undefined && snapped > start + 2 * PACKET_OVERLAP) end = snapped;
    }
    const text = source.slice(start, end);
    packets.push({ id: createHash("sha256").update(`${start}:${end}:${text}`).digest("hex"), start, end, text });
    if (end === source.length) break;
    // Overlap keeps nearby table/heading context. Start at a boundary; never split a surrogate pair.
    const target = end - PACKET_OVERLAP;
    let next = boundaryAtOrBefore(source, target, target - BOUNDARY_WINDOW) ?? target;
    if (next <= start) next = Math.max(start + 1, target);
    if (/[\uDC00-\uDFFF]/.test(source.charAt(next))) next--;
    start = Math.max(start + 1, next);
  }
  // Headings guide scheduling only; they never establish scientific meaning.
  return packets.sort((a, b) => Number(/^#{1,6}\s*(?:\d+\.?\s*)?(?:results|findings|evaluation|experiments)\b/im.test(b.text))
    - Number(/^#{1,6}\s*(?:\d+\.?\s*)?(?:results|findings|evaluation|experiments)\b/im.test(a.text))
    || a.start - b.start);
}

export interface ExtractedCandidate {
  claim: string;
  source_quote: string;
  original_value?: string;
  required_material?: string;
}

/** Does not infer numbers, paraphrases, source identity, or scientific meaning. */
export function validateCandidate(candidate: unknown, packet: SourcePacket, source?: string): string[] {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return ["candidate must be an object"];
  const c = candidate as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(c)) {
    if (!["claim", "source_quote", "original_value", "required_material"].includes(key)) errors.push(`${key} is not an extraction field`);
    else if (typeof c[key] !== "string") errors.push(`${key} must be a string`);
  }
  if (typeof c.claim !== "string" || !c.claim.trim() || c.claim.length > 2000) errors.push("claim must be nonempty and at most 2000 characters");
  if (typeof c.source_quote !== "string" || c.source_quote.trim().length < 24
    || c.source_quote.trim().split(/\s+/).length < 5 || c.source_quote.length > 4000) {
    errors.push("source_quote must contain 24–4000 characters and at least five words");
  } else {
    if (!packet.text.includes(c.source_quote)) errors.push("source_quote must occur exactly in this packet");
    if (typeof c.claim === "string" && !c.source_quote.includes(c.claim)) errors.push("claim must occur verbatim in source_quote");
    if (source && typeof c.claim === "string" && packet.text.includes(c.source_quote) && c.source_quote.includes(c.claim)) {
      const start = packet.start + packet.text.indexOf(c.source_quote) + c.source_quote.indexOf(c.claim);
      const end = start + c.claim.length;
      const word = new RegExp("[\\p{L}\\p{N}]", "u");
      if ((word.test(source[start - 1] ?? "") && word.test(c.claim.charAt(0)))
        || (word.test(source[end] ?? "") && word.test(c.claim.slice(-1)))) {
        errors.push("claim cuts through a source word; quote a complete finding, not a packet-edge fragment");
      }
    }
    for (const key of ["original_value", "required_material"]) {
      if (typeof c[key] === "string" && !c.source_quote.includes(c[key])) errors.push(`${key} must occur verbatim in source_quote`);
    }
  }
  return errors;
}