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
  // The bibliography line / surrounding text the citation appeared in. This is the
  // text the paper claims the citation is for (title + authors as the paper presents them).
  context?: string;
}

export interface VerifiedCitation extends ExtractedCitation {
  verifiedSource: "future-science" | "openalex" | "arxiv" | "none";
  verifiedTitle?: string;
  verifiedUrl?: string;
  // True when the verified work's title meaningfully overlaps with the bibliography line
  // the paper presents. False = the URL/ID resolves to a DIFFERENT work than what the
  // paper claims it points to (citation mismatch / mis-citation / possible fraud).
  titleMatchesClaim?: boolean;
  matchNote?: string;
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

async function fetchTextWithTimeout(url: string, timeoutMs = 8000): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(url, {
      headers: { "User-Agent": "MachineInstitute-EthicsAuditor", "Accept": "text/html,text/plain,text/markdown,application/json,*/*" },
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

// Find a submittedFiles.file.url-shaped Strapi upload path inside an arbitrary JSON tree.
function deepFindFileUrl(node: unknown, depth = 0): string | null {
  if (depth > 8 || node == null) return null;
  if (Array.isArray(node)) {
    for (const v of node) { const r = deepFindFileUrl(v, depth + 1); if (r) return r; }
    return null;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    // Strapi shape: submittedFiles.file.url -> "/strapi/uploads/foo.md"
    if (typeof obj.url === "string" && /\.(md|markdown|txt|html?)$/i.test(obj.url)) {
      return obj.url;
    }
    for (const k of Object.keys(obj)) {
      const r = deepFindFileUrl(obj[k], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

export async function fetchFsPaperContent(documentId: string, slug: string = "mirror"): Promise<string | null> {
  if (!documentId) return null;
  // 1) Try the JSON API first to discover the actual uploaded paper file. The /papers/<id>
  // page only returns an SPA shell + the abstract, NOT the bibliography. The uploaded
  // markdown/HTML in submittedFiles.file.url is the real paper body.
  const jsonCandidates = [
    `${FS_API_BASE}/public/contributions/${encodeURIComponent(documentId)}`,
    `${FS_API_BASE}/contributions/${encodeURIComponent(documentId)}`,
  ];
  for (const url of jsonCandidates) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(url, {
        headers: { "User-Agent": "MachineInstitute-EthicsAuditor", "Accept": "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) continue;
      const json: unknown = await resp.json();
      const filePath = deepFindFileUrl(json);
      if (filePath) {
        const fileUrl = filePath.startsWith("http") ? filePath : `https://future-science.org${filePath}`;
        const body = await fetchTextWithTimeout(fileUrl, 10000);
        if (body && body.length >= 200) {
          return body.includes("<") && /\<(p|div|h\d|body)\b/i.test(body) ? stripHtml(body) : body;
        }
      }
      // Fall back to abstract-or-similar long string from the JSON if no file is attached.
      const found = deepFindLongString(json, 800);
      if (found) return found.includes("<") ? stripHtml(found) : found;
    } catch {
      // try next
    }
  }
  // 2) Last resort: fetch the public HTML page (SPA shell — bibliography may be absent).
  try {
    const html = await fetchTextWithTimeout(`https://future-science.org/${slug}/${encodeURIComponent(documentId)}`, 8000);
    if (html && html.length >= 200) {
      const stripped = stripHtml(html);
      if (stripped.length >= 800) return stripped;
    }
  } catch {
    // ignore
  }
  return null;
}

// Pull ~240 chars of surrounding text — typically captures the entire bibliography line.
function contextAround(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - 160);
  const end = Math.min(text.length, idx + len + 160);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
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
    out.push({ raw: m[0], doi, context: contextAround(text, m.index, m[0].length) });
  }

  const arxivRe = /arxiv\.org\/abs\/(\d{4}\.\d{4,5})|arXiv:\s*(\d{4}\.\d{4,5})/gi;
  while ((m = arxivRe.exec(text))) {
    const id = m[1] || m[2];
    const k = `arxiv:${id}`;
    if (!id || seen.has(k)) continue;
    seen.add(k);
    out.push({ raw: m[0], arxivId: id, context: contextAround(text, m.index, m[0].length) });
  }

  const fsRe = /https?:\/\/(?:www\.)?future-science\.org\/[\w\-]+\/papers\/([\w\-]+)/g;
  while ((m = fsRe.exec(text))) {
    const k = `fs:${m[1]}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ raw: m[0], fsRef: m[1], context: contextAround(text, m.index, m[0].length) });
  }

  const ayRe = /\(([A-Z][A-Za-z\-']+(?:\s+et\s+al\.?)?)\s*,?\s*(\d{4}[a-z]?)\)/g;
  while ((m = ayRe.exec(text))) {
    const author = m[1].trim();
    const year = m[2];
    const k = `ay:${author.toLowerCase()}-${year}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ raw: m[0], authorYear: { author, year }, context: contextAround(text, m.index, m[0].length) });
  }

  return out.slice(0, 100);
}

// Token-based comparison between the verified work's title and the bibliography line
// the paper presents. Returns { ok: true } when they share enough significant tokens.
const TITLE_STOPWORDS = new Set([
  "the","a","an","of","in","on","for","and","to","with","by","is","at","as","or","are",
  "be","via","from","using","based","towards","toward","into","over","under","study",
  "studies","paper","papers","preprint","arxiv","abs","https","http","www","org","com",
  "et","al","vol","no","pp","pages","abstract","note","notes","conference","proceedings",
  "research","review","reviews","analysis","approach","approaches","method","methods",
]);
function titleTokens(s: string): Set<string> {
  const tokens = s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (const t of tokens) if (t.length >= 4 && !TITLE_STOPWORDS.has(t) && !/^\d+$/.test(t)) out.add(t);
  return out;
}
function titleMatches(claim: string | undefined, verifiedTitle: string | undefined): { ok: boolean; note?: string } {
  if (!verifiedTitle) return { ok: false, note: "verified work has no title to compare" };
  if (!claim) return { ok: false, note: "no claim text captured" };
  const a = titleTokens(claim);
  const b = titleTokens(verifiedTitle);
  if (a.size === 0 || b.size === 0) return { ok: false, note: "insufficient title tokens" };
  let shared = 0;
  Array.from(b).forEach(t => { if (a.has(t)) shared++; });
  const jaccard = shared / (a.size + b.size - shared || 1);
  // Pass when at least 2 significant tokens overlap OR jaccard above 0.18.
  if (shared >= 2 || jaccard >= 0.18) return { ok: true };
  return { ok: false, note: `verified title "${verifiedTitle}" does not overlap with claimed bibliography line` };
}

function verifyAgainstFs(c: ExtractedCitation, fsAbstracts: FutureScienceAbstract[]): { verified: boolean; title?: string; url?: string } | null {
  if (c.fsRef) {
    const ref = c.fsRef.toLowerCase();
    const hit = fsAbstracts.find(a => a.documentId.toLowerCase() === ref);
    if (hit) return { verified: true, title: hit.title, url: `https://future-science.org/mirror/${hit.documentId}` };
    const slugWords = c.fsRef.replace(/-/g, " ").toLowerCase();
    const fuzzy = fsAbstracts.find(a => a.title.toLowerCase().includes(slugWords) || slugWords.includes(a.title.toLowerCase().slice(0, 30)));
    if (fuzzy) return { verified: true, title: fuzzy.title, url: `https://future-science.org/mirror/${fuzzy.documentId}` };
    return { verified: false };
  }
  if (c.authorYear) {
    const year = c.authorYear.year.replace(/[a-z]$/i, "");
    const lastName = c.authorYear.author.toLowerCase().split(/\s+et\s+al/i)[0].trim();
    const hit = fsAbstracts.find(a =>
      a.authors.toLowerCase().includes(lastName) && (a.date || "").startsWith(year)
    );
    if (hit) return { verified: true, title: hit.title, url: `https://future-science.org/mirror/${hit.documentId}` };
  }
  return null;
}

// Fetch the canonical arXiv abstract page and parse the real paper title from the
// citation_title meta tag. This is far more reliable than OpenAlex free-text
// search by arXiv ID, which often returns an unrelated paper.
async function verifyAgainstArxiv(arxivId: string): Promise<{ verified: boolean; title?: string; url?: string } | null> {
  try {
    const url = `https://arxiv.org/abs/${encodeURIComponent(arxivId)}`;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 7000);
    const resp = await fetch(url, {
      headers: { "User-Agent": "MachineInstitute-EthicsAuditor", "Accept": "text/html" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);
    if (!resp.ok) return { verified: false };
    const html = await resp.text();
    // Prefer the citation_title meta (clean, no "[ID]" prefix). Fallback to <title>.
    const metaM = html.match(/<meta\s+name=["']citation_title["']\s+content=["']([^"']+)["']/i);
    let title: string | undefined = metaM?.[1];
    if (!title) {
      const titleM = html.match(/<title>\s*(?:\[[^\]]+\]\s*)?([^<]+?)\s*<\/title>/i);
      title = titleM?.[1];
    }
    if (!title || title.length < 4) return { verified: false };
    return { verified: true, title: title.trim(), url };
  } catch {
    return null;
  }
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

// =====================================================================
// Semantic gloss verification (Section G — Scope Misrepresentation)
// =====================================================================
// For each verified arXiv / OpenAlex citation, pair the surrounding "claim
// verb" sentence in the paper ("X showed that...", "Y demonstrated that...")
// with the abstract of the cited work, so the LLM has a structured input for
// detecting scope misrepresentation rather than relying on its own intuition.

export interface SemanticGlossPair {
  citationLabel: string;
  verifiedSource: VerifiedCitation["verifiedSource"];
  verifiedTitle?: string;
  verifiedUrl?: string;
  paperGloss: string;
  citedAbstract: string;
  abstractSource: "arxiv" | "openalex";
}

// Claim verbs commonly used to introduce attributed claims about prior work.
// Matched as whole words; the immediate-context gloss extractor uses this to
// pick the sentence in which the paper restates what the cited work "showed".
const CLAIM_VERB_RE = /\b(?:show(?:ed|s|n)?|demonstrat(?:e|ed|es)|prov(?:e|ed|es|en)?|argu(?:e|ed|es)|find(?:s|ings?)?|found|report(?:ed|s)?|establish(?:ed|es)?|conclud(?:e|ed|es)?|reveal(?:ed|s)?|claim(?:ed|s)?|observ(?:e|ed|es))\b/i;

function extractClaimGloss(context: string): string | null {
  if (!context) return null;
  const sentences = context.split(/(?<=[.!?])\s+/);
  // Prefer the longest sentence containing a claim verb (the gloss is usually the
  // sentence where the citation appears, which tends to be the most informative).
  let best: string | null = null;
  for (const raw of sentences) {
    const s = raw.trim();
    if (s.length < 20) continue;
    if (!CLAIM_VERB_RE.test(s)) continue;
    if (!best || s.length > best.length) best = s;
  }
  return best ? best.slice(0, 500) : null;
}

async function fetchArxivAbstract(arxivId: string): Promise<string | null> {
  try {
    const url = `https://arxiv.org/abs/${encodeURIComponent(arxivId)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const resp = await fetch(url, {
      headers: { "User-Agent": "MachineInstitute-EthicsAuditor", "Accept": "text/html" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(t);
    if (!resp.ok) return null;
    const html = await resp.text();
    const metaM = html.match(/<meta\s+name=["']citation_abstract["']\s+content=["']([\s\S]*?)["']\s*\/?>/i);
    if (metaM?.[1]) {
      const cleaned = stripHtml(metaM[1]).trim();
      if (cleaned.length >= 30) return cleaned.slice(0, 2500);
    }
    const blockM = html.match(/<blockquote\s+class=["']abstract[^"']*["'][^>]*>([\s\S]*?)<\/blockquote>/i);
    if (blockM?.[1]) {
      const cleaned = stripHtml(blockM[1]).replace(/^abstract:?\s*/i, "").trim();
      if (cleaned.length >= 30) return cleaned.slice(0, 2500);
    }
    return null;
  } catch {
    return null;
  }
}

function reconstructFromInvertedIndex(inv: unknown): string | null {
  if (!inv || typeof inv !== "object") return null;
  const entries = Object.entries(inv as Record<string, unknown>);
  if (entries.length === 0) return null;
  let max = -1;
  for (const [, positions] of entries) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) {
      if (typeof p === "number" && p > max) max = p;
    }
  }
  if (max < 0) return null;
  const arr: string[] = new Array(max + 1).fill("");
  for (const [word, positions] of entries) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) {
      if (typeof p === "number" && p >= 0 && p <= max) arr[p] = word;
    }
  }
  const abstract = arr.filter(Boolean).join(" ").trim();
  return abstract.length >= 30 ? abstract.slice(0, 2500) : null;
}

async function fetchOpenAlexAbstract(workIdOrUrl: string): Promise<string | null> {
  try {
    let url: string;
    if (workIdOrUrl.startsWith("http")) {
      url = workIdOrUrl;
    } else if (workIdOrUrl.startsWith("doi:")) {
      url = `${OPENALEX_BASE}/works/${encodeURIComponent(workIdOrUrl)}`;
    } else {
      url = `${OPENALEX_BASE}/works/${encodeURIComponent(workIdOrUrl)}`;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const resp = await fetch(url, { headers: { "User-Agent": OPENALEX_UA }, signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return null;
    const json: unknown = await resp.json();
    if (!json || typeof json !== "object") return null;
    const obj = json as Record<string, unknown>;
    return reconstructFromInvertedIndex(obj.abstract_inverted_index);
  } catch {
    return null;
  }
}

export async function buildSemanticGlossPairs(verified: VerifiedCitation[]): Promise<SemanticGlossPair[]> {
  const candidates = verified.filter(c =>
    (c.verifiedSource === "arxiv" || c.verifiedSource === "openalex") &&
    !!c.context &&
    c.titleMatchesClaim !== false, // skip already-flagged title mismatches
  );
  // Cap at 20 to bound network cost; pair extraction is best-effort.
  const capped = candidates.slice(0, 20);
  const results = await pMapLimit(capped, 3, async (c): Promise<SemanticGlossPair | null> => {
    const gloss = extractClaimGloss(c.context!);
    if (!gloss) return null;
    let citedAbstract: string | null = null;
    let abstractSource: "arxiv" | "openalex" | undefined;
    if (c.arxivId) {
      citedAbstract = await fetchArxivAbstract(c.arxivId);
      if (citedAbstract) abstractSource = "arxiv";
    }
    if (!citedAbstract && c.verifiedUrl && c.verifiedUrl.includes("openalex.org")) {
      citedAbstract = await fetchOpenAlexAbstract(c.verifiedUrl);
      if (citedAbstract) abstractSource = "openalex";
    }
    if (!citedAbstract && c.doi) {
      citedAbstract = await fetchOpenAlexAbstract(`doi:${c.doi}`);
      if (citedAbstract) abstractSource = "openalex";
    }
    if (!citedAbstract || !abstractSource) return null;
    const label = c.doi ? `DOI ${c.doi}` :
      c.arxivId ? `arXiv:${c.arxivId}` :
      c.fsRef ? `FS:${c.fsRef}` :
      c.authorYear ? `(${c.authorYear.author}, ${c.authorYear.year})` :
      c.raw;
    return {
      citationLabel: label,
      verifiedSource: c.verifiedSource,
      verifiedTitle: c.verifiedTitle,
      verifiedUrl: c.verifiedUrl,
      paperGloss: gloss,
      citedAbstract,
      abstractSource,
    };
  });
  return results.filter((r): r is SemanticGlossPair => r !== null);
}

export function formatSemanticGlossReport(pairs: SemanticGlossPair[]): string {
  if (pairs.length === 0) {
    return `**Semantic gloss check:** No claim-verb glosses (e.g. "X showed that…", "Y demonstrated that…") were detected in the immediate context of any verified arXiv/OpenAlex citation, OR none of those citations had a fetchable abstract. Cross-checking skipped — auditor tool limitation, not an ethics finding.`;
  }
  const lines = pairs.map((p, i) => {
    const verifiedLine = p.verifiedTitle
      ? `Cited work: "${p.verifiedTitle}"${p.verifiedUrl ? ` <${p.verifiedUrl}>` : ""}`
      : `Cited work: (verified via ${p.verifiedSource}, title unavailable)`;
    const abs = p.citedAbstract.slice(0, 700);
    return `  ${i + 1}. ${p.citationLabel} — ${verifiedLine}\n     Paper's gloss: "${p.paperGloss}"\n     Cited abstract (${p.abstractSource}): "${abs}${p.citedAbstract.length > 700 ? "…" : ""}"`;
  });
  return `**Semantic gloss check:** ${pairs.length} verified citation(s) with a claim-verb gloss in the paper were paired with the cited work's abstract. For each pair, judge whether the paper's gloss faithfully represents what the cited abstract actually says.

Severity rules (binding):
- **Preserved-meaning compressions** (the gloss is a fair paraphrase / summary of the abstract) — NO flag.
- **Ambiguous** (gloss is vague or only partially supported by the abstract) — INFO note only, NO flag.
- **Substantive mismatch** (gloss attributes a claim to the cited work that the abstract does NOT support, or contradicts the abstract's actual finding) — eligible for **MINOR** under Section G (Scope Misrepresentation). Quote both the gloss and the contradicting abstract sentence in the Trace.
- **Promotion above MINOR is FORBIDDEN unless a SECOND independent source confirms the misrepresentation** (per the H-agent severity ladder). A single-abstract disagreement is MINOR at most.

${lines.join("\n")}`;
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
  const capped = citations.slice(0, 100);
  return pMapLimit(capped, 4, async (c) => {
    const fs = verifyAgainstFs(c, fsAbstracts);
    if (fs?.verified) {
      const match = titleMatches(c.context, fs.title);
      // FS is journal-internal authoritative — single source is fine here, but only
      // emit titleMatchesClaim=false when we are confident the resolution is real.
      return { ...c, verifiedSource: "future-science" as const, verifiedTitle: fs.title, verifiedUrl: fs.url, titleMatchesClaim: match.ok ? true : false, matchNote: match.note };
    }
    // Two-source verification for arXiv citations. arXiv is authoritative for the
    // paper title at a given arXiv ID; OpenAlex is a noisy secondary corroborator.
    // Title-mismatch may only be raised when BOTH sources independently agree on a
    // title that contradicts the bibliography line the paper presents (per the
    // 2026-05 patch addressing the false-positive Cho et al. (arXiv:2410.04468)
    // case where a single bad OpenAlex hit drove a MAJOR fraud flag). When only
    // arXiv resolves, or arXiv and OpenAlex disagree with each other, we trust
    // arXiv and SUPPRESS the mismatch flag (titleMatchesClaim=true).
    if (c.arxivId) {
      const [ax, oa] = await Promise.all([
        verifyAgainstArxiv(c.arxivId),
        verifyAgainstOpenAlex(c),
      ]);
      const axOk = !!(ax?.verified && ax.title);
      const oaOk = !!(oa?.verified && oa.title);
      if (axOk) {
        const matchAx = titleMatches(c.context, ax!.title);
        let titleMatchesClaim: boolean = true;
        let matchNote: string | undefined = matchAx.ok ? undefined : matchAx.note;
        if (!matchAx.ok) {
          if (oaOk) {
            const matchOa = titleMatches(c.context, oa!.title);
            const sourcesAgree = titleMatches(ax!.title, oa!.title).ok;
            if (sourcesAgree && !matchOa.ok) {
              // Two independent sources agree on a title that contradicts the
              // bibliography line — this is the only path that emits a mismatch.
              titleMatchesClaim = false;
              matchNote = `Two-source agreement: arXiv "${ax!.title}" and OpenAlex "${oa!.title}" both disagree with the bibliography line — flag as mis-citation.`;
            } else {
              titleMatchesClaim = true;
              matchNote = `arXiv resolved to "${ax!.title}". OpenAlex returned ${matchOa.ok ? `a different result that does match the bibliography line` : `the unrelated work "${oa!.title}"`}; sources do not agree, so per the two-source rule no mismatch is flagged. Treating arXiv as authoritative.`;
            }
          } else {
            titleMatchesClaim = true;
            matchNote = `arXiv resolved to "${ax!.title}" which differs from the bibliography line, but OpenAlex did not resolve. Single-source disagreement is insufficient evidence — not flagging.`;
          }
        }
        return { ...c, verifiedSource: "arxiv" as const, verifiedTitle: ax!.title, verifiedUrl: ax!.url, titleMatchesClaim, matchNote };
      }
      if (oaOk) {
        // OpenAlex-only resolution for an arXiv citation — UNVERIFIED per the brief
        // (single-source, and OpenAlex is the unreliable one for arXiv lookups).
        return { ...c, verifiedSource: "openalex" as const, verifiedTitle: oa!.title, verifiedUrl: oa!.url, titleMatchesClaim: true, matchNote: `OpenAlex-only resolution for arXiv ID ${c.arxivId}; arXiv abstract page did not resolve. Single-source — treat as UNVERIFIED, do NOT flag as mismatch.` };
      }
    }
    const oa = await verifyAgainstOpenAlex(c);
    if (oa?.verified) {
      const match = titleMatches(c.context, oa.title);
      // Single-source OpenAlex resolution (no arXiv ID, no FS hit). Per the brief,
      // single-source disagreement is UNVERIFIED, not fraud. Suppress mismatch flag.
      return { ...c, verifiedSource: "openalex" as const, verifiedTitle: oa.title, verifiedUrl: oa.url, titleMatchesClaim: true, matchNote: match.ok ? undefined : `OpenAlex-only resolution: "${oa.title}" differs from bibliography line, but no second source available. Single-source — not flagging as mismatch.` };
    }
    return { ...c, verifiedSource: "none" as const };
  });
}

// In-text vs bibliography cross-check (Section A pre-flight). Splits the paper
// at a bibliography heading, parses (Author, Year) patterns from the body, and
// parses bibliography entries separately. Reports in-text citations missing
// from the bibliography (Brown et al. 2020 case from the failure-case patch).
export interface BibliographyAnalysis {
  bibliographyDetected: boolean;
  inTextCount: number;
  bibliographyCount: number;
  inTextOnly: { authorYear: string; quote: string }[];
  bibliographyOnly: string[];
}

const BIB_HEADING_RE = /\n\s*(?:#+\s*)?(?:references|bibliography|works\s+cited)\s*\n/i;

function parseInTextAuthorYear(body: string): { author: string; year: string; quote: string }[] {
  const out: { author: string; year: string; quote: string }[] = [];
  // Matches (Author, 2024), (Author et al., 2024), (Author and Other, 2024), Author (2024), Author et al. (2024)
  const patterns = [
    /\(([A-Z][A-Za-z\-']+(?:\s+(?:et\s+al\.?|and\s+[A-Z][A-Za-z\-']+))?)\s*,?\s*(\d{4}[a-z]?)\)/g,
    /\b([A-Z][A-Za-z\-']+(?:\s+et\s+al\.?)?)\s*\((\d{4}[a-z]?)\)/g,
  ];
  const seen = new Set<string>();
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const author = m[1].trim().replace(/\s+/g, " ");
      const year = m[2];
      const key = `${author.toLowerCase().split(/\s+et\s+al/i)[0].trim()}|${year.replace(/[a-z]$/i, "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const quote = body.slice(Math.max(0, m.index - 60), Math.min(body.length, m.index + m[0].length + 60)).replace(/\s+/g, " ").trim();
      out.push({ author, year, quote });
    }
  }
  return out;
}

function parseBibliographyEntries(bib: string): { authorLast: string; year: string; raw: string }[] {
  const out: { authorLast: string; year: string; raw: string }[] = [];
  // Split on blank lines, numbered/bracketed entries, or hanging indents.
  const lines = bib.split(/\n(?=\s*(?:\[\d+\]|\d+\.\s|[A-Z][A-Za-z\-']+,))/);
  for (const raw of lines) {
    const cleaned = raw.replace(/\s+/g, " ").trim();
    if (cleaned.length < 12) continue;
    // Author surname: first capitalised word (before comma) OR first word of a "Last, F." pattern.
    const lastM = cleaned.match(/^(?:\[\d+\]\s*|\d+\.\s*)?([A-Z][A-Za-z\-']+)/);
    const yearM = cleaned.match(/\b(19|20)\d{2}[a-z]?\b/);
    if (!lastM || !yearM) continue;
    out.push({ authorLast: lastM[1].toLowerCase(), year: yearM[0], raw: cleaned.slice(0, 240) });
  }
  return out;
}

export function analyzeInTextVsBibliography(fullText: string): BibliographyAnalysis {
  if (!fullText || fullText.length < 200) {
    return { bibliographyDetected: false, inTextCount: 0, bibliographyCount: 0, inTextOnly: [], bibliographyOnly: [] };
  }
  const headingM = fullText.search(BIB_HEADING_RE);
  if (headingM < 0) {
    // No bibliography heading detected — can't do the cross-check reliably.
    const inText = parseInTextAuthorYear(fullText);
    return { bibliographyDetected: false, inTextCount: inText.length, bibliographyCount: 0, inTextOnly: [], bibliographyOnly: [] };
  }
  const body = fullText.slice(0, headingM);
  const bib = fullText.slice(headingM);
  const inText = parseInTextAuthorYear(body);
  const bibEntries = parseBibliographyEntries(bib);

  const bibKeys = new Set(bibEntries.map(b => `${b.authorLast}|${b.year.replace(/[a-z]$/i, "")}`));
  const inTextKeys = new Set(inText.map(it => `${it.author.toLowerCase().split(/\s+et\s+al/i)[0].trim()}|${it.year.replace(/[a-z]$/i, "")}`));

  const inTextOnly = inText
    .filter(it => {
      const key = `${it.author.toLowerCase().split(/\s+et\s+al/i)[0].trim()}|${it.year.replace(/[a-z]$/i, "")}`;
      return !bibKeys.has(key);
    })
    .slice(0, 30)
    .map(it => ({ authorYear: `${it.author} (${it.year})`, quote: it.quote }));

  const bibliographyOnly = bibEntries
    .filter(b => !inTextKeys.has(`${b.authorLast}|${b.year.replace(/[a-z]$/i, "")}`))
    .slice(0, 30)
    .map(b => b.raw);

  return {
    bibliographyDetected: true,
    inTextCount: inText.length,
    bibliographyCount: bibEntries.length,
    inTextOnly,
    bibliographyOnly,
  };
}

export function formatBibliographyAnalysis(a: BibliographyAnalysis): string {
  if (!a.bibliographyDetected) {
    return `**In-text vs bibliography cross-check:** No bibliography section heading was detected in the full text — cross-check skipped (auditor tool limitation, not an ethics finding).`;
  }
  const parts: string[] = [];
  parts.push(`**In-text vs bibliography cross-check:** ${a.inTextCount} unique in-text (Author, Year) reference(s) detected; ${a.bibliographyCount} bibliography entry/entries parsed.`);
  if (a.inTextOnly.length > 0) {
    parts.push(`*** ${a.inTextOnly.length} in-text citation(s) appear to have NO matching bibliography entry — flag each as MINOR under Section A (missing bibliography entry). Quote the offending in-text string. ***`);
    for (let i = 0; i < a.inTextOnly.length; i++) {
      const it = a.inTextOnly[i];
      parts.push(`  ${i + 1}. ${it.authorYear} — context: "${it.quote.slice(0, 200)}${it.quote.length > 200 ? "…" : ""}"`);
    }
  } else {
    parts.push(`No in-text citations missing from bibliography.`);
  }
  if (a.bibliographyOnly.length > 0) {
    parts.push(`${a.bibliographyOnly.length} bibliography entry/entries appear never cited in-text (INFO note, not a flag):`);
    for (let i = 0; i < Math.min(a.bibliographyOnly.length, 10); i++) {
      parts.push(`  - ${a.bibliographyOnly[i]}`);
    }
  }
  return parts.join("\n");
}

export interface VerifiedUrl {
  url: string;
  reachable: boolean | null;
  status?: number;
  note?: string;
  arxivIdMatch?: boolean;
  // 2026-05 patch: classify 403/401 responses so the LLM can distinguish a real
  // broken link (S3 AccessDenied, CDN takedown) from a bot-block (Cloudflare/CAPTCHA)
  // that should NOT be flagged.
  classification?: "ok" | "broken" | "bot-blocked" | "rate-limited" | "server-error" | "unknown";
  bodySnippet?: string;
  waybackTried?: boolean;
  waybackOk?: boolean;
}

export function extractUrls(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const urlRe = /https?:\/\/[^\s)<>"'\]]+/g;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text))) {
    const cleaned = m[0].replace(/[.,;:!?)\]]+$/, "");
    if (cleaned.length < 8) continue;
    out.add(cleaned);
  }
  return Array.from(out).slice(0, 150);
}

// SSRF guard: reject hostnames that resolve to private/loopback/link-local/internal address space,
// non-http(s) schemes, and credential-bearing URLs. Paper text is externally sourced and may be
// adversarial, so we never let it cause the server to probe its own network.
function isUrlSafeForVerification(rawUrl: string): { ok: true } | { ok: false; reason: string } {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return { ok: false, reason: "invalid URL" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "non-http scheme" };
  if (u.username || u.password) return { ok: false, reason: "credentials in URL" };
  const host = u.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "empty host" };
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal") {
    return { ok: false, reason: "internal hostname" };
  }
  // Block bracketed IPv6 and bare IP literals — only allow DNS hostnames for verification.
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    return { ok: false, reason: "IP literal blocked" };
  }
  return { ok: true };
}

// Sniff a response body to distinguish real broken links (S3 AccessDenied, CDN
// object-not-found, publisher takedown) from bot-blocks (Cloudflare challenge,
// CAPTCHA, "automated request" interstitials). Returns "broken" only when the
// body affirmatively says the resource is gone, denied, or never existed.
export function classifyBody(body: string): { kind: "broken" | "bot-blocked" | "unknown"; reason: string; snippet: string } {
  const snippet = body.slice(0, 600).replace(/\s+/g, " ").trim();
  const low = body.toLowerCase();
  if (/<code>\s*accessdenied\s*<\/code>/i.test(body) || /<code>\s*nosuchkey\s*<\/code>/i.test(body) || /<code>\s*nosuchbucket\s*<\/code>/i.test(body)) {
    return { kind: "broken", reason: "host returned an explicit access-denied / no-such-key XML payload (S3 / CDN object-not-found or takedown)", snippet };
  }
  if (/page not found|object not found|content has been (?:removed|deleted|withdrawn)|takedown notice|dmca/i.test(low)) {
    return { kind: "broken", reason: "host body explicitly says the resource is gone / removed / taken down", snippet };
  }
  if (/cloudflare|cf-ray|attention required|just a moment|checking your browser|enable javascript and cookies|captcha|hcaptcha|recaptcha|access denied.*bot|automated (?:request|traffic)/i.test(low)) {
    return { kind: "bot-blocked", reason: "body looks like a bot-challenge / CAPTCHA / browser-verification interstitial — not evidence the URL is broken", snippet };
  }
  return { kind: "unknown", reason: "non-2xx response with uninformative body — cannot conclusively classify", snippet };
}

async function fetchBody(url: string, timeoutMs: number, ua: string): Promise<{ status: number; body: string } | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": ua, "Accept": "text/html,application/xhtml+xml,application/xml,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(t);
    const body = await resp.text().catch(() => "");
    return { status: resp.status, body };
  } catch {
    return null;
  }
}

async function checkWayback(url: string, timeoutMs = 6000): Promise<{ ok: boolean; snapshotUrl?: string }> {
  try {
    const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(api, { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return { ok: false };
    const j: any = await resp.json().catch(() => null);
    const snap = j?.archived_snapshots?.closest;
    if (snap?.available && snap.status === "200") return { ok: true, snapshotUrl: snap.url };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

async function checkUrlReachable(url: string, timeoutMs = 7000): Promise<{ reachable: boolean | null; status?: number; note?: string; classification?: VerifiedUrl["classification"]; bodySnippet?: string; waybackTried?: boolean; waybackOk?: boolean }> {
  const guard = isUrlSafeForVerification(url);
  if (!guard.ok) return { reachable: null, note: `skipped (${guard.reason})`, classification: "unknown" };

  const defaultUa = "MachineInstitute-EthicsAuditor";
  let firstStatus: number | undefined;
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const resp = await fetch(url, { method, headers: { "User-Agent": defaultUa, "Accept": "*/*" }, signal: ctrl.signal, redirect: "follow" });
      clearTimeout(t);
      if (resp.status === 405 && method === "HEAD") continue;
      firstStatus = resp.status;
      if (resp.ok) return { reachable: true, status: resp.status, classification: "ok" };
      break;
    } catch { /* try next */ }
  }

  if (firstStatus === undefined) {
    return { reachable: null, classification: "unknown", note: "network error / timeout — could not establish a connection" };
  }
  if (firstStatus === 404 || firstStatus === 410) {
    return { reachable: false, status: firstStatus, classification: "broken", note: `HTTP ${firstStatus} — resource not found` };
  }
  if (firstStatus === 429) {
    return { reachable: null, status: 429, classification: "rate-limited", note: "HTTP 429 — rate-limited; not flagging on first failure" };
  }
  if (firstStatus >= 500 && firstStatus < 600) {
    return { reachable: null, status: firstStatus, classification: "server-error", note: `HTTP ${firstStatus} — server error; transient, INFO only` };
  }
  if (firstStatus === 401 || firstStatus === 403) {
    const browserUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    const body = await fetchBody(url, timeoutMs, browserUa);
    if (!body) {
      return { reachable: null, status: firstStatus, classification: "unknown", note: `HTTP ${firstStatus} — body unfetchable; cannot classify` };
    }
    const cls = classifyBody(body.body);
    if (cls.kind === "broken") {
      return { reachable: false, status: firstStatus, classification: "broken", note: `HTTP ${firstStatus} — ${cls.reason}`, bodySnippet: cls.snippet };
    }
    if (cls.kind === "bot-blocked") {
      return { reachable: null, status: firstStatus, classification: "bot-blocked", note: `HTTP ${firstStatus} — ${cls.reason}; INFO only, do NOT flag`, bodySnippet: cls.snippet };
    }
    const wb = await checkWayback(url);
    if (wb.ok) {
      return { reachable: null, status: firstStatus, classification: "bot-blocked", note: `HTTP ${firstStatus} with uninformative body, but Wayback Machine has a 200 snapshot — likely bot-blocked, not broken; INFO only`, bodySnippet: cls.snippet, waybackTried: true, waybackOk: true };
    }
    return { reachable: false, status: firstStatus, classification: "broken", note: `HTTP ${firstStatus} with uninformative body and no Wayback snapshot — treating as broken`, bodySnippet: cls.snippet, waybackTried: true, waybackOk: false };
  }
  return { reachable: false, status: firstStatus, classification: "unknown", note: `HTTP ${firstStatus}` };
}

export async function verifyUrls(urls: string[]): Promise<VerifiedUrl[]> {
  const capped = urls.slice(0, 100);
  return pMapLimit(capped, 5, async (url): Promise<VerifiedUrl> => {
    const r = await checkUrlReachable(url);
    let arxivIdMatch: boolean | undefined;
    let note = r.note;
    const arxivM = url.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5})/i);
    if (arxivM && r.reachable === false) {
      arxivIdMatch = false;
      note = note || "arXiv ID does not resolve";
    }
    return { url, reachable: r.reachable, status: r.status, note, arxivIdMatch, classification: r.classification, bodySnippet: r.bodySnippet, waybackTried: r.waybackTried, waybackOk: r.waybackOk };
  });
}

export function formatUrlVerificationReport(verified: VerifiedUrl[]): string {
  if (verified.length === 0) {
    return `**Link analysis:** No external URLs were detected in the paper's full text.`;
  }
  const ok = verified.filter(v => v.classification === "ok").length;
  const broken = verified.filter(v => v.classification === "broken").length;
  const botBlocked = verified.filter(v => v.classification === "bot-blocked").length;
  const transient = verified.filter(v => v.classification === "rate-limited" || v.classification === "server-error").length;
  const unknown = verified.filter(v => !v.classification || v.classification === "unknown").length;
  const lines = verified.map((v, i) => {
    const wbTag = v.waybackTried ? ` (Wayback ${v.waybackOk ? "snapshot=200" : "no snapshot"})` : "";
    const snippetTag = v.bodySnippet ? ` | body: "${v.bodySnippet.slice(0, 200)}${v.bodySnippet.length > 200 ? "…" : ""}"` : " | body: no body";
    let tag: string;
    switch (v.classification) {
      case "ok": tag = `OK (HTTP ${v.status})`; break;
      case "broken": tag = `BROKEN (HTTP ${v.status ?? "?"}) — ${v.note ?? ""}${wbTag}${snippetTag}`; break;
      case "bot-blocked": tag = `BOT-BLOCKED (HTTP ${v.status ?? "?"}) — ${v.note ?? ""}${wbTag}${snippetTag} *** DO NOT FLAG — auditor was challenged, not the link ***`; break;
      case "rate-limited": tag = `RATE-LIMITED (HTTP 429) — ${v.note ?? ""} *** DO NOT FLAG on first failure ***`; break;
      case "server-error": tag = `SERVER-ERROR (HTTP ${v.status ?? "?"}) — ${v.note ?? ""} *** transient, INFO only ***`; break;
      default: tag = `UNVERIFIABLE${v.note ? ` — ${v.note}` : " (network/timeout)"}`;
    }
    return `  ${i + 1}. ${v.url} — ${tag}`;
  });
  return `**Link analysis:** ${verified.length} URL(s) detected. ${ok} reachable, ${broken} broken (host says gone / denied), ${botBlocked} bot-blocked (auditor was challenged — DO NOT flag), ${transient} transient (rate-limited / 5xx — INFO only), ${unknown} unverifiable. Every BROKEN entry below includes the body snippet that drove the verdict and whether the Wayback Machine was tried as a fallback. (URLs targeting internal/private networks are intentionally skipped for safety; treat skipped entries as auditor tool limitations, NOT ethics findings.)\n${lines.join("\n")}`;
}

export function formatVerificationReport(v: PaperVerification): string {
  if (!v.hadFullText) {
    return `**Citation analysis:** [AUDITOR TOOL LIMITATION] The auditor's automated full-text fetcher could not retrieve this paper's body content from Future Science. Only the abstract is available. THIS IS AN INTERNAL LIMITATION OF THE AUDITING TOOL — IT IS NOT EVIDENCE OF MISCONDUCT BY THE PAPER, ITS AUTHORS, OR THE JOURNAL. Do NOT raise any FLAG (CRITICAL, MAJOR, or MINOR) under Section A (Citation Fraud) or Section D (Plagiarism) on the basis of this limitation. Write exactly: "No automated citation analysis available — auditor tool limitation; not an ethics finding." and move on. Other categories (B/C/E/F/G/H) may still be assessed from the abstract where evidence exists.`;
  }
  if (v.citations.length === 0) {
    return `**Citation analysis:** Full text retrieved. Zero citations to external works detected. Section B must note this explicitly (the paper makes no verifiable references).`;
  }
  const verifiedFs = v.citations.filter(c => c.verifiedSource === "future-science").length;
  const verifiedAx = v.citations.filter(c => c.verifiedSource === "arxiv").length;
  const verifiedOa = v.citations.filter(c => c.verifiedSource === "openalex").length;
  const unverified = v.citations.filter(c => c.verifiedSource === "none").length;
  const mismatched = v.citations.filter(c => c.verifiedSource !== "none" && c.titleMatchesClaim === false).length;
  const lines = v.citations.map((c, i) => {
    const id = c.doi ? `DOI ${c.doi}` : c.arxivId ? `arXiv:${c.arxivId}` : c.fsRef ? `Future Science slug "${c.fsRef}"` : c.authorYear ? `(${c.authorYear.author}, ${c.authorYear.year})` : c.raw;
    const claim = c.context ? ` | Claimed: "${c.context.slice(0, 220)}${c.context.length > 220 ? "…" : ""}"` : "";
    const mismatchTag = c.verifiedSource !== "none" && c.titleMatchesClaim === false
      ? ` — *** TITLE MISMATCH: the URL/ID resolves to a DIFFERENT work than the bibliography line claims (likely mis-citation or fabricated reference) ***`
      : "";
    if (c.verifiedSource === "future-science") return `  ${i + 1}. ${id} — VERIFIED in Future Science: "${c.verifiedTitle ?? "(title unavailable)"}"${mismatchTag}${claim}`;
    if (c.verifiedSource === "arxiv") return `  ${i + 1}. ${id} — VERIFIED on arXiv: "${c.verifiedTitle ?? "(title unavailable)"}"${c.verifiedUrl ? ` <${c.verifiedUrl}>` : ""}${mismatchTag}${claim}`;
    if (c.verifiedSource === "openalex") return `  ${i + 1}. ${id} — VERIFIED in OpenAlex: "${c.verifiedTitle ?? "(title unavailable)"}"${c.verifiedUrl ? ` <${c.verifiedUrl}>` : ""}${mismatchTag}${claim}`;
    return `  ${i + 1}. ${id} — UNVERIFIED (not found in Future Science or OpenAlex; treat as potentially hallucinated, mis-cited, or non-indexed)${claim}`;
  });
  const mismatchHeadline = mismatched > 0
    ? ` *** ${mismatched} citation(s) RESOLVE TO A DIFFERENT WORK than the bibliography claims — flag in Section A as mis-citation/possible fraud. ***`
    : "";
  return `**Citation analysis:** Full text retrieved. ${v.citations.length} citation(s) detected. Verified ${verifiedFs} via Future Science, ${verifiedAx} via arXiv, ${verifiedOa} via OpenAlex; ${unverified} unverified; ${mismatched} title-mismatched.${mismatchHeadline}\n${lines.join("\n")}`;
}
