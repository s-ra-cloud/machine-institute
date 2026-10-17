import { describe, it, expect } from "vitest";
import { mergeWorks } from "../synthesis/dedupe";
import type { SourceWork } from "../synthesis/sources/types";

function work(overrides: Partial<SourceWork> & Pick<SourceWork, "source" | "sourceId" | "title">): SourceWork {
  return {
    abstract: null,
    authors: [],
    year: null,
    publicationDate: null,
    doi: null,
    arxivId: null,
    openalexId: overrides.source === "openalex" ? overrides.sourceId : null,
    s2Id: overrides.source === "semantic-scholar" ? overrides.sourceId : null,
    venue: null,
    citationCount: null,
    url: null,
    oaLandingUrl: null,
    oaPdfUrl: null,
    fields: [],
    topics: [],
    referencedWorks: [],
    language: null,
    ...overrides,
  };
}

const TITLE = "Trust in Automation: Integrating Empirical Evidence";

describe("mergeWorks", () => {
  it("merges the same work across sources by DOI and keeps provenance", () => {
    const merged = mergeWorks([
      work({ source: "semantic-scholar", sourceId: "s1", title: TITLE, doi: "10.1177/x", abstract: "A longer, complete abstract from S2.", citationCount: 2398, fields: ["Psychology", "Engineering"], authors: ["K. Hoff"] }),
      work({ source: "openalex", sourceId: "W1", title: TITLE, doi: "10.1177/x", abstract: "Short OA.", citationCount: 2410, fields: ["Psychology"], venue: "Human Factors", referencedWorks: ["W9"], authors: ["Kevin Anthony Hoff"] }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      key: "openalex:W1",
      doi: "10.1177/x",
      openalexId: "W1",
      s2Id: "s1",
      abstract: "A longer, complete abstract from S2.",
      citationCount: 2410,
      venue: "Human Factors",
      authors: ["Kevin Anthony Hoff"],
      fields: ["Psychology", "Engineering"],
      referencedWorks: ["W9"],
      sources: ["openalex", "semantic-scholar"],
      url: "https://doi.org/10.1177/x",
    });
    expect(merged[0].provenance).toEqual([
      { source: "semantic-scholar", sourceId: "s1" },
      { source: "openalex", sourceId: "W1" },
    ]);
  });

  it("merges a preprint and its journal version, preferring the journal DOI", () => {
    const merged = mergeWorks([
      work({ source: "arxiv", sourceId: "2104.01234", title: "Calibrated Trust in Language Models", arxivId: "2104.01234", doi: "10.48550/arxiv.2104.01234", year: 2021, venue: "arXiv" }),
      work({ source: "openalex", sourceId: "W5", title: "Calibrated trust in language models", doi: "10.1145/3544548", year: 2022, venue: "CHI" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].doi).toBe("10.1145/3544548");
    expect(merged[0].alternateDois).toEqual(["10.48550/arxiv.2104.01234"]);
    expect(merged[0].arxivId).toBe("2104.01234");
    expect(merged[0].venue).toBe("CHI");
  });

  it("merges transitively through different identifiers", () => {
    const merged = mergeWorks([
      work({ source: "openalex", sourceId: "W1", title: "A", doi: "10.1/a" }),
      work({ source: "semantic-scholar", sourceId: "s1", title: "A", doi: "10.1/a", arxivId: "2101.00001" }),
      work({ source: "arxiv", sourceId: "2101.00001", title: "A", arxivId: "2101.00001" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sources).toEqual(["openalex", "semantic-scholar", "arxiv"]);
  });

  it("does not merge equal titles with different journal DOIs", () => {
    const merged = mergeWorks([
      work({ source: "openalex", sourceId: "W1", title: TITLE, doi: "10.1/one", year: 2015 }),
      work({ source: "openalex", sourceId: "W2", title: TITLE, doi: "10.1/two", year: 2015 }),
    ]);
    expect(merged.map((m) => m.key)).toEqual(["openalex:W1", "openalex:W2"]);
  });

  it("does not merge equal titles more than a year apart", () => {
    const merged = mergeWorks([
      work({ source: "openalex", sourceId: "W1", title: TITLE, year: 2015 }),
      work({ source: "semantic-scholar", sourceId: "s1", title: TITLE, year: 2019 }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("does not merge on short generic titles", () => {
    const merged = mergeWorks([
      work({ source: "openalex", sourceId: "W1", title: "Introduction" }),
      work({ source: "semantic-scholar", sourceId: "s1", title: "Introduction" }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("refuses a title merge that would join two DOI-conflicting groups", () => {
    // W1 and s1 share a DOI; W2 has the same title but another journal DOI.
    const merged = mergeWorks([
      work({ source: "openalex", sourceId: "W1", title: TITLE, doi: "10.1/one" }),
      work({ source: "semantic-scholar", sourceId: "s1", title: "Different wording entirely here", doi: "10.1/one" }),
      work({ source: "openalex", sourceId: "W2", title: TITLE, doi: "10.1/two" }),
      work({ source: "arxiv", sourceId: "2101.00002", title: TITLE, arxivId: "2101.00002" }),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].provenance.map((p) => p.sourceId)).toEqual(["W1", "s1", "2101.00002"]);
    expect(merged[1].provenance.map((p) => p.sourceId)).toEqual(["W2"]);
  });

  it("is deterministic and follows input order", () => {
    const input = [
      work({ source: "arxiv", sourceId: "2101.00003", title: "Zeta paper on boundary objects", arxivId: "2101.00003" }),
      work({ source: "semantic-scholar", sourceId: "s9", title: "Alpha paper on boundary objects", doi: "10.1/alpha" }),
    ];
    const a = mergeWorks(input);
    const b = mergeWorks(input);
    expect(a).toEqual(b);
    expect(a.map((m) => m.key)).toEqual(["arxiv:2101.00003", "doi:10.1/alpha"]);
  });

  it("returns [] for no input", () => {
    expect(mergeWorks([])).toEqual([]);
  });
});
