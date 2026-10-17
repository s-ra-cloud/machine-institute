// Shared shape for works returned by the open academic sources used by the
// interdisciplinary synthesis agent (OpenAlex, Semantic Scholar, arXiv).
// Every source client normalizes its records into SourceWork so retrieval,
// snowballing and dedupe never deal with provider-specific payloads.

export type SourceName = "openalex" | "semantic-scholar" | "arxiv";

export interface SourceWork {
  source: SourceName;
  // The provider's own identifier: OpenAlex short id (W123), S2 paperId, or arXiv id.
  sourceId: string;
  title: string;
  abstract: string | null;
  authors: string[];
  year: number | null;
  publicationDate: string | null;
  // Cross-source identifiers, already normalized (see ids.ts).
  doi: string | null;
  arxivId: string | null;
  openalexId: string | null;
  s2Id: string | null;
  venue: string | null;
  citationCount: number | null;
  // Best landing page for a human reader (DOI link when known).
  url: string | null;
  oaLandingUrl: string | null;
  oaPdfUrl: string | null;
  // Discipline labels as the provider classifies them (OpenAlex fields,
  // S2 fields of study, arXiv categories).
  fields: string[];
  // Finer topical labels when the provider has them (OpenAlex topics).
  topics: string[];
  // OpenAlex short ids of the works this one cites (OpenAlex only).
  referencedWorks: string[];
  language: string | null;
}

export class SourceFetchError extends Error {
  constructor(
    message: string,
    public readonly source: SourceName,
    public readonly url: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SourceFetchError";
  }
}
