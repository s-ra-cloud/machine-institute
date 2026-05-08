import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  verifyCitations,
  analyzeInTextVsBibliography,
  classifyBody,
  type ExtractedCitation,
} from "../citation-verifier";

type FetchHandler = (url: string) => { ok: boolean; status?: number; text?: string; json?: unknown } | null;

function installFetchMock(handler: FetchHandler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = handler(url);
    if (!r) {
      throw new Error(`Unmocked fetch: ${url}`);
    }
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      text: async () => r.text ?? "",
      json: async () => r.json ?? {},
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("verifyCitations — two-source rule", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("Cho case (arXiv:2410.04468): arXiv resolves, OpenAlex returns unrelated work — should NOT flag mismatch", async () => {
    const arxivTitle =
      "Do Large Language Models Have an English Accent? Evaluating and Improving the Naturalness of Multilingual LLMs";
    const openalexUnrelatedTitle = "A completely different paper about widgets and gizmos";

    installFetchMock((url) => {
      if (url.includes("arxiv.org/abs/2410.04468")) {
        return {
          ok: true,
          text: `<html><head><meta name="citation_title" content="${arxivTitle}"></head></html>`,
        };
      }
      if (url.includes("api.openalex.org")) {
        return {
          ok: true,
          json: { results: [{ id: "https://openalex.org/W123", title: openalexUnrelatedTitle }] },
        };
      }
      return null;
    });

    const citation: ExtractedCitation = {
      raw: "arXiv:2410.04468",
      arxivId: "2410.04468",
      context:
        "Cho et al. (2024). Do Large Language Models Have an English Accent? Evaluating and Improving the Naturalness of Multilingual LLMs. arXiv:2410.04468",
    };

    const [result] = await verifyCitations([citation], []);
    expect(result.verifiedSource).toBe("arxiv");
    expect(result.verifiedTitle).toBe(arxivTitle);
    expect(result.titleMatchesClaim).toBe(true);
  });

  it("arXiv-only resolution (OpenAlex does not resolve) — should NOT flag mismatch even when title differs", async () => {
    const arxivTitle =
      "Do Large Language Models Have an English Accent? Evaluating and Improving the Naturalness of Multilingual LLMs";

    installFetchMock((url) => {
      if (url.includes("arxiv.org/abs/2410.04468")) {
        return {
          ok: true,
          text: `<html><head><meta name="citation_title" content="${arxivTitle}"></head></html>`,
        };
      }
      if (url.includes("api.openalex.org")) {
        return { ok: true, json: { results: [] } };
      }
      return null;
    });

    const citation: ExtractedCitation = {
      raw: "arXiv:2410.04468",
      arxivId: "2410.04468",
      context: "Cho et al. (2024). Some completely different bibliography line wording. arXiv:2410.04468",
    };

    const [result] = await verifyCitations([citation], []);
    expect(result.verifiedSource).toBe("arxiv");
    expect(result.verifiedTitle).toBe(arxivTitle);
    expect(result.titleMatchesClaim).toBe(true);
    expect(result.matchNote).toMatch(/single-source|OpenAlex did not resolve/i);
  });

  it("Two-source agreement on a wrong title — SHOULD flag mismatch", async () => {
    const wrongTitle = "Quantum Entanglement of Sourdough Starters";
    installFetchMock((url) => {
      if (url.includes("arxiv.org/abs/")) {
        return {
          ok: true,
          text: `<html><head><meta name="citation_title" content="${wrongTitle}"></head></html>`,
        };
      }
      if (url.includes("api.openalex.org")) {
        return {
          ok: true,
          json: { results: [{ id: "https://openalex.org/W999", title: wrongTitle }] },
        };
      }
      return null;
    });

    const citation: ExtractedCitation = {
      raw: "arXiv:1234.56789",
      arxivId: "1234.56789",
      context: "Smith et al. (2023). Attention Is All You Need For Transformers. arXiv:1234.56789",
    };

    const [result] = await verifyCitations([citation], []);
    expect(result.verifiedSource).toBe("arxiv");
    expect(result.titleMatchesClaim).toBe(false);
    expect(result.matchNote).toMatch(/two-source agreement/i);
  });
});

describe("analyzeInTextVsBibliography", () => {
  it("flags Brown et al. (2020) as inTextOnly when no bibliography entry exists", () => {
    const fullText = `
Introduction

This paper builds on the foundational work of Brown et al. (2020), who introduced
the GPT-3 architecture. We also draw heavily on Smith (2019) for evaluation methods.
Throughout the experiments, the methodology of Smith (2019) was followed precisely.

References

Smith, J. (2019). A study of methods for evaluating language models. Journal of NLP,
12(3), 45-67.
`;
    const a = analyzeInTextVsBibliography(fullText);
    expect(a.bibliographyDetected).toBe(true);
    expect(a.inTextCount).toBeGreaterThanOrEqual(2);
    expect(a.bibliographyCount).toBeGreaterThanOrEqual(1);
    const brown = a.inTextOnly.find((e) => /Brown/.test(e.authorYear));
    expect(brown).toBeDefined();
    expect(brown!.authorYear).toMatch(/2020/);
    expect(a.inTextOnly.find((e) => /Smith/.test(e.authorYear))).toBeUndefined();
  });
});

describe("classifyBody", () => {
  it("S3 AccessDenied XML => broken", () => {
    const body =
      '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>';
    const r = classifyBody(body);
    expect(r.kind).toBe("broken");
    expect(r.reason).toMatch(/access-denied|no-such-key/i);
  });

  it("S3 NoSuchKey XML => broken", () => {
    const body = "<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>";
    expect(classifyBody(body).kind).toBe("broken");
  });

  it("Cloudflare interstitial => bot-blocked", () => {
    const body = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body><h1>Checking your browser before accessing the site.</h1>
<p>Please enable JavaScript and cookies. cf-ray: 1234abcd</p></body></html>`;
    const r = classifyBody(body);
    expect(r.kind).toBe("bot-blocked");
    expect(r.reason).toMatch(/bot|captcha|interstitial|browser/i);
  });

  it("uninformative body => unknown", () => {
    expect(classifyBody("<html><body>Hello</body></html>").kind).toBe("unknown");
  });
});
