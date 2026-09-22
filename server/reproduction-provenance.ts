import { createHash } from "node:crypto";

export const PROVENANCE_PAGE_LIMIT = 16_384;
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

/** A transport view only: never rewrite historical persisted evidence.
 * All source versions (including legacy inline before/after/files) remain
 * recoverable as UTF-8 SHA-256-addressed blobs. The manifest itself is paged
 * text, so even a single enormous record cannot bypass the response bound.
 */
export function provenancePage(saved: string, query: Record<string, unknown>) {
  function integer(value: unknown, fallback: number, max: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Invalid pagination parameter.");
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > max) throw new Error("Pagination parameter exceeds limit.");
    return number;
  }
  const offset = integer(query.offset, 0, Number.MAX_SAFE_INTEGER);
  const limit = integer(query.limit, 8192, PROVENANCE_PAGE_LIMIT);
  if (limit < 1) throw new Error("Page limit must be positive.");
  if (query.hash !== undefined && (typeof query.hash !== "string" || !/^[a-f0-9]{64}$/.test(query.hash))) {
    throw new Error("Invalid blob hash.");
  }
  const parsed: unknown = JSON.parse(saved);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("Invalid provenance record.");
  const root = parsed as Record<string, unknown>;
  const blobs = new Map<string, string>();
  const put = (content: string) => {
    const hash = sha256(content);
    blobs.set(hash, content);
    return { $blob: hash, length: content.length, bytes: Buffer.byteLength(content, "utf8") };
  };
  // Current runtime format already deduplicates these. Validate addresses
  // rather than serving tampered content under an incorrect hash.
  if (root.blobs !== undefined && (!root.blobs || typeof root.blobs !== "object" || Array.isArray(root.blobs))) {
    throw new SyntaxError("Invalid provenance blob catalogue.");
  }
  if (root.blobs && typeof root.blobs === "object" && !Array.isArray(root.blobs)) {
    for (const [hash, value] of Object.entries(root.blobs)) {
      const content = typeof value === "string" ? value
        : value && typeof value === "object" && "content" in value ? (value as { content: unknown }).content : undefined;
      if (typeof content !== "string" || sha256(content) !== hash) throw new SyntaxError("Invalid provenance blob.");
      blobs.set(hash, content);
    }
  }
  const contentKeys = new Set(["content", "before", "after", "output"]);
  function normalize(value: unknown, key = "", depth = 0): unknown {
    if (depth > 100) throw new SyntaxError("Provenance nesting exceeds limit.");
    if (typeof value === "string") return value.length > 512 || contentKeys.has(key) ? put(value) : value;
    if (Array.isArray(value)) return value.map(item => normalize(item, key, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, normalize(item, name, depth + 1)]),
    );
    return value;
  }
  const { blobs: _storedBlobs, ...record } = root;
  const normalized = normalize(record);
  const manifest = JSON.stringify({
    transportVersion: 1,
    record: normalized,
    blobs: Object.fromEntries(Array.from(blobs).map(([hash, content]) => [
      hash, { length: content.length, bytes: Buffer.byteLength(content, "utf8") },
    ])),
  }, null, 2);
  const hash = query.hash as string | undefined;
  if (hash && !blobs.has(hash)) return null;
  const text = hash ? blobs.get(hash)! : manifest;
  const end = Math.min(offset + limit, text.length);
  return {
    kind: hash ? "blob" : "manifest",
    hash: hash ?? null,
    encoding: "utf-16-code-units",
    offset,
    limit,
    total: text.length,
    nextOffset: end < text.length ? end : null,
    blobCount: blobs.size,
    data: text.slice(offset, end),
  };
}