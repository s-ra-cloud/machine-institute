import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { createArxivClient, extractArxivTerms, searchArxiv } from "../synthesis/sources/arxiv";
import { createFakeHttp } from "./fixtures/synthesis/fake-http";

const FEED = readFileSync(new URL("./fixtures/synthesis/arxiv-feed.xml", import.meta.url), "utf8");
const EMPTY_FEED = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`;

describe("extractArxivTerms", () => {
  it("drops stopwords, short words and duplicates", () => {
    expect(extractArxivTerms("How does trust in the automation of trust happen?")).toEqual(["trust", "automation"]);
  });
});

// The legacy helper is used by the literature review and editorial agents;
// these tests pin its output so the move out of routes.ts changes nothing.
describe("searchArxiv (legacy helper)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the original result shape with 500-char summaries", async () => {
    const longFeed = FEED.replace("Short summary.", "x".repeat(800));
    const fetchMock = vi.fn(async () => new Response(longFeed));
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchArxiv("calibrated trust language models");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      "https://export.arxiv.org/api/query?search_query=all:calibrated+AND+all:trust+AND+all:language+AND+all:models&start=0&max_results=10&sortBy=relevance&sortOrder=descending",
    );
    expect(results[0]).toEqual({
      title: "Calibrated Trust in Language Models",
      summary: "We study how users calibrate trust &amp; reliance when interacting with &lt;LLM&gt; assistants.",
      authors: "Ana Lopez, Jean Dupont",
      published: "2021-04-02",
      arxivId: "2104.01234",
    });
    expect(results[1].arxivId).toBe("hep-th/9901001");
    expect(results[1].summary).toHaveLength(500);
  });

  it("broadens to an OR query when the AND query is empty", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(EMPTY_FEED))
      .mockResolvedValueOnce(new Response(FEED));
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchArxiv("calibrated trust");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("search_query=all:calibrated+OR+all:trust");
    expect(results).toHaveLength(2);
  });

  it("returns [] on HTTP errors and network failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    expect(await searchArxiv("trust")).toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await searchArxiv("trust")).toEqual([]);
  });
});

describe("arXiv client (synthesis)", () => {
  it("normalizes entries into SourceWork with full, decoded abstracts", async () => {
    const http = createFakeHttp(() => ({ text: FEED }));
    const arxiv = createArxivClient({ minIntervalMs: 0, deps: http.deps });
    const [first, second] = await arxiv.searchWorks("calibrated trust", { maxResults: 500, start: 20 });

    expect(first).toMatchObject({
      source: "arxiv",
      sourceId: "2104.01234",
      arxivId: "2104.01234",
      title: "Calibrated Trust in Language Models",
      abstract: "We study how users calibrate trust & reliance when interacting with <LLM> assistants.",
      authors: ["Ana Lopez", "Jean Dupont"],
      year: 2021,
      doi: "10.1145/3544548.3581000",
      fields: ["cs.HC", "cs.CL"],
      url: "https://arxiv.org/abs/2104.01234",
      oaPdfUrl: "https://arxiv.org/pdf/2104.01234",
    });
    // Without a journal DOI, the arXiv DOI is used.
    expect(second.doi).toBe("10.48550/arxiv.hep-th/9901001");
    expect(second.year).toBe(1999);

    const p = http.params(0);
    expect(p.get("max_results")).toBe("100");
    expect(p.get("start")).toBe("20");
  });

  it("waits three seconds between requests by default", async () => {
    const http = createFakeHttp((_, i) => ({ text: i === 0 ? EMPTY_FEED : FEED }));
    const arxiv = createArxivClient({ deps: http.deps });
    const works = await arxiv.searchWorks("calibrated trust");
    expect(http.calls).toHaveLength(2);
    expect(http.calls[1].url).toContain("+OR+");
    expect(http.sleeps).toEqual([3000]);
    expect(works).toHaveLength(2);
  });

  it("does not broaden single-term queries", async () => {
    const http = createFakeHttp(() => ({ text: EMPTY_FEED }));
    const arxiv = createArxivClient({ minIntervalMs: 0, deps: http.deps });
    expect(await arxiv.searchWorks("trust")).toEqual([]);
    expect(http.calls).toHaveLength(1);
  });
});
