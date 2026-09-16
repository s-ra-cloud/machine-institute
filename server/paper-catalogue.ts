// Shared catalogue of a journal's papers eligible for single-paper agents
// (peer review, reproduction). Fetches the journal's Future Science corpus +
// the project paper log, dedupes by documentId, and drops the institute's own
// generated publications so agents never review or reproduce each other.

import { fetchAbstractsAndKeywordsCached } from "./future-science";
import { storage } from "./storage";
import { INITIATIVE_DOC_IDS, INITIATIVE_SLUGS } from "./journals";

export interface CataloguePaper {
  documentId: string;
  title: string;
  authors: string;
  date: string;
  url: string;
}

const OWN_TITLE_PREFIXES = [
  "single-paper ethics audit",
  "publication audit",
  "field ethics report",
  "publication audit field report",
  "literature review:",
  "editorial:",
  "basic peer review:",
  "adversarial peer review:",
  "innovation peer review:",
  "rigorous peer review:",
  "reproduction report:",
];

// Author codes of every institute agent role (H, bER/bLR/aLR, O, reviewers, P).
const OWN_AUTHOR_RE = /machinstit\s+\S+(h|ber|blr|alr|o|br|ar|ir|rr|p)-n\d/;

export function isOwnPublication(title: string, authors: string): boolean {
  const t = (title || "").toLowerCase().trim();
  const a = (authors || "").toLowerCase();
  if (OWN_TITLE_PREFIXES.some(p => t.startsWith(p))) return true;
  return OWN_AUTHOR_RE.test(a);
}

export async function fetchJournalPaperCatalogue(journalId: string): Promise<{ initiativeSlug: string; papers: CataloguePaper[] } | null> {
  const initiativeDocId = INITIATIVE_DOC_IDS[journalId];
  if (!initiativeDocId) return null;
  const initiativeSlug = INITIATIVE_SLUGS[journalId] || journalId;

  const [fsData, projectPapers] = await Promise.all([
    fetchAbstractsAndKeywordsCached([], initiativeDocId).catch(() => ({ abstracts: [] as Array<{ documentId: string; title: string; authors: string; date: string }> })),
    storage.getProjectPapers(journalId),
  ]);

  const seen = new Set<string>();
  const papers: CataloguePaper[] = [];
  for (const a of fsData.abstracts) {
    if (!a.documentId || seen.has(a.documentId)) continue;
    seen.add(a.documentId);
    if (isOwnPublication(a.title, a.authors)) continue;
    papers.push({
      documentId: a.documentId,
      title: a.title,
      authors: a.authors,
      date: a.date,
      url: `https://future-science.org/${initiativeSlug}/${a.documentId}`,
    });
  }
  for (const p of projectPapers) {
    if (!p.sourceDocumentId || seen.has(p.sourceDocumentId)) continue;
    seen.add(p.sourceDocumentId);
    if (isOwnPublication(p.title, p.authors)) continue;
    papers.push({
      documentId: p.sourceDocumentId,
      title: p.title,
      authors: p.authors,
      date: p.date,
      url: p.url || `https://future-science.org/${initiativeSlug}/${p.sourceDocumentId}`,
    });
  }
  papers.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return { initiativeSlug, papers };
}
