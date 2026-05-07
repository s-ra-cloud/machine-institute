import type { FutureScienceAbstract } from "./future-science";

const FS_API_BASE = "https://future-science.org/api/v1";
const OPENALEX_BASE = "https://api.openalex.org";
const OPENALEX_UA = "MachineInstitute-EthicsAuditor (mailto:research@machine-institute.org)";

export interface ExtractedCitation {
  raw: string;
  doi?: string;
  arxivId?: string;
  fsRef?: string;
  authorYear?: { author: string; year: string };
}

export interface VerifiedCitation extends ExtractedCitation {
  verifiedSource: "future-science" | "openalex" | "none";
  verifiedTitle?: string;
  verifiedUrl?: string;
}

export interface PaperVerification {
  paperTitle: string;
  hadFullText: boolean;
  citations: VerifiedCitation[];
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function deepFindLongString(node: unknown, minLen: number, depth = 0): string | null {
  if (depth > 6 || node == null) return null;
  if (typeof node === "string") return node.length >= minLen ? node : null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = deepFindLongString(v, minLen, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const preferred = ["content", "contentMarkdown", "contentHtml", "body", "bodyHtml", "markdown", "html", "text", "fullText", "documentContent", "richContent"];
    for (const k of preferred) {
      if (k in obj) {
        const r = deepFindLongString(obj[k], minLen, depth + 1);
        if (r) return r;
      }
    }
    for (const k of Object.keys(obj)) {
      if (preferred.includes(k)) continue;
      const r = deepFindLongString(obj[k], minLen, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

export async function fetchFsPaperContent(documentId: string, slug: string = "mirror"): Promise<string | null> {
  if (!documentId) return null;
  const candidates = [
    `https://future-science.org/${slug}/papers/${encodeURIComponent(documentId)}`,
    `${FS_API_BASE}/public/contributions/${encodeURIComponent(documentId)}`,
    `${FS_API_BASE}/contributions/${encodeURIComponent(documentId)}`,
  ];
  for (const url of candidates) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(url, {
        headers: { "User-Agent": "MachineInstitute-EthicsAuditor", "Accept": "text/html,application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) continue;
      const ctype = (resp.headers.get("content-type") || "").toLowerCase();
      if (ctype.includes("application/json")) {
        const json: unknown = await resp.json();
        const found = deepFindLongString(json, 200);
        if (found) return found.includes("<") ? stripHtml(found) : found;
        continue;
      }
      const html = await resp.text();
      if (!html || html.length < 200) continue;
      const stripped = stripHtml(html);
      // The page shell alone is short; require enough content to look like a paper body.
      if (stripped.length >= 800) return stripped;
    } catch {
      // try next
    }
  }
  return null;
}

export function extractCitations(text: string): ExtractedCitation[] {
  const out: ExtractedCitation[] = [];
  const seen = new Set<string>();
  if (!text) return out;

  const doiRe = /\b10\.\d{4,9}\/[^\s,;)\]<>"']+/g;
  let m: RegExpExecArray | null;
  while ((m = doiRe.exec(text))) {
    const doi = m[0].replace(/[.,;)\]]+$/, "");
    const k = `doi:${doi.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ raw: m[0], doi });
  }

  const arxivRe = /arxiv\.org\/abs\/(\d{4}\.\d{4,5})|arXiv:\s*(\d{4}\.\d{4,5})/gi;
  while ((m = arxivRe.exec(text))) {
    const id = m[1] || m[2];
    const k = `arxiv:${id}`;
    if (!id || seen.has(k)) continue;
    seen.add(k);
    out.push({ raw: m[0], arxivId: id });
  }

  const fsRe = /https?:\/\/(?:www\.)?future-science\.org\/[\w\-]+\/papers\/([\w\-]+)/g;
  while ((m = fsRe.exec(text))) {
    const k = `fs:${m[1]}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ raw: m[0], fsRef: m[1] });
  }

  const ayRe = /\(([A-Z][A-Za-z\-']+(?:\s+et\s+al\.?)?)\s*,?\s*(\d{4}[a-z]?)\)/g;
  while ((m = ayRe.exec(text))) {
    const author = m[1].trim();
    const year = m[2];
    const k = `ay:${author.toLowerCase()}-${year}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ raw: m[0], authorYear: { author, year } });
  }

  return out.slice(0, 20);
}

function verifyAgainstFs(c: ExtractedCitation, fsAbstracts: FutureScienceAbstract[]): { verified: boolean; title?: string; url?: string } | null {
  if (c.fsRef) {
    const ref = c.fsRef.toLowerCase();
    const hit = fsAbstracts.find(a => a.documentId.toLowerCase() === ref);
    if (hit) return { verified: true, title: hit.title, url: `https://future-science.org/mirror/papers/${hit.documentId}` };
    const slugWords = c.fsRef.replace(/-/g, " ").toLowerCase();
    const fuzzy = fsAbstracts.find(a => a.title.toLowerCase().includes(slugWords) || slugWords.includes(a.title.toLowerCase().slice(0, 30)));
    if (fuzzy) return { verified: true, title: fuzzy.title, url: `https://future-science.org/mirror/papers/${fuzzy.documentId}` };
    return { verified: false };
  }
  if (c.authorYear) {
    const year = c.authorYear.year.replace(/[a-z]$/i, "");
    const lastName = c.authorYear.author.toLowerCase().split(/\s+et\s+al/i)[0].trim();
    const hit = fsAbstracts.find(a =>
      a.authors.toLowerCase().includes(lastName) && (a.date || "").startsWith(year)
    );
    if (hit) return { verified: true, title: hit.title, url: `https://future-science.org/mirror/papers/${hit.documentId}` };
  }
  return null;
}

async function verifyAgainstOpenAlex(c: ExtractedCitation): Promise<{ verified: boolean; title?: string; url?: string } | null> {
  try {
    let url: string | null = null;
    if (c.doi) {
      url = `${OPENALEX_BASE}/works/doi:${encodeURIComponent(c.doi)}`;
    } else if (c.arxivId) {
      url = `${OPENALEX_BASE}/works?search=${encodeURIComponent("arXiv " + c.arxivId)}&per_page=1`;
    } else if (c.authorYear) {
      const q = `${c.authorYear.author.replace(/\s+et\s+al\.?/i, "")} ${c.authorYear.year}`;
      url = `${OPENALEX_BASE}/works?search=${encodeURIComponent(q)}&per_page=1`;
    }
    if (!url) return null;

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 6000);
    const resp = await fetch(url, { headers: { "User-Agent": OPENALEX_UA }, signal: ctrl.signal });
    clearTimeout(timeout);
    if (!resp.ok) return { verified: false };
    const json: unknown = await resp.json();
    if (!json || typeof json !== "object") return { verified: false };
    const obj = json as Record<string, unknown>;
    let work: Record<string, unknown> | null = null;
    if (typeof obj.id === "string") {
      work = obj;
    } else if (Array.isArray(obj.results) && obj.results.length > 0) {
      const first = obj.results[0];
      if (first && typeof first === "object") work = first as Record<string, unknown>;
    }
    if (!work) return { verified: false };
    const title = (typeof work.title === "string" ? work.title : (typeof work.display_name === "string" ? work.display_name : undefined));
    const oaUrl = typeof work.id === "string" ? work.id : (typeof work.doi === "string" ? work.doi : undefined);
    return { verified: true, title, url: oaUrl };
  } catch {
    return null;
  }
}

async function pMapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

export async function verifyCitations(citations: ExtractedCitation[], fsAbstracts: FutureScienceAbstract[]): Promise<VerifiedCitation[]> {
  const capped = citations.slice(0, 15);
  return pMapLimit(capped, 4, async (c) => {
    const fs = verifyAgainstFs(c, fsAbstracts);
    if (fs?.verified) return { ...c, verifiedSource: "future-science" as const, verifiedTitle: fs.title, verifiedUrl: fs.url };
    const oa = await verifyAgainstOpenAlex(c);
    if (oa?.verified) return { ...c, verifiedSource: "openalex" as const, verifiedTitle: oa.title, verifiedUrl: oa.url };
    return { ...c, verifiedSource: "none" as const };
  });
}

export function formatVerificationReport(v: PaperVerification): string {
  if (!v.hadFullText) {
    return `**Citation analysis:** [AUDITOR TOOL LIMITATION] The auditor's automated full-text fetcher could not retrieve this paper's body content from Future Science. Only the abstract is available. THIS IS AN INTERNAL LIMITATION OF THE AUDITING TOOL — IT IS NOT EVIDENCE OF MISCONDUCT BY THE PAPER, ITS AUTHORS, OR THE JOURNAL. Do NOT raise any FLAG (CRITICAL, MAJOR, or MINOR) under Section A (Citation Fraud) or Section D (Plagiarism) on the basis of this limitation. Write exactly: "No automated citation analysis available — auditor tool limitation; not an ethics finding." and move on. Other categories (B/C/E/F/G/H) may still be assessed from the abstract where evidence exists.`;
  }
  if (v.citations.length === 0) {
    return `**Citation analysis:** Full text retrieved. Zero citations to external works detected. Section B must note this explicitly (the paper makes no verifiable references).`;
  }
  const verifiedFs = v.citations.filter(c => c.verifiedSource === "future-science").length;
  const verifiedOa = v.citations.filter(c => c.verifiedSource === "openalex").length;
  const unverified = v.citations.filter(c => c.verifiedSource === "none").length;
  const lines = v.citations.map((c, i) => {
    const id = c.doi ? `DOI ${c.doi}` : c.arxivId ? `arXiv:${c.arxivId}` : c.fsRef ? `Future Science slug "${c.fsRef}"` : c.authorYear ? `(${c.authorYear.author}, ${c.authorYear.year})` : c.raw;
    if (c.verifiedSource === "future-science") return `  ${i + 1}. ${id} — VERIFIED in Future Science: "${c.verifiedTitle ?? "(title unavailable)"}"`;
    if (c.verifiedSource === "openalex") return `  ${i + 1}. ${id} — VERIFIED in OpenAlex: "${c.verifiedTitle ?? "(title unavailable)"}"${c.verifiedUrl ? ` <${c.verifiedUrl}>` : ""}`;
    return `  ${i + 1}. ${id} — UNVERIFIED (not found in Future Science or OpenAlex; treat as potentially hallucinated, mis-cited, or non-indexed)`;
  });
  return `**Citation analysis:** Full text retrieved. ${v.citations.length} citation(s) detected (showing up to 15). Verified ${verifiedFs} via Future Science, ${verifiedOa} via OpenAlex; ${unverified} unverified.\n${lines.join("\n")}`;
}
