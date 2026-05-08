import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  verifyCitations,
  verifyUrls,
  analyzeInTextVsBibliography,
  classifyBody,
  type ExtractedCitation,
} from "../citation-verifier";

type FetchHandler = (
  url: string,
  method: string,
) => { ok: boolean; status?: number; text?: string; json?: unknown } | null;

function installFetchMock(handler: FetchHandler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toString().toUpperCase();
    const r = handler(url, method);
    if (!r) {
      throw new Error(`Unmocked fetch: ${method} ${url}`);
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

  it("compound-author citations match multi-author bibliography entries", () => {
    const fullText = `
Introduction

Following Crosbie and Shutova (2024), we used jailbreak prompts. The work of
Yin & Steinhardt (2025) extends this further, while Heimersheim and Nanda (2024)
offers a complementary view. Olsson et al. (2022) introduced induction heads.
Brown et al. (2020) is foundational but is not in our bibliography.

References

Crosbie, J., & Shutova, E. (2024). Jailbreak prompts in practice. Journal of AI Safety, 1(1), 1-20.
Yin, Z., & Steinhardt, J. (2025). Extending alignment results. Proceedings of NeurIPS.
Heimersheim, S., & Nanda, N. (2024). Complementary mechanistic views. arXiv:2401.00001.
Olsson, C., Elhage, N., Nanda, N., et al. (2022). In-context learning and induction heads. Transformer Circuits.
`;
    const a = analyzeInTextVsBibliography(fullText);
    expect(a.bibliographyDetected).toBe(true);
    expect(a.bibliographyCount).toBeGreaterThanOrEqual(4);

    expect(a.inTextOnly.find((e) => /Crosbie/.test(e.authorYear))).toBeUndefined();
    expect(a.inTextOnly.find((e) => /Shutova/.test(e.authorYear))).toBeUndefined();
    expect(a.inTextOnly.find((e) => /Yin/.test(e.authorYear))).toBeUndefined();
    expect(a.inTextOnly.find((e) => /Steinhardt/.test(e.authorYear))).toBeUndefined();
    expect(a.inTextOnly.find((e) => /Heimersheim/.test(e.authorYear))).toBeUndefined();
    expect(a.inTextOnly.find((e) => /\bNanda\b/.test(e.authorYear))).toBeUndefined();
    expect(a.inTextOnly.find((e) => /Olsson/.test(e.authorYear))).toBeUndefined();

    const brown = a.inTextOnly.find((e) => /Brown/.test(e.authorYear));
    expect(brown).toBeDefined();
    expect(brown!.authorYear).toMatch(/2020/);
  });

  it("Olsson et al. (2022) matches a 4+-author bibliography entry via has_etal rule", () => {
    const fullText = `
Body text

Olsson et al. (2022) showed induction heads emerge during training.

References

Olsson, C., Elhage, N., Nanda, N., et al. (2022). In-context learning and induction heads. Transformer Circuits.
`;
    const a = analyzeInTextVsBibliography(fullText);
    expect(a.inTextOnly.length).toBe(0);
  });

  it("normalises diacritics and ampersands", () => {
    const fullText = `
Body text

The result of Müller & Dupont (2023) confirms ours.

References

Müller, A., & Dupont, J. (2023). A French-German collaboration. Journal X, 5, 1-10.
`;
    const a = analyzeInTextVsBibliography(fullText);
    expect(a.inTextOnly.length).toBe(0);
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

describe("verifyUrls — reachability classification", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("200 OK => ok", async () => {
    installFetchMock(() => ({ ok: true, status: 200 }));
    const [r] = await verifyUrls(["https://example.com/paper"]);
    expect(r.classification).toBe("ok");
    expect(r.reachable).toBe(true);
    expect(r.status).toBe(200);
  });

  it("404 => broken (resource not found)", async () => {
    installFetchMock(() => ({ ok: false, status: 404 }));
    const [r] = await verifyUrls(["https://example.com/missing"]);
    expect(r.classification).toBe("broken");
    expect(r.reachable).toBe(false);
    expect(r.status).toBe(404);
    expect(r.note).toMatch(/404.*not found/i);
  });

  it("410 => broken (resource gone)", async () => {
    installFetchMock(() => ({ ok: false, status: 410 }));
    const [r] = await verifyUrls(["https://example.com/gone"]);
    expect(r.classification).toBe("broken");
    expect(r.reachable).toBe(false);
    expect(r.status).toBe(410);
    expect(r.note).toMatch(/410.*not found/i);
  });

  it("429 => rate-limited (do NOT flag)", async () => {
    installFetchMock(() => ({ ok: false, status: 429 }));
    const [r] = await verifyUrls(["https://example.com/throttled"]);
    expect(r.classification).toBe("rate-limited");
    expect(r.reachable).toBeNull();
    expect(r.status).toBe(429);
    expect(r.note).toMatch(/429|rate-limited/i);
  });

  it("500 => server-error (do NOT flag)", async () => {
    installFetchMock(() => ({ ok: false, status: 500 }));
    const [r] = await verifyUrls(["https://example.com/broken-backend"]);
    expect(r.classification).toBe("server-error");
    expect(r.reachable).toBeNull();
    expect(r.status).toBe(500);
    expect(r.note).toMatch(/500|server error/i);
  });

  it("403 with S3 AccessDenied body => broken", async () => {
    const s3Body =
      '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>';
    installFetchMock((_url, method) => {
      if (method === "HEAD") return { ok: false, status: 403 };
      return { ok: false, status: 403, text: s3Body };
    });
    const [r] = await verifyUrls(["https://bucket.s3.amazonaws.com/dead-object"]);
    expect(r.classification).toBe("broken");
    expect(r.reachable).toBe(false);
    expect(r.status).toBe(403);
    expect(r.note).toMatch(/access-denied|no-such-key/i);
    expect(r.bodySnippet).toMatch(/AccessDenied/);
  });

  it("403 with Cloudflare interstitial => bot-blocked (do NOT flag)", async () => {
    const cfBody = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body><h1>Checking your browser before accessing the site.</h1>
<p>Please enable JavaScript and cookies. cf-ray: 1234abcd</p></body></html>`;
    installFetchMock((_url, method) => {
      if (method === "HEAD") return { ok: false, status: 403 };
      return { ok: false, status: 403, text: cfBody };
    });
    const [r] = await verifyUrls(["https://protected.example.com/paper"]);
    expect(r.classification).toBe("bot-blocked");
    expect(r.reachable).toBeNull();
    expect(r.status).toBe(403);
    expect(r.note).toMatch(/bot|interstitial|do not flag/i);
    expect(r.bodySnippet).toMatch(/Just a moment|Checking your browser/);
  });

  it("403 with uninformative body + Wayback hit => bot-blocked (do NOT flag)", async () => {
    installFetchMock((url, method) => {
      if (url.includes("archive.org/wayback/available")) {
        return {
          ok: true,
          json: {
            archived_snapshots: {
              closest: { available: true, status: "200", url: "https://web.archive.org/web/20240101/https://example.com/paper" },
            },
          },
        };
      }
      if (method === "HEAD") return { ok: false, status: 403 };
      return { ok: false, status: 403, text: "<html><body>Forbidden</body></html>" };
    });
    const [r] = await verifyUrls(["https://example.com/paper"]);
    expect(r.classification).toBe("bot-blocked");
    expect(r.reachable).toBeNull();
    expect(r.status).toBe(403);
    expect(r.waybackTried).toBe(true);
    expect(r.waybackOk).toBe(true);
    expect(r.note).toMatch(/wayback.*200|likely bot-blocked/i);
  });

  it("403 with uninformative body + no Wayback snapshot => broken", async () => {
    installFetchMock((url, method) => {
      if (url.includes("archive.org/wayback/available")) {
        return { ok: true, json: { archived_snapshots: {} } };
      }
      if (method === "HEAD") return { ok: false, status: 403 };
      return { ok: false, status: 403, text: "<html><body>Forbidden</body></html>" };
    });
    const [r] = await verifyUrls(["https://example.com/paper"]);
    expect(r.classification).toBe("broken");
    expect(r.reachable).toBe(false);
    expect(r.status).toBe(403);
    expect(r.waybackTried).toBe(true);
    expect(r.waybackOk).toBe(false);
    expect(r.note).toMatch(/no wayback snapshot.*broken/i);
  });

  describe("SSRF guard", () => {
    it("localhost => skipped (no fetch issued)", async () => {
      const fetchMock = installFetchMock(() => ({ ok: true }));
      const [r] = await verifyUrls(["http://localhost:8080/secret"]);
      expect(r.reachable).toBeNull();
      expect(r.classification).toBe("unknown");
      expect(r.note).toMatch(/skipped.*internal hostname/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("IP literal => skipped (no fetch issued)", async () => {
      const fetchMock = installFetchMock(() => ({ ok: true }));
      const [r] = await verifyUrls(["http://127.0.0.1/admin"]);
      expect(r.reachable).toBeNull();
      expect(r.classification).toBe("unknown");
      expect(r.note).toMatch(/skipped.*ip literal/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("non-http scheme => skipped (no fetch issued)", async () => {
      const fetchMock = installFetchMock(() => ({ ok: true }));
      const [r] = await verifyUrls(["file:///etc/passwd"]);
      expect(r.reachable).toBeNull();
      expect(r.classification).toBe("unknown");
      expect(r.note).toMatch(/skipped.*non-http scheme/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
