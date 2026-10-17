// Identifier and title normalization shared by the source clients and dedupe.

// "https://doi.org/10.1/ABC." -> "10.1/abc"
export function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const doi = raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[.,;)\]]+$/, "")
    .toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : null;
}

// arXiv DOIs (10.48550/arXiv.<id>) identify the preprint, not a journal version.
export function isArxivDoi(doi: string | null | undefined): boolean {
  return !!doi && doi.startsWith("10.48550/arxiv.");
}

// "https://arxiv.org/abs/2401.01234v3" / "arXiv:2401.01234" -> "2401.01234";
// old-style ids keep their archive prefix ("hep-th/9901001").
export function normalizeArxivId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const id = raw
    .trim()
    .replace(/^https?:\/\/(www\.|export\.)?arxiv\.org\/(abs|pdf|html)\//i, "")
    .replace(/^arxiv:\s*/i, "")
    .replace(/\.pdf$/i, "")
    .replace(/v\d+$/i, "");
  if (/^\d{4}\.\d{4,5}$/.test(id)) return id;
  if (/^[a-z-]+(\.[a-z]{2})?\/\d{7}$/i.test(id)) return id.toLowerCase();
  return null;
}

export function arxivIdFromDoi(doi: string | null | undefined): string | null {
  if (!isArxivDoi(doi)) return null;
  return normalizeArxivId(doi!.slice("10.48550/arxiv.".length));
}

// Extract an arXiv id from any arxiv.org URL (landing page, PDF, HTML).
export function arxivIdFromUrl(url: string | null | undefined): string | null {
  if (!url || !/arxiv\.org\//i.test(url)) return null;
  return normalizeArxivId(url);
}

// "https://openalex.org/W123" -> "W123"
export function normalizeOpenAlexId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const id = raw.trim().replace(/^https?:\/\/(api\.)?openalex\.org\/(works\/)?/i, "").toUpperCase();
  return /^W\d+$/.test(id) ? id : null;
}

// Lowercase, strip accents and punctuation, collapse whitespace.
export function normalizeTitle(raw: string | null | undefined): string {
  return (raw || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}
