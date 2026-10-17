// Merge records of the same work coming from different sources (or the same
// source twice) into one MergedWork, keeping the provenance of every record.
//
// Two records are the same work when they share an OpenAlex id, S2 id, DOI or
// arXiv id, or when their normalized titles match with compatible years. A
// title match is refused when both groups carry different non-arXiv DOIs (two
// distinct published works). A preprint and its journal version are merged on
// purpose: for a literature synthesis they are one contribution.

import { isArxivDoi, normalizeTitle } from "./ids";
import type { SourceName, SourceWork } from "./sources/types";

export interface MergedWork {
  // Stable key: "openalex:W1", else "doi:…", "arxiv:…", "s2:…".
  key: string;
  title: string;
  abstract: string | null;
  authors: string[];
  year: number | null;
  publicationDate: string | null;
  // Preferred DOI (journal version over arXiv DOI) and every other DOI seen.
  doi: string | null;
  alternateDois: string[];
  arxivId: string | null;
  openalexId: string | null;
  s2Id: string | null;
  venue: string | null;
  citationCount: number | null;
  url: string | null;
  oaLandingUrl: string | null;
  oaPdfUrl: string | null;
  fields: string[];
  topics: string[];
  referencedWorks: string[];
  language: string | null;
  sources: SourceName[];
  provenance: Array<{ source: SourceName; sourceId: string }>;
}

// Metadata priority when sources disagree: OpenAlex has the richest
// bibliographic record, S2 next, arXiv last.
const SOURCE_PRIORITY: Record<SourceName, number> = { openalex: 0, "semantic-scholar": 1, arxiv: 2 };

// Short titles ("Introduction", "Trust") collide across unrelated works.
const MIN_TITLE_KEY_LENGTH = 20;
const MIN_TITLE_WORDS = 3;

function titleKey(title: string): string | null {
  const t = normalizeTitle(title);
  return t.length >= MIN_TITLE_KEY_LENGTH && t.split(" ").length >= MIN_TITLE_WORDS ? t : null;
}

function yearsCompatible(a: number | null, b: number | null): boolean {
  return a === null || b === null || Math.abs(a - b) <= 1;
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  // Keep the lowest index as root so results follow input order.
  union(a: number, b: number): number {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return ra;
    const [root, child] = ra < rb ? [ra, rb] : [rb, ra];
    this.parent[child] = root;
    return root;
  }
}

function journalDois(works: SourceWork[]): Set<string> {
  return new Set(works.map((w) => w.doi).filter((d): d is string => !!d && !isArxivDoi(d)));
}

function conflictingDois(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const d of a) if (b.has(d)) return false;
  return true;
}

function firstBy<T>(works: SourceWork[], pick: (w: SourceWork) => T | null | undefined): T | null {
  for (const w of works) {
    const v = pick(w);
    if (v !== null && v !== undefined && !(typeof v === "string" && v.length === 0)) return v;
  }
  return null;
}

function union<T>(lists: T[][]): T[] {
  return Array.from(new Set(lists.flat()));
}

function mergeGroup(group: SourceWork[]): MergedWork {
  const ranked = [...group].sort((a, b) => SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]);

  const allDois = union(ranked.map((w) => (w.doi ? [w.doi] : [])));
  const doi = allDois.find((d) => !isArxivDoi(d)) ?? allDois[0] ?? null;
  const openalexId = firstBy(ranked, (w) => w.openalexId);
  const arxivId = firstBy(ranked, (w) => w.arxivId);
  const s2Id = firstBy(ranked, (w) => w.s2Id);

  // OpenAlex abstracts are rebuilt from an inverted index and are sometimes
  // truncated; the longest available abstract is the most complete one.
  const abstract = ranked
    .map((w) => w.abstract)
    .filter((a): a is string => !!a)
    .reduce<string | null>((best, a) => (best === null || a.length > best.length ? a : best), null);

  const citationCounts = ranked.map((w) => w.citationCount).filter((c): c is number => c !== null);
  const authorLists = ranked.map((w) => w.authors).filter((a) => a.length > 0);

  const key = openalexId
    ? `openalex:${openalexId}`
    : doi
      ? `doi:${doi}`
      : arxivId
        ? `arxiv:${arxivId}`
        : s2Id
          ? `s2:${s2Id}`
          : `${ranked[0].source}:${ranked[0].sourceId}`;

  return {
    key,
    title: ranked[0].title,
    abstract,
    authors: authorLists[0] ?? [],
    year: firstBy(ranked, (w) => w.year),
    publicationDate: firstBy(ranked, (w) => w.publicationDate),
    doi,
    alternateDois: allDois.filter((d) => d !== doi),
    arxivId,
    openalexId,
    s2Id,
    // Prefer a journal venue over the "arXiv" placeholder.
    venue: firstBy(ranked, (w) => w.venue),
    citationCount: citationCounts.length > 0 ? Math.max(...citationCounts) : null,
    url: doi ? `https://doi.org/${doi}` : firstBy(ranked, (w) => w.url),
    oaLandingUrl: firstBy(ranked, (w) => w.oaLandingUrl),
    oaPdfUrl: firstBy(ranked, (w) => w.oaPdfUrl),
    fields: union(ranked.map((w) => w.fields)),
    topics: union(ranked.map((w) => w.topics)),
    referencedWorks: union(ranked.map((w) => w.referencedWorks)),
    language: firstBy(ranked, (w) => w.language),
    sources: union(ranked.map((w) => [w.source])),
    provenance: group.map((w) => ({ source: w.source, sourceId: w.sourceId })),
  };
}

export function mergeWorks(works: SourceWork[]): MergedWork[] {
  const uf = new UnionFind(works.length);
  const byId = new Map<string, number>();

  // Pass 1: exact identifiers always merge.
  works.forEach((w, i) => {
    const ids = [
      w.openalexId && `openalex:${w.openalexId}`,
      w.s2Id && `s2:${w.s2Id}`,
      w.doi && `doi:${w.doi}`,
      w.arxivId && `arxiv:${w.arxivId}`,
    ].filter((id): id is string => !!id);
    for (const id of ids) {
      const seen = byId.get(id);
      if (seen === undefined) byId.set(id, i);
      else uf.union(seen, i);
    }
  });

  // Pass 2: title matches, refused when the groups carry different journal DOIs.
  const members = new Map<number, number[]>();
  works.forEach((_, i) => {
    const r = uf.find(i);
    members.set(r, [...(members.get(r) ?? []), i]);
  });
  const doisOf = (root: number) => journalDois(members.get(root)!.map((k) => works[k]));

  const byTitle = new Map<string, number[]>();
  works.forEach((w, i) => {
    const t = titleKey(w.title);
    if (!t) return;
    const candidates = byTitle.get(t) ?? [];
    for (const j of candidates) {
      const ri = uf.find(i);
      const rj = uf.find(j);
      if (ri === rj) continue;
      if (!yearsCompatible(w.year, works[j].year)) continue;
      if (conflictingDois(doisOf(ri), doisOf(rj))) continue;
      const root = uf.union(ri, rj);
      const other = root === ri ? rj : ri;
      members.set(root, [...members.get(root)!, ...members.get(other)!].sort((a, b) => a - b));
      members.delete(other);
    }
    byTitle.set(t, [...candidates, i]);
  });

  return Array.from(members.keys())
    .sort((a, b) => a - b)
    .map((root) => mergeGroup(members.get(root)!.map((k) => works[k])));
}
