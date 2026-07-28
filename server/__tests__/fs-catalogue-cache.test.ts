import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  fetchAbstractsAndKeywordsCached,
  _clearFsCatalogueCacheForTest,
} from "../future-science";

// The cached wrapper delegates to fetchAbstractsAndKeywords, which walks the
// FS catalogue over HTTP. We stub global fetch to observe how many crawls
// actually hit the network.

function fsPage(items: Array<{ documentId: string; title: string }>) {
  return {
    ok: true,
    json: async () => ({
      data: items.map((i) => ({
        documentId: i.documentId,
        title: i.title,
        abstract: "abs",
        author: [{ firstName: "A", lastName: "B", institution: "X" }],
        publishedAt: "2026-07-01T00:00:00Z",
        keywords: ["k1"],
      })),
      meta: { pagination: { pageCount: 1 } },
    }),
  } as unknown as Response;
}

describe("fetchAbstractsAndKeywordsCached", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _clearFsCatalogueCacheForTest();
    vi.useFakeTimers();
    fetchMock = vi.fn(async () => fsPage([{ documentId: "d1", title: "Paper 1" }]));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    _clearFsCatalogueCacheForTest();
  });

  it("serves repeat calls from cache within the TTL", async () => {
    const first = await fetchAbstractsAndKeywordsCached([], "init-1");
    expect(first.abstracts).toHaveLength(1);
    const callsAfterFirst = fetchMock.mock.calls.length;

    const second = await fetchAbstractsAndKeywordsCached([], "init-1");
    expect(second).toBe(first); // same cached object, no new fetches
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("re-fetches after the TTL expires", async () => {
    await fetchAbstractsAndKeywordsCached([], "init-1");
    const callsAfterFirst = fetchMock.mock.calls.length;

    vi.advanceTimersByTime(2 * 60 * 1000 + 1);
    await fetchAbstractsAndKeywordsCached([], "init-1");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("shares one in-flight crawl across concurrent callers", async () => {
    const [a, b] = await Promise.all([
      fetchAbstractsAndKeywordsCached([], "init-1"),
      fetchAbstractsAndKeywordsCached([], "init-1"),
    ]);
    expect(a).toBe(b);
    // only one crawl (one page) hit the network
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("uses separate cache entries per initiative", async () => {
    await fetchAbstractsAndKeywordsCached([], "init-1");
    const callsAfterFirst = fetchMock.mock.calls.length;
    await fetchAbstractsAndKeywordsCached([], "init-2");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("does not cache failures", async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("network down");
    });
    await expect(fetchAbstractsAndKeywordsCached([], "init-1")).rejects.toThrow();
    // next call retries and succeeds
    const ok = await fetchAbstractsAndKeywordsCached([], "init-1");
    expect(ok.abstracts).toHaveLength(1);
  });
});
