// Semantic Scholar Graph API client for the synthesis agent. It widens recall
// beyond OpenAlex and supplies abstracts OpenAlex lacks (via batch lookup by
// DOI / arXiv id). An API key (SEMANTIC_SCHOLAR_API_KEY) is optional.

import { arxivIdFromDoi, normalizeArxivId, normalizeDoi } from "../ids";
import { chunk, RateLimiter, requestJson, resolveDeps, type HttpDeps } from "./http";
import type { SourceWork } from "./types";

export const S2_BASE = "https://api.semanticscholar.org/graph/v1";

const FIELDS = [
  "paperId", "externalIds", "title", "abstract", "year", "publicationDate", "venue",
  "authors", "citationCount", "fieldsOfStudy", "s2FieldsOfStudy", "openAccessPdf", "url",
].join(",");

// API limits: search returns at most 100 per call, batch accepts at most 500 ids.
const MAX_SEARCH_LIMIT = 100;
const BATCH_SIZE = 500;

export interface SemanticScholarClientOptions {
  apiKey?: string;
  minIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  deps?: Partial<HttpDeps>;
}

export interface SemanticScholarSearchOptions {
  limit?: number;
  offset?: number;
  fromYear?: number;
  toYear?: number;
  fieldsOfStudy?: string[];
}

export interface SemanticScholarPage {
  works: SourceWork[];
  totalCount: number | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
const obj = (v: unknown): Record<string, any> | null => (v && typeof v === "object" ? (v as Record<string, any>) : null);

function uniq(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v)));
}

export function parseSemanticScholarPaper(raw: unknown): SourceWork | null {
  const p = obj(raw);
  const paperId = str(p?.paperId);
  const title = str(p?.title);
  if (!p || !paperId || !title) return null;

  const ext = obj(p.externalIds) ?? {};
  const doi = normalizeDoi(ext.DOI);
  const arxivId = normalizeArxivId(ext.ArXiv) ?? arxivIdFromDoi(doi);
  const s2Fields = Array.isArray(p.s2FieldsOfStudy) ? p.s2FieldsOfStudy.map((f: any) => str(obj(f)?.category)) : [];
  const fos = Array.isArray(p.fieldsOfStudy) ? p.fieldsOfStudy.map(str) : [];

  return {
    source: "semantic-scholar",
    sourceId: paperId,
    title: title.replace(/\s+/g, " "),
    abstract: str(p.abstract),
    authors: uniq((Array.isArray(p.authors) ? p.authors : []).map((a: any) => str(obj(a)?.name))),
    year: Number.isInteger(p.year) ? p.year : null,
    publicationDate: str(p.publicationDate),
    doi,
    arxivId,
    openalexId: null,
    s2Id: paperId,
    venue: str(p.venue),
    citationCount: Number.isFinite(p.citationCount) ? p.citationCount : null,
    url: doi ? `https://doi.org/${doi}` : str(p.url),
    oaLandingUrl: null,
    oaPdfUrl: str(obj(p.openAccessPdf)?.url),
    fields: uniq([...fos, ...s2Fields]),
    topics: [],
    referencedWorks: [],
    language: null,
  };
}

// S2 year filter syntax: "2015-2020", "2015-", "-2020".
function yearRange(from?: number, to?: number): string | undefined {
  if (!from && !to) return undefined;
  return `${from ?? ""}-${to ?? ""}`;
}

// Ids S2 accepts in batch lookups, derived from a work we already have.
export function semanticScholarLookupId(work: Pick<SourceWork, "s2Id" | "doi" | "arxivId">): string | null {
  if (work.s2Id) return work.s2Id;
  if (work.doi) return `DOI:${work.doi}`;
  if (work.arxivId) return `ARXIV:${work.arxivId}`;
  return null;
}

export function createSemanticScholarClient(opts: SemanticScholarClientOptions = {}) {
  const deps = resolveDeps(opts.deps);
  const apiKey = opts.apiKey ?? process.env.SEMANTIC_SCHOLAR_API_KEY;
  // Keyed access is 1 req/s; the shared unauthenticated pool is stricter, so stay slower.
  const limiter = new RateLimiter(opts.minIntervalMs ?? (apiKey ? 1100 : 3000));
  const headers: Record<string, string> = apiKey ? { "x-api-key": apiKey } : {};
  const base = { source: "semantic-scholar" as const, limiter, headers, timeoutMs: opts.timeoutMs, maxRetries: opts.maxRetries };

  async function searchPapers(query: string, search: SemanticScholarSearchOptions = {}): Promise<SemanticScholarPage> {
    const qs = new URLSearchParams({
      query: query.trim(),
      limit: String(Math.min(MAX_SEARCH_LIMIT, Math.max(1, search.limit ?? 25))),
      offset: String(search.offset ?? 0),
      fields: FIELDS,
    });
    const years = yearRange(search.fromYear, search.toYear);
    if (years) qs.set("year", years);
    if (search.fieldsOfStudy?.length) qs.set("fieldsOfStudy", search.fieldsOfStudy.join(","));

    const body = obj(await requestJson(`${S2_BASE}/paper/search?${qs.toString()}`, base, deps));
    const data = Array.isArray(body?.data) ? body!.data : [];
    return {
      works: data.map(parseSemanticScholarPaper).filter((w: SourceWork | null): w is SourceWork => w !== null),
      totalCount: Number.isFinite(body?.total) ? body!.total : null,
    };
  }

  // Look up papers by S2 id, "DOI:<doi>" or "ARXIV:<id>". The result is aligned
  // with `ids`: null where S2 does not know the paper.
  async function getPapersByIds(ids: string[]): Promise<Array<SourceWork | null>> {
    const out: Array<SourceWork | null> = [];
    for (const batch of chunk(ids, BATCH_SIZE)) {
      const json = await requestJson(
        `${S2_BASE}/paper/batch?fields=${encodeURIComponent(FIELDS)}`,
        { ...base, method: "POST", body: { ids: batch } },
        deps,
      );
      const rows = Array.isArray(json) ? json : [];
      for (let i = 0; i < batch.length; i++) out.push(parseSemanticScholarPaper(rows[i]));
    }
    return out;
  }

  return { searchPapers, getPapersByIds };
}

export type SemanticScholarClient = ReturnType<typeof createSemanticScholarClient>;
