import { describe, it, expect } from "vitest";
import {
  arxivIdFromDoi,
  arxivIdFromUrl,
  decodeXmlEntities,
  isArxivDoi,
  normalizeArxivId,
  normalizeDoi,
  normalizeOpenAlexId,
  normalizeTitle,
} from "../synthesis/ids";

describe("synthesis id normalization", () => {
  it("normalizes DOIs from URLs, prefixes and trailing punctuation", () => {
    expect(normalizeDoi("https://doi.org/10.1177/0018720815581247")).toBe("10.1177/0018720815581247");
    expect(normalizeDoi("doi: 10.1145/ABC.Def.")).toBe("10.1145/abc.def");
    expect(normalizeDoi("http://dx.doi.org/10.1000/xyz)")).toBe("10.1000/xyz");
    expect(normalizeDoi("not a doi")).toBeNull();
    expect(normalizeDoi(null)).toBeNull();
  });

  it("recognizes arXiv DOIs and extracts their id", () => {
    const doi = normalizeDoi("10.48550/arXiv.2104.01234");
    expect(isArxivDoi(doi)).toBe(true);
    expect(arxivIdFromDoi(doi)).toBe("2104.01234");
    expect(isArxivDoi("10.1145/1")).toBe(false);
    expect(arxivIdFromDoi("10.1145/1")).toBeNull();
  });

  it("normalizes new- and old-style arXiv ids, dropping versions", () => {
    expect(normalizeArxivId("https://arxiv.org/abs/2104.01234v3")).toBe("2104.01234");
    expect(normalizeArxivId("arXiv:2104.01234")).toBe("2104.01234");
    expect(normalizeArxivId("https://arxiv.org/pdf/2104.01234v1.pdf")).toBe("2104.01234");
    expect(normalizeArxivId("hep-th/9901001v2")).toBe("hep-th/9901001");
    expect(normalizeArxivId("math.AG/0601001")).toBe("math.ag/0601001");
    expect(normalizeArxivId("1234")).toBeNull();
  });

  it("only extracts arXiv ids from arxiv.org URLs", () => {
    expect(arxivIdFromUrl("https://arxiv.org/html/2104.01234v2")).toBe("2104.01234");
    expect(arxivIdFromUrl("https://example.org/abs/2104.01234")).toBeNull();
  });

  it("normalizes OpenAlex ids", () => {
    expect(normalizeOpenAlexId("https://openalex.org/W2741809807")).toBe("W2741809807");
    expect(normalizeOpenAlexId("https://api.openalex.org/works/w12")).toBe("W12");
    expect(normalizeOpenAlexId("A123")).toBeNull();
  });

  it("normalizes titles across accents, case, markup and punctuation", () => {
    expect(normalizeTitle("La Confiance <i>en</i> l'Automatisation : Revue!")).toBe("la confiance en l automatisation revue");
    expect(normalizeTitle("Économie   de la CONFIANCE")).toBe(normalizeTitle("economie de la confiance"));
  });

  it("decodes XML entities, decoding &amp; last", () => {
    expect(decodeXmlEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&apos; &#233;")).toBe(`a & b <c> "d" 'e' é`);
    expect(decodeXmlEntities("&amp;lt;")).toBe("&lt;");
  });
});
