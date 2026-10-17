// OpenAlex client for the synthesis agent: search, batch lookup by id, and the
// two citation directions used for snowballing (references and citing works).
// Uses the polite pool (mailto) and an optional API key from the environment.

import { arxivIdFromDoi, arxivIdFromUrl, normalizeDoi, normalizeOpenAlexId } from "../ids";
import { chunk, RateLimiter, requestJson, resolveDeps, type HttpDeps } from "./http";
import type { SourceWork } from "./types";

export const OPENALEX_BASE = "https://api.openalex.org";
const DEFAULT_MAILTO = "research@machine-institute.org";

// Top-level fields only: OpenAlex `select` does not accept nested paths.
const SELECT_FIELDS = [
  "id", "doi", "title", "display_name", "publication_year", "publication_date",
  "authorships", "primary_location", "best_oa_location", "cited_by_count",
  "abstract_inverted_index", "primary_topic", "topics", "referenced_works",
  "language", "type",
].join(",");

// OpenAlex caps per_page at 200 and OR-filters at 50 values.
const MAX_PER_PAGE = 200;
const ID_BATCH_SIZE = 50;

export interface OpenAlexClientOptions {
  mailto?: string;
  apiKey?: string;
  minIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  deps?: Partial<HttpDeps>;
}

export interface OpenAlexSearchOptions {
  perPage?: number;
  page?: number;
  fromYear?: number;
  toYear?: number;
  // OpenAlex work types, e.g. ["article", "preprint", "review"].
  types?: string[];
  // Extra raw filters, e.g. { "primary_topic.field.id": "17" }.
  filters?: Record<string, string>;
}

export interface OpenAlexPage {
  works: SourceWork[];
  totalCount: number | null;
}

// OpenAlex stores abstracts as { word: [positions] }; rebuild the text.
export function reconstructAbstract(inverted: unknown): string | null {
  if (!inverted || typeof inverted !== "object") return null;
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(inverted as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (Number.isInteger(pos) && pos >= 0) slots[pos] = word;
    }
  }
  const text = slots.filter((w) => w !== undefined).join(" ").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
const obj = (v: unknown): Record<string, any> | null => (v && typeof v === "object" ? (v as Record<string, any>) : null);

function uniq(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v)));
}

export function parseOpenAlexWork(raw: unknown): SourceWork | null {
  const w = obj(raw);
  const openalexId = normalizeOpenAlexId(w?.id);
  const title = str(w?.title) ?? str(w?.display_name);
  if (!w || !openalexId || !title) return null;

  const doi = normalizeDoi(w.doi);
  const primary = obj(w.primary_location);
  const bestOa = obj(w.best_oa_location);
  const arxivId =
    arxivIdFromDoi(doi) ??
    arxivIdFromUrl(primary?.landing_page_url) ??
    arxivIdFromUrl(bestOa?.landing_page_url) ??
    arxivIdFromUrl(bestOa?.pdf_url);

  const authorships = Array.isArray(w.authorships) ? w.authorships : [];
  const topics = Array.isArray(w.topics) ? w.topics : [];
  const primaryTopic = obj(w.primary_topic);

  return {
    source: "openalex",
    sourceId: openalexId,
    title: title.replace(/\s+/g, " "),
    abstract: reconstructAbstract(w.abstract_inverted_index),
    authors: uniq(authorships.map((a: any) => str(obj(a?.author)?.display_name))),
    year: Number.isInteger(w.publication_year) ? w.publication_year : null,
    publicationDate: str(w.publication_date),
    doi,
    arxivId,
    openalexId,
    s2Id: null,
    venue: str(obj(primary?.source)?.display_name),
    citationCount: Number.isFinite(w.cited_by_count) ? w.cited_by_count : null,
    url: doi ? `https://doi.org/${doi}` : str(primary?.landing_page_url) ?? `https://openalex.org/${openalexId}`,
    oaLandingUrl: str(bestOa?.landing_page_url),
    oaPdfUrl: str(bestOa?.pdf_url),
    fields: uniq([primaryTopic, ...topics].map((t: any) => str(obj(obj(t)?.field)?.display_name))),
    topics: uniq([primaryTopic, ...topics].map((t: any) => str(obj(t)?.display_name))),
    referencedWorks: uniq((Array.isArray(w.referenced_works) ? w.referenced_works : []).map(normalizeOpenAlexId)),
    language: str(w.language),
  };
}

function parseResults(json: unknown): OpenAlexPage {
  const body = obj(json);
  const results = Array.isArray(body?.results) ? body!.results : [];
  const count = obj(body?.meta)?.count;
  return {
    works: results.map(parseOpenAlexWork).filter((w: SourceWork | null): w is SourceWork => w !== null),
    totalCount: Number.isFinite(count) ? count : null,
  };
}

// OpenAlex filter values cannot contain commas (the filter separator).
function filterValue(value: string): string {
  return value.replace(/,/g, " ");
}

export function createOpenAlexClient(opts: OpenAlexClientOptions = {}) {
  const deps = resolveDeps(opts.deps);
  const limiter = new RateLimiter(opts.minIntervalMs ?? 125);
  const mailto = opts.mailto ?? process.env.OPENALEX_MAILTO ?? DEFAULT_MAILTO;
  const apiKey = opts.apiKey ?? process.env.OPENALEX_API_KEY;
  const headers = { "User-Agent": `MachineInstitute-SynthesisAgent (mailto:${mailto})` };

  function buildUrl(path: string, params: Record<string, string | undefined>): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, v);
    qs.set("mailto", mailto);
    if (apiKey) qs.set("api_key", apiKey);
    return `${OPENALEX_BASE}${path}?${qs.toString()}`;
  }

  function get(url: string): Promise<unknown> {
    return requestJson(url, {
      source: "openalex",
      limiter,
      headers,
      timeoutMs: opts.timeoutMs,
      maxRetries: opts.maxRetries,
    }, deps);
  }

  function buildFilter(search: OpenAlexSearchOptions, extra: string[] = []): string {
    const parts = [...extra];
    if (search.fromYear) parts.push(`from_publication_date:${search.fromYear}-01-01`);
    if (search.toYear) parts.push(`to_publication_date:${search.toYear}-12-31`);
    if (search.types?.length) parts.push(`type:${search.types.map(filterValue).join("|")}`);
    for (const [k, v] of Object.entries(search.filters ?? {})) parts.push(`${k}:${filterValue(v)}`);
    return parts.join(",");
  }

  const perPage = (n?: number) => String(Math.min(MAX_PER_PAGE, Math.max(1, n ?? 25)));

  async function searchWorks(query: string, search: OpenAlexSearchOptions = {}): Promise<OpenAlexPage> {
    const url = buildUrl("/works", {
      search: query.trim(),
      filter: buildFilter(search) || undefined,
      per_page: perPage(search.perPage),
      page: String(search.page ?? 1),
      select: SELECT_FIELDS,
    });
    return parseResults(await get(url));
  }

  // Fetch works by OpenAlex id, preserving the requested order and skipping unknown ids.
  async function getWorksByIds(ids: string[]): Promise<SourceWork[]> {
    const wanted = uniq(ids.map(normalizeOpenAlexId));
    const byId = new Map<string, SourceWork>();
    for (const batch of chunk(wanted, ID_BATCH_SIZE)) {
      const url = buildUrl("/works", {
        filter: `openalex_id:${batch.join("|")}`,
        per_page: String(batch.length),
        select: SELECT_FIELDS,
      });
      for (const work of parseResults(await get(url)).works) byId.set(work.sourceId, work);
    }
    return wanted.map((id) => byId.get(id)).filter((w): w is SourceWork => !!w);
  }

  // Backward snowballing: the works `work` cites.
  function getReferences(work: SourceWork, limit = 50): Promise<SourceWork[]> {
    return getWorksByIds(work.referencedWorks.slice(0, limit));
  }

  // Forward snowballing: works citing `openalexId`, most cited first.
  async function getCitingWorks(openalexId: string, search: OpenAlexSearchOptions = {}): Promise<OpenAlexPage> {
    const id = normalizeOpenAlexId(openalexId);
    if (!id) return { works: [], totalCount: 0 };
    const url = buildUrl("/works", {
      filter: buildFilter(search, [`cites:${id}`]),
      sort: "cited_by_count:desc",
      per_page: perPage(search.perPage),
      page: String(search.page ?? 1),
      select: SELECT_FIELDS,
    });
    return parseResults(await get(url));
  }

  return { searchWorks, getWorksByIds, getReferences, getCitingWorks };
}

export type OpenAlexClient = ReturnType<typeof createOpenAlexClient>;
