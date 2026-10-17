// arXiv search shared by the Lab agents.
//
// `searchArxiv` is the original helper used by the literature review and
// editorial pipelines (moved here from routes.ts, behavior unchanged).
// `createArxivClient` is the synthesis-agent client: full abstracts,
// categories and DOIs normalized into SourceWork, with arXiv's requested
// pacing of one request every three seconds.

import { decodeXmlEntities, normalizeArxivId, normalizeDoi } from "../ids";
import { RateLimiter, requestText, resolveDeps, type HttpDeps } from "./http";
import type { SourceWork } from "./types";

export const ARXIV_API = "https://export.arxiv.org/api/query";

const ARXIV_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "for", "with",
  "by", "from", "as", "at", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "how", "what", "why", "when", "where", "which", "who",
  "whom", "that", "this", "these", "those", "it", "its", "if", "then", "than",
  "so", "such", "can", "could", "would", "should", "may", "might", "will",
  "about", "into", "over", "under", "between", "happen", "happens", "happened",
  "occur", "occurs", "cause", "causes", "caused", "effect", "effects", "make",
  "makes", "get", "gets", "use", "used", "using", "study", "paper", "research",
]);

export function extractArxivTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !ARXIV_STOPWORDS.has(w));
  return Array.from(new Set(words));
}

// AND the most salient topic terms so results are on-topic; fall back to the raw query if nothing survives cleaning.
function andExpression(query: string, terms: string[]): string {
  return terms.length > 0
    ? terms.slice(0, 4).map(t => `all:${encodeURIComponent(t)}`).join("+AND+")
    : `all:${encodeURIComponent(query.trim())}`;
}

function orExpression(terms: string[]): string {
  return terms.slice(0, 6).map(t => `all:${encodeURIComponent(t)}`).join("+OR+");
}

interface ArxivEntry {
  title: string;
  summary: string;
  authors: string[];
  published: string;
  arxivId: string;
  doi: string | null;
  categories: string[];
}

function parseArxivEntries(xml: string): ArxivEntry[] {
  const entries: ArxivEntry[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];
    const idMatch = entry.match(/<id>([\s\S]*?)<\/id>/);
    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
    const publishedMatch = entry.match(/<published>([\s\S]*?)<\/published>/);
    const doiMatch = entry.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/);
    const authorMatches = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)];
    const categoryMatches = [...entry.matchAll(/<category[^>]*\bterm="([^"]+)"/g)];
    const rawId = (idMatch?.[1] || "").trim();
    entries.push({
      title: (titleMatch?.[1] || "").trim().replace(/\s+/g, " "),
      summary: (summaryMatch?.[1] || "").trim().replace(/\s+/g, " "),
      authors: authorMatches.map(m => m[1].trim()),
      published: (publishedMatch?.[1] || "").trim().substring(0, 10),
      arxivId: rawId.replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/v\d+$/, ""),
      doi: doiMatch ? doiMatch[1].trim() : null,
      categories: Array.from(new Set(categoryMatches.map(m => m[1]))),
    });
  }
  return entries;
}

export interface ArxivSearchResult {
  title: string;
  summary: string;
  authors: string;
  published: string;
  arxivId: string;
}

export async function searchArxiv(query: string): Promise<ArxivSearchResult[]> {
  const fetchArxiv = async (searchExpr: string) => {
    // Sort by relevance so results actually match the topic, not just the newest submissions.
    const url = `${ARXIV_API}?search_query=${searchExpr}&start=0&max_results=10&sortBy=relevance&sortOrder=descending`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`arXiv API returned ${response.status}`);
      return [];
    }
    return parseArxivEntries(await response.text()).map(e => ({
      title: e.title,
      summary: e.summary.substring(0, 500),
      authors: e.authors.join(", "),
      published: e.published,
      arxivId: e.arxivId,
    }));
  };

  try {
    const terms = extractArxivTerms(query);
    let entries = await fetchArxiv(andExpression(query, terms));
    // If the AND query was too strict and returned nothing, broaden to an OR of the terms.
    if (entries.length === 0 && terms.length > 1) {
      entries = await fetchArxiv(orExpression(terms));
    }
    return entries;
  } catch (err) {
    console.error("arXiv search failed:", err);
    return [];
  }
}

function toSourceWork(e: ArxivEntry): SourceWork | null {
  const arxivId = normalizeArxivId(e.arxivId);
  const title = decodeXmlEntities(e.title);
  if (!arxivId || !title) return null;
  // The <arxiv:doi> element is the journal version; fall back to arXiv's own DOI.
  const doi = normalizeDoi(e.doi) ?? normalizeDoi(`10.48550/arXiv.${arxivId}`);
  const year = /^\d{4}/.test(e.published) ? Number(e.published.slice(0, 4)) : null;
  return {
    source: "arxiv",
    sourceId: arxivId,
    title,
    abstract: e.summary ? decodeXmlEntities(e.summary) : null,
    authors: e.authors.map(decodeXmlEntities),
    year,
    publicationDate: e.published || null,
    doi,
    arxivId,
    openalexId: null,
    s2Id: null,
    venue: "arXiv",
    citationCount: null,
    url: `https://arxiv.org/abs/${arxivId}`,
    oaLandingUrl: `https://arxiv.org/abs/${arxivId}`,
    oaPdfUrl: `https://arxiv.org/pdf/${arxivId}`,
    fields: e.categories,
    topics: [],
    referencedWorks: [],
    language: null,
  };
}

export interface ArxivClientOptions {
  minIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  deps?: Partial<HttpDeps>;
}

export interface ArxivWorksSearchOptions {
  maxResults?: number;
  start?: number;
}

export function createArxivClient(opts: ArxivClientOptions = {}) {
  const deps = resolveDeps(opts.deps);
  const limiter = new RateLimiter(opts.minIntervalMs ?? 3000);
  const base = { source: "arxiv" as const, limiter, timeoutMs: opts.timeoutMs, maxRetries: opts.maxRetries };

  async function query(expr: string, search: ArxivWorksSearchOptions): Promise<SourceWork[]> {
    const max = Math.min(100, Math.max(1, search.maxResults ?? 25));
    const url = `${ARXIV_API}?search_query=${expr}&start=${search.start ?? 0}&max_results=${max}&sortBy=relevance&sortOrder=descending`;
    const xml = await requestText(url, base, deps);
    return parseArxivEntries(xml).map(toSourceWork).filter((w): w is SourceWork => w !== null);
  }

  // Same AND-then-OR term strategy as searchArxiv, with full abstracts.
  async function searchWorks(text: string, search: ArxivWorksSearchOptions = {}): Promise<SourceWork[]> {
    const terms = extractArxivTerms(text);
    const works = await query(andExpression(text, terms), search);
    if (works.length > 0 || terms.length <= 1) return works;
    return query(orExpression(terms), search);
  }

  return { searchWorks };
}

export type ArxivClient = ReturnType<typeof createArxivClient>;
