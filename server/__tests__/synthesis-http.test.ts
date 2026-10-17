import { describe, it, expect } from "vitest";
import { chunk, RateLimiter, requestJson } from "../synthesis/sources/http";
import { SourceFetchError } from "../synthesis/sources/types";
import { createFakeHttp } from "./fixtures/synthesis/fake-http";

describe("synthesis HTTP layer", () => {
  it("spaces requests by the limiter interval, including concurrent ones", async () => {
    const http = createFakeHttp(() => ({ json: { ok: true } }));
    const limiter = new RateLimiter(1000);
    // Frozen clock: every caller reserves its slot at t=0, so waits must stack.
    const sleeps: number[] = [];
    const deps = { ...http.deps, now: () => 0, sleep: async (ms: number) => { sleeps.push(ms); } };
    await Promise.all([1, 2, 3].map(() => requestJson("https://x.test/a", { source: "openalex", limiter }, deps)));
    expect(http.calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("retries 429 honoring Retry-After, then succeeds", async () => {
    const http = createFakeHttp((_, i) => (i === 0 ? { status: 429, headers: { "retry-after": "7" } } : { json: { n: 1 } }));
    const out = await requestJson("https://x.test/a", { source: "openalex", limiter: new RateLimiter(0) }, http.deps);
    expect(out).toEqual({ n: 1 });
    expect(http.sleeps).toEqual([7000]);
  });

  it("backs off exponentially on 5xx and network errors", async () => {
    const http = createFakeHttp((_, i) => (i === 0 ? { status: 503 } : i === 1 ? new Error("ECONNRESET") : { json: [] }));
    await requestJson("https://x.test/a", { source: "arxiv", limiter: new RateLimiter(0) }, http.deps);
    expect(http.sleeps).toEqual([1000, 2000]);
  });

  it("throws a SourceFetchError with the status once retries are exhausted", async () => {
    const http = createFakeHttp(() => ({ status: 500 }));
    const err = await requestJson("https://x.test/a", { source: "semantic-scholar", limiter: new RateLimiter(0), maxRetries: 2 }, http.deps)
      .catch((e) => e);
    expect(err).toBeInstanceOf(SourceFetchError);
    expect(err.status).toBe(500);
    expect(err.source).toBe("semantic-scholar");
    expect(http.calls).toHaveLength(3);
  });

  it("does not retry non-retryable statuses", async () => {
    const http = createFakeHttp(() => ({ status: 404 }));
    await expect(requestJson("https://x.test/a", { source: "openalex", limiter: new RateLimiter(0) }, http.deps)).rejects.toThrow("HTTP 404");
    expect(http.calls).toHaveLength(1);
  });

  it("sends JSON bodies with a content type", async () => {
    const http = createFakeHttp(() => ({ json: {} }));
    await requestJson("https://x.test/a", { source: "openalex", limiter: new RateLimiter(0), method: "POST", body: { ids: ["a"] } }, http.deps);
    expect(http.calls[0].method).toBe("POST");
    expect(http.calls[0].headers["Content-Type"]).toBe("application/json");
    expect(http.calls[0].body).toEqual({ ids: ["a"] });
  });

  it("chunks arrays", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});
