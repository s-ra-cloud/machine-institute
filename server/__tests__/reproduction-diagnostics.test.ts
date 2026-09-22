import { describe, expect, it, vi } from "vitest";
import {
  ReproductionDiagnostics, attachReproductionFailureDiagnostics,
  createFallbackReproductionDiagnostics, diagnosticExcerpt, getReproductionFailureDiagnostics,
} from "../reproduction-diagnostics";

describe("private reproduction diagnostics", () => {
  it("redacts credential shapes before truncation without reading runtime secrets", () => {
    const values = [
      'HF_TOKEN="synthetic-secret-value"', "Authorization: Bearer synthetic-auth-value",
      "api_key: 'synthetic-api-value'", "password=synthetic-password-value",
      "https://user:synthetic-password@host/path?token=synthetic-query-value",
      "hf_syntheticHuggingFaceCredential", "sk-syntheticOpenAiCredential",
      "eyJabc.defghi.signature",
      "-----BEGIN PRIVATE KEY-----\nsynthetic-key-value\n-----END PRIVATE KEY-----",
    ];
    const redacted = diagnosticExcerpt(values.join("\n"), 8000);
    for (const value of ["synthetic-secret-value", "synthetic-auth-value", "synthetic-api-value",
      "synthetic-password-value", "synthetic-password", "synthetic-query-value",
      "hf_synthetic", "sk-synthetic", "eyJabc", "synthetic-key-value"]) {
      expect(redacted).not.toContain(value);
    }
    expect(redacted).toContain("REDACTED");
  });

  it("bounds escaped Unicode excerpts and aggregate snapshots with explicit omissions", () => {
    const diagnostics = new ReproductionDiagnostics();
    const long = '"\\測定🧪\n'.repeat(10_000);
    const excerpt = diagnosticExcerpt(long);
    expect(Buffer.byteLength(JSON.stringify(excerpt), "utf8")).toBeLessThanOrEqual(700);
    expect(excerpt).toContain("[TRUNCATED]");
    diagnostics.claims(Array.from({ length: 100 }, (_, i) => ({
      id: `R${i}${long}`, claim: long, status: "pending" as const,
    })));
    for (let i = 0; i < 100; i++) diagnostics.observe({
      kind: "arguments", round: i, callCount: i, responseExcerpt: long,
      toolExcerpt: long, validationErrors: Array(20).fill(long),
      finishReason: "length", argumentParse: "malformed",
    });
    const result = diagnostics.snapshot();
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(24_000);
    expect(result.truncated).toBe(true);
    expect(result.droppedEvents).toBeGreaterThan(0);
    expect(result.claims.length).toBeLessThanOrEqual(20);
    expect(result.rounds).toBe(99);
    expect(result.callCount).toBe(99);
    expect(result.events.at(-1)?.finishReason).toBe("length");
  });

  it("does not persist error bodies, headers, unknown metadata, or mutate the original error", () => {
    const original = new Error("provider raw body secret: never-store-this");
    const diagnostics = new ReproductionDiagnostics();
    diagnostics.observe({
      kind: "provider", finishReason: "raw-provider-body", toolName: "unsafe-name",
      rawBody: "never-store-this", headers: { Authorization: "never-store-this" },
    } as any);
    attachReproductionFailureDiagnostics(original, diagnostics);
    const saved = getReproductionFailureDiagnostics(original);
    expect(JSON.stringify(saved)).not.toMatch(/never-store-this|raw-provider-body|unsafe-name/);
    expect(original.message).toBe("provider raw body secret: never-store-this");
    expect(Object.keys(original)).toEqual([]);
    expect(getReproductionFailureDiagnostics(new Error())).toBeUndefined();
    expect(createFallbackReproductionDiagnostics().stage).toBe("background");
  });

  it("capture failure never throws or replaces the original failure", () => {
    const diagnostics = new ReproductionDiagnostics();
    const original = new Error("original");
    vi.spyOn(diagnostics, "snapshot").mockImplementation(() => { throw new Error("capture"); });
    expect(() => attachReproductionFailureDiagnostics(original, diagnostics)).not.toThrow();
    expect(getReproductionFailureDiagnostics(original)).toBeUndefined();
    expect(original.message).toBe("original");
  });
});