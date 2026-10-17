import { describe, it, expect } from "vitest";
import { createOpenAlexClient, parseOpenAlexWork, reconstructAbstract } from "../synthesis/sources/openalex";
import searchFixture from "./fixtures/synthesis/openalex-search.json";
import { createFakeHttp } from "./fixtures/synthesis/fake-http";

const client = (handler: Parameters<typeof createFakeHttp>[0]) => {
  const http = createFakeHttp(handler);
  return { http, oa: createOpenAlexClient({ mailto: "test@example.org", apiKey: "", minIntervalMs: 0, deps: http.deps }) };
};

describe("OpenAlex abstract reconstruction", () => {
  it("rebuilds text from the inverted index in position order", () => {
    expect(reconstructAbstract({ world: [1], hello: [0, 2] })).toBe("hello world hello");
  });

  it("returns null for missing or empty indexes", () => {
    expect(reconstructAbstract(null)).toBeNull();
    expect(reconstructAbstract({})).toBeNull();
    expect(reconstructAbstract({ bad: "x" })).toBeNull();
  });
});

describe("parseOpenAlexWork", () => {
  it("normalizes a journal article", () => {
    const w = parseOpenAlexWork(searchFixture.results[0])!;
    expect(w).toMatchObject({
      source: "openalex",
      sourceId: "W2741809807",
      openalexId: "W2741809807",
      doi: "10.1177/0018720815581247",
      arxivId: null,
      year: 2015,
      venue: "Human Factors",
      citationCount: 2410,
      url: "https://doi.org/10.1177/0018720815581247",
      authors: ["Kevin Anthony Hoff", "Masooda Bashir"],
      abstract: "We review the trust in trust automation.",
      fields: ["Psychology", "Computer Science"],
      topics: ["Human-Automation Interaction and Safety", "Explainable Artificial Intelligence (XAI)"],
      referencedWorks: ["W100", "W200"],
      language: "en",
    });
  });

  it("derives the arXiv id of a preprint and its OA links", () => {
    const w = parseOpenAlexWork(searchFixture.results[1])!;
    expect(w.arxivId).toBe("2104.01234");
    expect(w.doi).toBe("10.48550/arxiv.2104.01234");
    expect(w.abstract).toBeNull();
    expect(w.oaPdfUrl).toBe("https://arxiv.org/pdf/2104.01234");
    expect(w.fields).toEqual([]);
  });

  it("drops records without an id or title", () => {
    expect(parseOpenAlexWork(searchFixture.results[2])).toBeNull();
    expect(parseOpenAlexWork(null)).toBeNull();
  });
});

describe("OpenAlex client", () => {
  it("searches with polite-pool params, filters and select", async () => {
    const { http, oa } = client(() => ({ json: searchFixture }));
    const page = await oa.searchWorks("  trust in automation ", {
      perPage: 500,
      fromYear: 2010,
      toYear: 2024,
      types: ["article", "review"],
      filters: { "primary_topic.field.id": "32,17" },
    });
    expect(page.totalCount).toBe(2);
    expect(page.works.map((w) => w.sourceId)).toEqual(["W2741809807", "W3000000001"]);

    const p = http.params(0);
    expect(new URL(http.calls[0].url).pathname).toBe("/works");
    expect(p.get("search")).toBe("trust in automation");
    expect(p.get("per_page")).toBe("200");
    expect(p.get("mailto")).toBe("test@example.org");
    expect(p.get("api_key")).toBeNull();
    expect(p.get("filter")).toBe(
      "from_publication_date:2010-01-01,to_publication_date:2024-12-31,type:article|review,primary_topic.field.id:32 17",
    );
    expect(p.get("select")).toContain("abstract_inverted_index");
    expect(http.calls[0].headers["User-Agent"]).toContain("mailto:test@example.org");
  });

  it("adds the API key when configured", async () => {
    const http = createFakeHttp(() => ({ json: { results: [] } }));
    const oa = createOpenAlexClient({ apiKey: "k123", minIntervalMs: 0, deps: http.deps });
    await oa.searchWorks("x");
    expect(http.params(0).get("api_key")).toBe("k123");
  });

  it("batches id lookups by 50, dedupes ids and keeps the requested order", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `https://openalex.org/W${i + 1}`);
    const { http, oa } = client((call) => {
      const requested = new URL(call.url).searchParams.get("filter")!.replace("openalex_id:", "").split("|");
      // Return in reverse order and omit W7 to check ordering and missing ids.
      return {
        json: { results: requested.filter((id) => id !== "W7").reverse().map((id) => ({ id: `https://openalex.org/${id}`, title: `Work ${id}` })) },
      };
    });
    const works = await oa.getWorksByIds([...ids, "W1", "bogus"]);
    expect(http.calls).toHaveLength(3);
    expect(http.params(0).get("per_page")).toBe("50");
    expect(http.params(2).get("filter")!.split("|")).toHaveLength(20);
    expect(works).toHaveLength(119);
    expect(works.slice(0, 7).map((w) => w.sourceId)).toEqual(["W1", "W2", "W3", "W4", "W5", "W6", "W8"]);
  });

  it("fetches references from referenced_works", async () => {
    const { http, oa } = client(() => ({ json: { results: [] } }));
    const work = parseOpenAlexWork(searchFixture.results[0])!;
    await oa.getReferences(work, 1);
    expect(http.params(0).get("filter")).toBe("openalex_id:W100");
  });

  it("fetches citing works sorted by citations", async () => {
    const { http, oa } = client(() => ({ json: searchFixture }));
    await oa.getCitingWorks("https://openalex.org/W2741809807", { perPage: 10, fromYear: 2020 });
    const p = http.params(0);
    expect(p.get("filter")).toBe("cites:W2741809807,from_publication_date:2020-01-01");
    expect(p.get("sort")).toBe("cited_by_count:desc");
    expect(p.get("per_page")).toBe("10");
  });

  it("returns an empty page for an invalid id without calling the API", async () => {
    const { http, oa } = client(() => ({ json: {} }));
    expect(await oa.getCitingWorks("nope")).toEqual({ works: [], totalCount: 0 });
    expect(http.calls).toHaveLength(0);
  });
});
