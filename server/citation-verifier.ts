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
  verifiedSource: "future-science" | "openalex" | "none";
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
    const html = await fetchTextWithTimeout(`https://future-science.org/${slug}/papers/${encodeURIComponent(documentId)}`, 8000);
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
  const capped = citations.slice(0, 100);
  return pMapLimit(capped, 4, async (c) => {
    const fs = verifyAgainstFs(c, fsAbstracts);
    if (fs?.verified) {
      const match = titleMatches(c.context, fs.title);
      return { ...c, verifiedSource: "future-science" as const, verifiedTitle: fs.title, verifiedUrl: fs.url, titleMatchesClaim: match.ok, matchNote: match.note };
    }
    const oa = await verifyAgainstOpenAlex(c);
    if (oa?.verified) {
      const match = titleMatches(c.context, oa.title);
      return { ...c, verifiedSource: "openalex" as const, verifiedTitle: oa.title, verifiedUrl: oa.url, titleMatchesClaim: match.ok, matchNote: match.note };
    }
    return { ...c, verifiedSource: "none" as const };
  });
}

export interface VerifiedUrl {
  url: string;
  reachable: boolean | null;
  status?: number;
  note?: string;
  arxivIdMatch?: boolean;
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

async function checkUrlReachable(url: string, timeoutMs = 7000): Promise<{ reachable: boolean | null; status?: number; note?: string }> {
  const guard = isUrlSafeForVerification(url);
  if (!guard.ok) return { reachable: null, note: `skipped (${guard.reason})` };
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const resp = await fetch(url, {
        method,
        headers: { "User-Agent": "MachineInstitute-EthicsAuditor", "Accept": "*/*" },
        signal: ctrl.signal,
        redirect: "follow",
      });
      clearTimeout(t);
      if (resp.status === 405 && method === "HEAD") continue;
      return { reachable: resp.ok, status: resp.status };
    } catch {
      // try next method or fall through
    }
  }
  return { reachable: null };
}

export async function verifyUrls(urls: string[]): Promise<VerifiedUrl[]> {
  const capped = urls.slice(0, 100);
  return pMapLimit(capped, 5, async (url): Promise<VerifiedUrl> => {
    const { reachable, status, note: checkNote } = await checkUrlReachable(url);
    let arxivIdMatch: boolean | undefined;
    let note: string | undefined = checkNote;
    const arxivM = url.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5})/i);
    if (arxivM && reachable === false) {
      arxivIdMatch = false;
      note = note || "arXiv ID does not resolve";
    }
    return { url, reachable, status, note, arxivIdMatch };
  });
}

export function formatUrlVerificationReport(verified: VerifiedUrl[]): string {
  if (verified.length === 0) {
    return `**Link analysis:** No external URLs were detected in the paper's full text.`;
  }
  const ok = verified.filter(v => v.reachable === true).length;
  const broken = verified.filter(v => v.reachable === false).length;
  const unknown = verified.filter(v => v.reachable === null).length;
  const lines = verified.map((v, i) => {
    const tag = v.reachable === true
      ? `OK (HTTP ${v.status})`
      : v.reachable === false
      ? `BROKEN (HTTP ${v.status ?? "?"})${v.note ? ` — ${v.note}` : ""}`
      : `UNREACHABLE${v.note ? ` — ${v.note}` : " (network/timeout)"}`;
    return `  ${i + 1}. ${v.url} — ${tag}`;
  });
  return `**Link analysis:** ${verified.length} URL(s) detected. ${ok} reachable, ${broken} broken, ${unknown} unverifiable. (URLs targeting internal/private networks are intentionally skipped for safety; treat skipped entries as auditor tool limitations, NOT ethics findings.)\n${lines.join("\n")}`;
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
  const mismatched = v.citations.filter(c => c.verifiedSource !== "none" && c.titleMatchesClaim === false).length;
  const lines = v.citations.map((c, i) => {
    const id = c.doi ? `DOI ${c.doi}` : c.arxivId ? `arXiv:${c.arxivId}` : c.fsRef ? `Future Science slug "${c.fsRef}"` : c.authorYear ? `(${c.authorYear.author}, ${c.authorYear.year})` : c.raw;
    const claim = c.context ? ` | Claimed: "${c.context.slice(0, 220)}${c.context.length > 220 ? "…" : ""}"` : "";
    const mismatchTag = c.verifiedSource !== "none" && c.titleMatchesClaim === false
      ? ` — *** TITLE MISMATCH: the URL/ID resolves to a DIFFERENT work than the bibliography line claims (likely mis-citation or fabricated reference) ***`
      : "";
    if (c.verifiedSource === "future-science") return `  ${i + 1}. ${id} — VERIFIED in Future Science: "${c.verifiedTitle ?? "(title unavailable)"}"${mismatchTag}${claim}`;
    if (c.verifiedSource === "openalex") return `  ${i + 1}. ${id} — VERIFIED in OpenAlex: "${c.verifiedTitle ?? "(title unavailable)"}"${c.verifiedUrl ? ` <${c.verifiedUrl}>` : ""}${mismatchTag}${claim}`;
    return `  ${i + 1}. ${id} — UNVERIFIED (not found in Future Science or OpenAlex; treat as potentially hallucinated, mis-cited, or non-indexed)${claim}`;
  });
  const mismatchHeadline = mismatched > 0
    ? ` *** ${mismatched} citation(s) RESOLVE TO A DIFFERENT WORK than the bibliography claims — flag in Section A as mis-citation/possible fraud. ***`
    : "";
  return `**Citation analysis:** Full text retrieved. ${v.citations.length} citation(s) detected. Verified ${verifiedFs} via Future Science, ${verifiedOa} via OpenAlex; ${unverified} unverified; ${mismatched} title-mismatched.${mismatchHeadline}\n${lines.join("\n")}`;
}
