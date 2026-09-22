import { createHash } from "node:crypto";

export const QUESTIONING_PROVENANCE_LIMITS = Object.freeze({
  persistedBytes: 32 * 1024 * 1024,
  blobBytes: 29 * 1024 * 1024,
  metadataBytes: 2 * 1024 * 1024,
  executionOutputReserveBytes: 512 * 1024,
  maxBlobs: 4096,
});
export class QuestioningProvenanceLimitError extends Error {
  constructor(detail: string) {
    super(`qP provenance capacity reached: ${detail}. No unretained source version may execute; report this resource limitation, not scientific success.`);
    this.name = "QuestioningProvenanceLimitError";
  }
}
export const serializedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
/** Measure JSON string escaping without allocating the escaped copy (a 25 MiB
 * control-character source could otherwise allocate 150 MiB just to reject it). */
export function jsonStringBytes(text: string, ceiling = Number.POSITIVE_INFINITY): number {
  let bytes = Buffer.byteLength(text, "utf8") + 2;
  if (bytes > ceiling) return Number.POSITIVE_INFINITY;
  const special = /["\\\u0000-\u001f\uD800-\uDFFF]/g;
  let match: RegExpExecArray | null;
  while ((match = special.exec(text))) {
    const code = text.charCodeAt(match.index);
    if (code >= 0xD800 && code <= 0xDBFF && text.charCodeAt(match.index + 1) >= 0xDC00 && text.charCodeAt(match.index + 1) <= 0xDFFF) {
      special.lastIndex++; // Valid pairs already have the correct UTF-8 length.
    } else if (code >= 0xD800 && code <= 0xDFFF) bytes += 3; // Well-formed JSON escapes lone surrogates.
    else if (code < 32 && ![8, 9, 10, 12, 13].includes(code)) bytes += 5;
    else bytes += 1;
    if (bytes > ceiling) return Number.POSITIVE_INFINITY;
  }
  return bytes;
}

/** Source/output text occurs once, regardless of original/change/run references.
 * The budget counts JSON escaping, not merely raw source byte lengths. */
export class QuestioningBlobStore {
  readonly blobs: Record<string, string> = Object.create(null);
  readonly index: Record<string, { bytes: number; characters: number }> = Object.create(null);
  serializedBytes = 2;
  private count = 0;
  put(content: string): string {
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (Object.prototype.hasOwnProperty.call(this.blobs, sha256)) return sha256;
    if (this.count >= QUESTIONING_PROVENANCE_LIMITS.maxBlobs)
      throw new QuestioningProvenanceLimitError("blob catalogue exceeds 4096 unique objects");
    if (Buffer.byteLength(content, "utf8") > this.remainingBytes)
      throw new QuestioningProvenanceLimitError("unique source/output bytes exceed the bounded blob budget");
    const size = jsonStringBytes(content, this.remainingBytes - sha256.length - 4) + sha256.length + 4;
    if (size > this.remainingBytes)
      throw new QuestioningProvenanceLimitError("JSON-escaped source/output exceeds the bounded blob budget");
    this.blobs[sha256] = content;
    this.index[sha256] = { bytes: Buffer.byteLength(content, "utf8"), characters: content.length };
    this.serializedBytes += size;
    this.count++;
    return sha256;
  }
  get remainingBytes() { return QUESTIONING_PROVENANCE_LIMITS.blobBytes - this.serializedBytes; }
  read(sha256: string): string | undefined { return this.blobs[sha256]; }
}
export interface QuestioningProvenanceRecord {
  schemaVersion: 2;
  persona: "qP";
  blobs: Record<string, string>;
  blobIndex: Record<string, { bytes: number; characters: number }>;
  [key: string]: unknown;
}