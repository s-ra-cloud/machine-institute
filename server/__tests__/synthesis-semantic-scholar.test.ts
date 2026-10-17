import { describe, it, expect } from "vitest";
import {
  createSemanticScholarClient,
  parseSemanticScholarPaper,
  semanticScholarLookupId,
} from "../synthesis/sources/semantic-scholar";
import searchFixture from "./fixtures/synthesis/s2-search.json";
import { createFakeHttp } from "./fixtures/synthesis/fake-http";

describe("parseSemanticScholarPaper", () => {
  it("normalizes a paper with a DOI", () => {
    const w = parseSemanticScholarPaper(searchFixture.data[0])!;
    expect(w).toMatchObject({
      source: "semantic-scholar",
      sourceId: "a1b2c3d4e5",
      s2Id: "a1b2c3d4e5",
      doi: "10.1177/0018720815581247",
      arxivId: null,
      year: 2015,
      venue: "Human Factors",
      citationCount: 2398,
      url: "https://doi.org/10.1177/0018720815581247",
      fields: ["Psychology", "Medicine", "Engineering"],
    });
    expect(w.abstract).toMatch(/^We systematically review/);
  });

  it("normalizes an arXiv paper without abstract or venue", () => {
    const w = parseSemanticScholarPaper(searchFixture.data[1])!;
    expect(w.arxivId).toBe("2104.01234");
    expect(w.doi).toBeNull();
    expect(w.abstract).toBeNull();
    expect(w.venue).toBeNull();
    expect(w.oaPdfUrl).toBe("https://arxiv.org/pdf/2104.01234");
    expect(w.url).toBe("https://www.semanticscholar.org/paper/f6g7h8");
    expect(w.fields).toEqual(["Computer Science"]);
  });

  it("drops records without a title", () => {
    expect(parseSemanticScholarPaper(searchFixture.data[2])).toBeNull();
    expect(parseSemanticScholarPaper(null)).toBeNull();
  });

  it("builds lookup ids by preference: S2 id, DOI, arXiv", () => {
    expect(semanticScholarLookupId({ s2Id: "abc", doi: "10.1/x", arxivId: null })).toBe("abc");
    expect(semanticScholarLookupId({ s2Id: null, doi: "10.1/x", arxivId: "2104.01234" })).toBe("DOI:10.1/x");
    expect(semanticScholarLookupId({ s2Id: null, doi: null, arxivId: "2104.01234" })).toBe("ARXIV:2104.01234");
    expect(semanticScholarLookupId({ s2Id: null, doi: null, arxivId: null })).toBeNull();
  });
});

describe("Semantic Scholar client", () => {
  it("searches with year range, field filter and capped limit", async () => {
    const http = createFakeHttp(() => ({ json: searchFixture }));
    const s2 = createSemanticScholarClient({ apiKey: "", minIntervalMs: 0, deps: http.deps });
    const page = await s2.searchPapers("trust in automation", { limit: 250, offset: 50, fromYear: 2015, fieldsOfStudy: ["Psychology", "Sociology"] });
    expect(page.totalCount).toBe(1532);
    expect(page.works).toHaveLength(2);

    const p = http.params(0);
    expect(new URL(http.calls[0].url).pathname).toBe("/graph/v1/paper/search");
    expect(p.get("query")).toBe("trust in automation");
    expect(p.get("limit")).toBe("100");
    expect(p.get("offset")).toBe("50");
    expect(p.get("year")).toBe("2015-");
    expect(p.get("fieldsOfStudy")).toBe("Psychology,Sociology");
    expect(p.get("fields")).toContain("externalIds");
    expect(http.calls[0].headers["x-api-key"]).toBeUndefined();
  });

  it("sends the API key header when configured", async () => {
    const http = createFakeHttp(() => ({ json: { data: [] } }));
    const s2 = createSemanticScholarClient({ apiKey: "secret", minIntervalMs: 0, deps: http.deps });
    await s2.searchPapers("x");
    expect(http.calls[0].headers["x-api-key"]).toBe("secret");
  });

  it("paces unauthenticated requests more slowly than keyed ones", async () => {
    const anon = createFakeHttp(() => ({ json: { data: [] } }));
    const keyed = createFakeHttp(() => ({ json: { data: [] } }));
    const a = createSemanticScholarClient({ apiKey: "", deps: anon.deps });
    const k = createSemanticScholarClient({ apiKey: "secret", deps: keyed.deps });
    await a.searchPapers("x"); await a.searchPapers("y");
    await k.searchPapers("x"); await k.searchPapers("y");
    expect(anon.sleeps).toEqual([3000]);
    expect(keyed.sleeps).toEqual([1100]);
  });

  it("batch-looks-up ids in chunks of 500, aligned with the input", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `DOI:10.1/${i}`);
    const http = createFakeHttp((call) => ({
      json: (call.body as { ids: string[] }).ids.map((id, i) => (i === 1 ? null : { paperId: `p-${id}`, title: `T ${id}` })),
    }));
    const s2 = createSemanticScholarClient({ apiKey: "", minIntervalMs: 0, deps: http.deps });
    const out = await s2.getPapersByIds(ids);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[0].method).toBe("POST");
    expect(new URL(http.calls[0].url).pathname).toBe("/graph/v1/paper/batch");
    expect((http.calls[0].body as { ids: string[] }).ids).toHaveLength(500);
    expect(out).toHaveLength(501);
    expect(out[0]?.sourceId).toBe("p-DOI:10.1/0");
    expect(out[1]).toBeNull();
    expect(out[500]?.sourceId).toBe("p-DOI:10.1/500");
  });
});
