import { describe, expect, it, vi } from "vitest";
import { QuestioningState } from "../reproduction-questioning";
import { ReproductionSession } from "../reproduction-session";
import { QuestioningBlobStore, QuestioningProvenanceLimitError, QUESTIONING_PROVENANCE_LIMITS, jsonStringBytes } from "../reproduction-provenance-store";

describe("bounded content-addressed qP provenance", () => {
  it("retains near-limit 25 MiB source once across 100 executions, with only linear small-reference growth", () => {
    const q = new QuestioningState();
    const source = "UNIQUE_SOURCE_MARKER\n" + "x".repeat(25 * 1024 * 1024);
    q.addOriginal("/work/materials/data.txt", source);
    q.addOriginal("/work/materials/run.py", "print('metric=1')");
    const initial = Buffer.byteLength(q.json(), "utf8");
    const session = new ReproductionSession(() => []);
    session.questioning = q;
    const serialization = vi.spyOn(q, "json");
    for (let index = 0; index < 100; index++) {
      const run = q.snapshot("python materials/run.py");
      q.recordExecutionOutput(run, `metric=${index}`);
      run.status = "executed";
      session.activeInstruction();
    }
    // Compaction/recovery must not archive 100 copies of a 25 MiB payload.
    expect(serialization).not.toHaveBeenCalled();
    expect(Object.keys(q.blobStore.blobs)).toHaveLength(102);
    const saved = q.json();
    expect(Buffer.byteLength(saved, "utf8") - initial).toBeLessThan(150_000);
    expect(Buffer.byteLength(saved, "utf8")).toBeLessThan(QUESTIONING_PROVENANCE_LIMITS.persistedBytes);
    const record = JSON.parse(saved);
    expect(record.schemaVersion).toBe(2);
    const originalHash = record.originals["/work/materials/data.txt"];
    for (const [index, run] of record.executions.entries()) {
      expect(run.files[`${run.snapshot}/materials/data.txt`]).toBe(originalHash);
      expect(record.blobs[run.outputHash]).toBe(`metric=${index}`);
    }
    expect(record.blobs[originalHash]).toBe(source);
    const metadata = q.metadata();
    expect(metadata).not.toHaveProperty("blobs");
    expect(JSON.stringify(metadata)).not.toContain("UNIQUE_SOURCE_MARKER");
    expect(Buffer.byteLength(q.markdown(), "utf8")).toBeLessThanOrEqual(32768);
    expect(q.markdown()).not.toContain("UNIQUE_SOURCE_MARKER");
    expect(Buffer.byteLength(q.judgeContext(), "utf8")).toBeLessThanOrEqual(16000);
    expect(q.judgeContext()).not.toContain("UNIQUE_SOURCE_MARKER");
    const page = JSON.parse(session.readContext({ ref: `qp:blob:${originalHash}`, offset: source.length - 1000, max_chars: 1000 }));
    expect(page.text).toBe("x".repeat(1000));
    expect(page.total_chars).toBe(source.length);
    expect(page.next_offset).toBeNull();
  });

  it("deduplicates original, before/after and output references without losing prior executed versions", () => {
    const q = new QuestioningState();
    q.addOriginal("/work/materials/code.py", "old code");
    q.assessment = { decision: "adapt", research_question: "question", question_quote: "quote", rationale: "rationale", comparability: "not comparable",
      claim_ids: ["R1"], evidence: [{ tool_call_id: 1, excerpt: "inspected evidence" }], intended_changes: "change",
      planned_changes: [{ path: "/work/working/materials/code.py", reason: "A justified scientific change", claim_ids: ["R1"] }] };
    q.write("/work/working/materials/code.py", "new code", "A justified scientific change");
    const run = q.snapshot("python materials/code.py");
    q.write("/work/working/materials/code.py", "old code", "Restore original implementation for comparison");
    const record = JSON.parse(q.json());
    expect(Object.keys(record.blobs)).toHaveLength(2);
    expect(record.blobs[record.changes[0].beforeHash]).toBe("old code");
    expect(record.blobs[record.changes[0].afterHash]).toBe("new code");
    expect(record.blobs[run.files[`${run.snapshot}/materials/code.py`]]).toBe("new code");
    expect(record.changes[1].afterHash).toBe(record.originals["/work/materials/code.py"]);
  });

  it("refuses an oversized new source before retaining it and reports the limit without executing unretained edits", () => {
    const q = new QuestioningState();
    q.addOriginal("/work/materials/code.py", "a".repeat(25 * 1024 * 1024));
    q.assessment = { decision: "adapt", research_question: "question", question_quote: "quote", rationale: "rationale", comparability: "not comparable",
      claim_ids: ["R1"], evidence: [{ tool_call_id: 1, excerpt: "inspected evidence" }], intended_changes: "change",
      planned_changes: [{ path: "/work/working/materials/code.py", reason: "A justified scientific change", claim_ids: ["R1"] }] };
    expect(q.write("/work/working/materials/code.py", "b".repeat(5 * 1024 * 1024), "A justified scientific change")).toContain("capacity reached");
    expect(Object.keys(q.blobStore.blobs)).toHaveLength(1);
    expect(q.changes).toHaveLength(0);
    expect(q.gate("run_command")).toContain("No unretained source version");
    const claims = [{ id: "R1", claim: "claim", status: "pending" as const }];
    expect(q.finalizeBlockedClaims(claims)).toBe(true);
    expect(claims[0].status).toBe("inconclusive");
    expect(q.markdown()).toContain("Resource limitation");
    expect(Buffer.byteLength(q.json())).toBeLessThan(QUESTIONING_PROVENANCE_LIMITS.persistedBytes);
  });

  it("accounts for escaped JSON bytes and does not retain rejected oversized blobs", () => {
    const store = new QuestioningBlobStore();
    expect(() => store.put("\u0000".repeat(5 * 1024 * 1024))).toThrow(QuestioningProvenanceLimitError);
    expect(Object.keys(store.blobs)).toHaveLength(0);
    const first = store.put('quoted " unicode 🧬\n');
    expect(store.put('quoted " unicode 🧬\n')).toBe(first);
    expect(Object.keys(store.blobs)).toHaveLength(1);
    for (const content of ['a"b\\c\n\t\r\b\f', "\u0000\u001f", "🧬", "\uD800", "\uDC00", "漢字\u2028\u2029"]) {
      expect(jsonStringBytes(content)).toBe(Buffer.byteLength(JSON.stringify(content)));
    }
  });

  it("bounds large file-table metadata before creating excessive snapshot reference tables", () => {
    const q = new QuestioningState();
    for (let i = 0; i < 2000; i++) q.addOriginal(`/work/materials/file-${i}.txt`, "same source");
    expect(() => {
      for (let i = 0; i < 100; i++) q.snapshot("python materials/file-0.txt");
    }).toThrow(QuestioningProvenanceLimitError);
    expect(q.executions.length).toBeLessThan(100);
    expect(q.limitation).toContain("metadata");
    expect(Object.keys(q.blobStore.blobs)).toHaveLength(1);
    expect(Buffer.byteLength(q.json())).toBeLessThan(QUESTIONING_PROVENANCE_LIMITS.persistedBytes);
    expect(Buffer.byteLength(q.judgeContext())).toBeLessThanOrEqual(16000);
  });

  it("stores the complete dependency manifest as one recoverable blob, not repeated inline manifests", () => {
    const q = new QuestioningState();
    const manifest = [{ root: "/dependencies", sha256: "a".repeat(64), files: 5000,
      fileHashes: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`module-${i}.py`, "b".repeat(64)])) }];
    q.setDependencyManifest(manifest);
    expect(q.dependencyManifest).toEqual([{ root: "/dependencies", sha256: "a".repeat(64), files: 5000, bytes: undefined }]);
    expect(JSON.parse(q.readBlob(q.dependencyManifestHash!)!)).toEqual(manifest);
    expect(JSON.stringify(q.metadata())).not.toContain("module-4999.py");
    expect(q.markdown()).not.toContain("module-4999.py");
  });
});