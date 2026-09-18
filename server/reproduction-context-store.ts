import { createHash } from "node:crypto";

export interface ReproductionContextEntry {
  ref: string;
  key: string;
  text: string;
}

/** Immutable, run-local storage for material which must survive prompt compaction. */
export class ReproductionContextStore {
  private nextRef = 1;
  private entries: ReproductionContextEntry[] = [];
  private dedup = new Map<string, string>();

  archive(key: string, text: string): ReproductionContextEntry {
    const digest = createHash("sha256").update(key).update("\0").update(text).digest("hex");
    const existingRef = this.dedup.get(digest);
    if (existingRef) return this.entries[Number(existingRef) - 1];
    const entry = { ref: String(this.nextRef++), key, text };
    this.entries.push(entry);
    this.dedup.set(digest, entry.ref);
    return entry;
  }

  get(ref: string): ReproductionContextEntry | undefined {
    return this.entries[Number(ref) - 1]?.ref === ref ? this.entries[Number(ref) - 1] : undefined;
  }

  list(): readonly ReproductionContextEntry[] {
    return this.entries;
  }
}