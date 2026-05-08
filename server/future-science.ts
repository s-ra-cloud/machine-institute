import { storage } from "./storage";

const FS_API_BASE = "https://future-science.org/api/v1";

export interface FutureScienceAbstract {
  title: string;
  abstract: string;
  authors: string;
  date: string;
  keywords: string[];
  documentId: string;
}

export interface FSPublishResult {
  data?: { documentId?: string; slug?: string; url?: string };
  documentId?: string;
  slug?: string;
  id?: string;
  url?: string;
}

export interface FSAuthor {
  firstName?: string;
  lastName?: string;
  institution?: string;
}

export interface FSContribution {
  title?: string;
  subtitle?: string;
  abstract?: string;
  author?: FSAuthor | FSAuthor[];
  keywords?: string[];
  publishedAt?: string;
  documentId?: string;
  url?: string;
  publicUrl?: string;
  slug?: string;
}

export interface FSContributionsResponse {
  data?: FSContribution[];
  meta?: { pagination?: { pageCount?: number } };
}

interface LiteratureReviewSubmitOptions {
  title: string;
  markdownContent: string;
  abstract: string;
  keywords: string[];
  agentName: string;
  orchestratorName?: string;
  agentDescription?: string;
}

function splitAgentNameForFutureScience(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { firstName: "Machine", lastName: "Institute" };
  }
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "Agent" };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

export async function submitLiteratureReviewToFutureScience(
  options: LiteratureReviewSubmitOptions,
): Promise<{ documentId: string; url: string } | null> {
  const apiKey = process.env.FUTURE_SCIENCE_API_KEY;
  if (!apiKey) {
    console.warn("FUTURE_SCIENCE_API_KEY is not set — skipping Future Science submission.");
    return null;
  }

  try {
    const visibleAuthorName = splitAgentNameForFutureScience(options.agentName);
    const metadata: Record<string, unknown> = {
      title: options.title,
      abstract: options.abstract,
      type: "Literature review",
      language: "en",
      agentName: options.agentName,
      author: [{
        firstName: visibleAuthorName.firstName,
        lastName: visibleAuthorName.lastName,
        institution: "Machine Institute",
        email: "research@machine-institute.org",
        links: [],
      }],
      initiative: "efyjiy34s5lgbx2gr50k5h9l",
      keywords: options.keywords.map((k) => ({ text: k })),
      coauthorsNotified: true,
      isFormatCompliant: true,
      sourceLinkCorrect: true,
      isMarkdown: true,
    };
    if (options.orchestratorName) {
      metadata.researchOrchestrator = options.orchestratorName;
    }
    if (options.agentDescription) {
      const MAX_AGENT_DESC = 500;
      metadata.agentDescription = options.agentDescription.length > MAX_AGENT_DESC
        ? options.agentDescription.slice(0, MAX_AGENT_DESC - 1).trimEnd() + "…"
        : options.agentDescription;
    }

    console.log("Future Science literature review api-bot payload fields:", {
      fields: Object.keys(metadata).sort(),
      agentName: options.agentName,
      orchestratorName: options.orchestratorName || null,
      visibleAuthor: `${visibleAuthorName.firstName} ${visibleAuthorName.lastName}`,
      hasAgentDescription: Boolean(options.agentDescription),
      keywordCount: options.keywords.length,
    });

    const formData = new FormData();
    formData.append("data", JSON.stringify({ data: metadata }));

    const mdBlob = new Blob([options.markdownContent], { type: "text/markdown" });
    formData.append("file", mdBlob, "review.md");

    const resp = await fetch(`${FS_API_BASE}/contributions/api-bots`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
      },
      body: formData,
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(`Future Science submission failed (${resp.status}):`, errorText);
      return null;
    }

    const result: FSPublishResult = await resp.json() as FSPublishResult;
    const documentId = result?.data?.documentId || result?.documentId || result?.id;
    const slug = result?.data?.slug || result?.slug;
    const FS_INITIATIVE = "mirror";
    const url = slug
      ? `https://future-science.org/${FS_INITIATIVE}/${slug}`
      : documentId
        ? `https://future-science.org/${FS_INITIATIVE}/${documentId}`
        : null;

    return { documentId: documentId || "unknown", url: url || "" };
  } catch (err) {
    console.error("Future Science submission error:", err);
    return null;
  }
}

interface EthicsReportSubmitOptions {
  title: string;
  markdownContent: string;
  abstract: string;
  keywords: string[];
  agentName: string;
  initiativeDocId: string;
  initiativeSlug?: string;
  orchestratorName?: string;
  agentDescription?: string;
  // For single-paper audits: URL of the audited Future Science paper.
  // When present, the report is submitted as "Response to a contribution"
  // with linkOriginalContribution pointing to this URL.
  linkOriginalContribution?: string;
}

const ETHICS_TYPE_FALLBACKS_FIELD = ["Unreviewed manuscript", "Other", "Article"];
const ETHICS_TYPE_FALLBACKS_RESPONSE = ["Response to a contribution", "Unreviewed manuscript", "Other", "Article"];
const PEER_REVIEW_TYPE_FALLBACKS = ["Peer-review", "Response to a contribution", "Unreviewed manuscript", "Other", "Article"];

export interface PeerReviewSubmitOptions {
  title: string;
  markdownContent: string;
  abstract: string;
  keywords: string[];
  agentName: string;
  initiativeDocId: string;
  initiativeSlug?: string;
  orchestratorName?: string;
  agentDescription?: string;
  linkOriginalContribution?: string;
  // Optional second author (the ethics co-author when enabled).
  ethicsCoauthorName?: string;
}

export async function submitPeerReviewToFutureScience(
  options: PeerReviewSubmitOptions,
): Promise<{ documentId: string; url: string } | null> {
  const apiKey = process.env.FUTURE_SCIENCE_API_KEY;
  if (!apiKey) {
    console.warn("FUTURE_SCIENCE_API_KEY is not set — skipping Future Science peer review submission.");
    return null;
  }

  const visibleAuthorName = splitAgentNameForFutureScience(options.agentName);
  const authors: Array<Record<string, unknown>> = [{
    firstName: visibleAuthorName.firstName,
    lastName: visibleAuthorName.lastName,
    institution: "Machine Institute",
    email: "research@machine-institute.org",
    links: [],
  }];
  if (options.ethicsCoauthorName) {
    const coauthor = splitAgentNameForFutureScience(options.ethicsCoauthorName);
    authors.push({
      firstName: coauthor.firstName,
      lastName: coauthor.lastName,
      institution: "Machine Institute",
      email: "research@machine-institute.org",
      links: [],
    });
  }

  const baseMetadata: Record<string, unknown> = {
    title: options.title,
    abstract: options.abstract,
    language: "en",
    agentName: options.agentName,
    author: authors,
    initiative: options.initiativeDocId,
    keywords: options.keywords.map((k) => ({ text: k })),
    coauthorsNotified: true,
    isFormatCompliant: true,
    sourceLinkCorrect: true,
    isMarkdown: true,
  };
  if (options.orchestratorName) baseMetadata.researchOrchestrator = options.orchestratorName;
  if (options.agentDescription) {
    const MAX_AGENT_DESC = 500;
    baseMetadata.agentDescription = options.agentDescription.length > MAX_AGENT_DESC
      ? options.agentDescription.slice(0, MAX_AGENT_DESC - 1).trimEnd() + "…"
      : options.agentDescription;
  }
  if (options.linkOriginalContribution) {
    baseMetadata.linkOriginalContribution = options.linkOriginalContribution;
  }

  let lastErr: string = "";
  for (const candidateType of PEER_REVIEW_TYPE_FALLBACKS) {
    try {
      const metadata: Record<string, unknown> = { ...baseMetadata, type: candidateType };
      // linkOriginalContribution is only valid for response-style types
      if (candidateType !== "Peer-review" && candidateType !== "Response to a contribution") {
        delete metadata.linkOriginalContribution;
      }
      const formData = new FormData();
      formData.append("data", JSON.stringify({ data: metadata }));
      const mdBlob = new Blob([options.markdownContent], { type: "text/markdown" });
      formData.append("file", mdBlob, "peer-review.md");

      console.log("Future Science peer-review api-bot attempt:", {
        type: candidateType,
        agentName: options.agentName,
        coauthor: options.ethicsCoauthorName || null,
        initiative: options.initiativeDocId,
        hasLinkOriginal: Boolean(metadata.linkOriginalContribution),
      });

      const resp = await fetch(`${FS_API_BASE}/contributions/api-bots`, {
        method: "POST",
        headers: { "x-api-key": apiKey },
        body: formData,
      });

      if (!resp.ok) {
        lastErr = await resp.text();
        console.warn(`FS rejected peer-review type "${candidateType}" (${resp.status}): ${lastErr.slice(0, 200)} — trying next.`);
        continue;
      }

      const result: FSPublishResult = await resp.json() as FSPublishResult;
      const documentId = result?.data?.documentId || result?.documentId || result?.id;
      const slug = result?.data?.slug || result?.slug;
      const fsUrl = result?.data?.url || result?.url;
      const initSlug = options.initiativeSlug || "mirror";
      const url = fsUrl
        || (slug
          ? `https://future-science.org/${initSlug}/${slug}`
          : documentId
            ? `https://future-science.org/${initSlug}/${documentId}`
            : "");
      return { documentId: documentId || "unknown", url };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      console.error(`FS peer-review submission attempt ("${candidateType}") error:`, err);
    }
  }
  console.error("All FS peer-review type fallbacks exhausted. Last error:", lastErr);
  return null;
}

export async function submitEthicsReportToFutureScience(
  options: EthicsReportSubmitOptions,
): Promise<{ documentId: string; url: string } | null> {
  const apiKey = process.env.FUTURE_SCIENCE_API_KEY;
  if (!apiKey) {
    console.warn("FUTURE_SCIENCE_API_KEY is not set — skipping Future Science ethics submission.");
    return null;
  }

  const visibleAuthorName = splitAgentNameForFutureScience(options.agentName);
  const baseMetadata: Record<string, unknown> = {
    title: options.title,
    abstract: options.abstract,
    language: "en",
    agentName: options.agentName,
    author: [{
      firstName: visibleAuthorName.firstName,
      lastName: visibleAuthorName.lastName,
      institution: "Machine Institute",
      email: "research@machine-institute.org",
      links: [],
    }],
    initiative: options.initiativeDocId,
    keywords: options.keywords.map((k) => ({ text: k })),
    coauthorsNotified: true,
    isFormatCompliant: true,
    sourceLinkCorrect: true,
    isMarkdown: true,
  };
  if (options.orchestratorName) baseMetadata.researchOrchestrator = options.orchestratorName;
  if (options.agentDescription) {
    // FS / Strapi appears to enforce a length cap on agentDescription; long
    // strings cause the api-bots endpoint to return a generic 500 "Failed to
    // create contribution". Truncate defensively to stay well under any
    // typical Strapi text-field limit.
    const MAX_AGENT_DESC = 500;
    baseMetadata.agentDescription = options.agentDescription.length > MAX_AGENT_DESC
      ? options.agentDescription.slice(0, MAX_AGENT_DESC - 1).trimEnd() + "…"
      : options.agentDescription;
  }
  if (options.linkOriginalContribution) {
    baseMetadata.linkOriginalContribution = options.linkOriginalContribution;
  }

  const typeFallbacks = options.linkOriginalContribution
    ? ETHICS_TYPE_FALLBACKS_RESPONSE
    : ETHICS_TYPE_FALLBACKS_FIELD;

  let lastErr: string = "";
  for (const candidateType of typeFallbacks) {
    try {
      // `linkOriginalContribution` is only meaningful (and accepted) for
      // "Response to a contribution". When falling back to a non-response type,
      // strip the field so FS doesn't reject the payload for unknown metadata.
      const metadata: Record<string, unknown> = { ...baseMetadata, type: candidateType };
      if (candidateType !== "Response to a contribution") {
        delete metadata.linkOriginalContribution;
      }
      const formData = new FormData();
      formData.append("data", JSON.stringify({ data: metadata }));
      const mdBlob = new Blob([options.markdownContent], { type: "text/markdown" });
      formData.append("file", mdBlob, "ethics-report.md");

      console.log("Future Science ethics api-bot attempt:", {
        type: candidateType,
        agentName: options.agentName,
        initiative: options.initiativeDocId,
        keywordCount: options.keywords.length,
        hasLinkOriginal: Boolean(metadata.linkOriginalContribution),
      });

      const resp = await fetch(`${FS_API_BASE}/contributions/api-bots`, {
        method: "POST",
        headers: { "x-api-key": apiKey },
        body: formData,
      });

      if (!resp.ok) {
        lastErr = await resp.text();
        // Try the next type on ANY non-success response. Some FS errors look
        // like a generic 500 ("Failed to create contribution") even when the
        // root cause is type-specific (e.g. linkOriginalContribution missing
        // or unresolvable for "Response to a contribution"), so we keep going
        // until we either succeed or exhaust the fallback chain.
        console.warn(
          `FS rejected type "${candidateType}" (status ${resp.status}): ${lastErr.slice(0, 200)} — trying next fallback.`,
        );
        continue;
      }

      const result: FSPublishResult = await resp.json() as FSPublishResult;
      const documentId = result?.data?.documentId || result?.documentId || result?.id;
      const slug = result?.data?.slug || result?.slug;
      const fsUrl = result?.data?.url || result?.url;
      const initSlug = options.initiativeSlug || "mirror";
      const url = fsUrl
        || (slug
          ? `https://future-science.org/${initSlug}/${slug}`
          : documentId
            ? `https://future-science.org/${initSlug}/${documentId}`
            : "");
      return { documentId: documentId || "unknown", url };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      console.error(`FS ethics submission attempt ("${candidateType}") error:`, err);
    }
  }
  console.error("All FS ethics type fallbacks exhausted. Last error:", lastErr);
  return null;
}

interface PublishOptions {
  title: string;
  contentHtml: string;
  abstract: string;
  authorFirstName: string;
  authorLastName: string;
  authorInstitution: string;
  authorEmail: string;
  keywords: string[];
  type?: string;
  accessToken: string;
  initiativeSlug?: string;
  metadata?: {
    orchestratorName?: string;
    agentDescription?: string;
    promptUsed?: string;
    topic?: string;
    modelProvider?: string;
    modelName?: string;
    providerMode?: string;
  };
}

export async function publishToFutureScience(options: PublishOptions): Promise<{ documentId: string; url: string } | null> {
  try {
    const payload: Record<string, any> = {
      title: options.title,
      abstract: options.abstract,
      type: options.type || "article",
      language: "English",
      keywords: options.keywords,
      author: [{
        firstName: options.authorFirstName,
        lastName: options.authorLastName,
        institution: options.authorInstitution,
        email: options.authorEmail,
        links: [],
      }],
      content: options.contentHtml,
      status: "unrevised_manuscript",
    };

    if (options.metadata) {
      payload.metadata = {
        generatedBy: "Machine Institute AI Pipeline",
        orchestratorName: options.metadata.orchestratorName,
        agentDescription: options.metadata.agentDescription && options.metadata.agentDescription.length > 500
          ? options.metadata.agentDescription.slice(0, 499).trimEnd() + "…"
          : options.metadata.agentDescription,
        topic: options.metadata.topic,
        modelProvider: options.metadata.modelProvider,
        modelName: options.metadata.modelName,
        providerMode: options.metadata.providerMode,
        promptUsed: options.metadata.promptUsed,
      };
    }

    const resp = await fetch(`${FS_API_BASE}/contributions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${options.accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(`Future Science publication failed (${resp.status}):`, errorText);
      return null;
    }

    const result: FSPublishResult = await resp.json() as FSPublishResult;
    const documentId = result?.data?.documentId || result?.documentId || result?.id;
    const slug = result?.data?.slug || result?.slug;
    const initiativeSlug = options.initiativeSlug || "mirror";
    const url = slug
      ? `https://future-science.org/${initiativeSlug}/${slug}`
      : documentId
        ? `https://future-science.org/${initiativeSlug}/${documentId}`
        : null;

    return { documentId: documentId || "unknown", url: url || "" };
  } catch (err) {
    console.error("Future Science publication error:", err);
    return null;
  }
}

export class FutureScienceFetchError extends Error {
  status?: number;
  url: string;
  page: number;
  bodyExcerpt?: string;
  cause?: unknown;
  constructor(message: string, info: { url: string; page: number; status?: number; bodyExcerpt?: string; cause?: unknown }) {
    super(message);
    this.name = "FutureScienceFetchError";
    this.url = info.url;
    this.page = info.page;
    this.status = info.status;
    this.bodyExcerpt = info.bodyExcerpt;
    this.cause = info.cause;
  }
}

export async function fetchAbstractsAndKeywords(institutions: string[], initiativeDocId?: string): Promise<{
  abstracts: FutureScienceAbstract[];
  allKeywords: string[];
}> {
  const PAGE_SIZE = 100;
  let page = 1;
  let pageCount = 1;
  const seenDocIds = new Set<string>();
  const abstracts: FutureScienceAbstract[] = [];
  const keywordSet = new Set<string>();

  while (page <= pageCount) {
    let url: string;
    if (initiativeDocId) {
      url = `${FS_API_BASE}/initiatives/${encodeURIComponent(initiativeDocId)}/contributions?pagination[pageSize]=${PAGE_SIZE}&pagination[page]=${page}`;
    } else {
      url = `${FS_API_BASE}/public/contributions?pagination[pageSize]=${PAGE_SIZE}&pagination[page]=${page}`;
    }

    let resp: Response;
    try {
      resp = await fetch(url);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[future-science] Network error fetching contributions page ${page} from ${url}: ${reason}`);
      throw new FutureScienceFetchError(`network error: ${reason}`, { url, page, cause: err });
    }

    if (!resp.ok) {
      let bodyExcerpt = "";
      try {
        const text = await resp.text();
        bodyExcerpt = text.slice(0, 300);
      } catch {
        bodyExcerpt = "<unable to read body>";
      }
      console.error(`[future-science] HTTP ${resp.status} fetching contributions page ${page} from ${url}. Body excerpt: ${bodyExcerpt}`);
      throw new FutureScienceFetchError(`HTTP ${resp.status}`, { url, page, status: resp.status, bodyExcerpt });
    }

    let json: FSContributionsResponse;
    try {
      json = await resp.json() as FSContributionsResponse;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[future-science] JSON parse error on page ${page} from ${url}: ${reason}`);
      throw new FutureScienceFetchError(`JSON parse error: ${reason}`, { url, page, status: resp.status, cause: err });
    }

    const items = json?.data || [];
    pageCount = json?.meta?.pagination?.pageCount || 1;

    let newItemsOnPage = 0;
    let dupedOnPage = 0;
    for (const c of items) {
      const docId = c.documentId || "";
      if (docId && seenDocIds.has(docId)) { dupedOnPage++; continue; }
      if (docId) seenDocIds.add(docId);

      const authors: FSAuthor[] = Array.isArray(c.author) ? c.author : (c.author ? [c.author] : []);
      const matchesInstitution = institutions.length === 0 || authors.some((a) =>
        institutions.some(inst => (a.institution || "").includes(inst))
      );

      if (matchesInstitution) {
        newItemsOnPage++;
        const authorList = authors
          .map((a) => `${a.firstName || ""} ${a.lastName || ""}`.trim())
          .filter((s) => s.length > 0)
          .join(", ");

        const keywords = (Array.isArray(c.keywords) ? c.keywords : []).filter((k: unknown) => typeof k === "string" && k.length > 0);
        keywords.forEach((k: string) => keywordSet.add(k.toLowerCase()));

        abstracts.push({
          title: c.subtitle ? `${c.title || ""}: ${c.subtitle}` : (c.title || "Untitled"),
          abstract: c.abstract || "",
          authors: authorList || "Unknown",
          date: c.publishedAt ? c.publishedAt.split("T")[0] : "",
          keywords,
          documentId: docId,
        });
      }
    }

    console.log(`[future-science] page ${page}/${pageCount}: received ${items.length} item(s), ${newItemsOnPage} new, ${dupedOnPage} duplicate (running total: ${abstracts.length}).`);

    if (items.length === 0) break;
    if (newItemsOnPage === 0 && dupedOnPage === items.length) {
      console.log(`[future-science] page ${page} returned only duplicates — API likely not honoring pagination params. Stopping.`);
      break;
    }
    if (newItemsOnPage === 0) break;
    page++;
  }

  console.log(`[future-science] fetchAbstractsAndKeywords done: ${abstracts.length} unique papers fetched (deduped from ${seenDocIds.size} doc IDs across ${page - 1} page(s)) for initiative=${initiativeDocId || "<public>"}.`);
  return { abstracts, allKeywords: Array.from(keywordSet) };
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function scoreRelevance(
  abstracts: FutureScienceAbstract[],
  researchQuestion: string,
): { relevant: FutureScienceAbstract[]; other: FutureScienceAbstract[] } {
  const normalizedQuestion = normalizeText(researchQuestion);
  const queryTerms = normalizedQuestion.split(" ").filter((w) => w.length > 2);

  const queryPhrases: string[] = [normalizedQuestion];
  const words = normalizedQuestion.split(" ");
  for (let i = 0; i < words.length - 1; i++) {
    queryPhrases.push(words.slice(i, i + 2).join(" "));
  }

  const scored = abstracts.map((a) => {
    let score = 0;
    const normTitle = normalizeText(a.title);
    const normAbstract = normalizeText(a.abstract || "");
    const normKeywords = a.keywords.map((k) => normalizeText(k));

    for (const kw of normKeywords) {
      if (kw === normalizedQuestion || normalizedQuestion === kw) score += 10;
      else if (kw.includes(normalizedQuestion) || normalizedQuestion.includes(kw)) score += 6;
    }

    if (normTitle.includes(normalizedQuestion)) score += 8;
    if (normAbstract.includes(normalizedQuestion)) score += 4;

    for (const term of queryTerms) {
      for (const kw of normKeywords) {
        if (kw.includes(term)) score += 3;
      }
      if (normTitle.includes(term)) score += 2;
      if (normAbstract.includes(term)) score += 1;
    }

    for (const phrase of queryPhrases) {
      if (phrase.split(" ").length >= 2) {
        if (normTitle.includes(phrase)) score += 5;
        if (normAbstract.includes(phrase)) score += 3;
      }
    }

    const fullQuestion = researchQuestion.toLowerCase();
    for (const kw of normKeywords) {
      if (fullQuestion.includes(kw)) score += 4;
    }

    return { abstract: a, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const relevant = scored.filter((s) => s.score > 0).map((s) => s.abstract);
  const other = scored.filter((s) => s.score === 0).map((s) => s.abstract);

  return { relevant, other };
}

export function extractTrendsAndGaps(abstracts: Array<{ title: string; abstract: string; keywords: string[] }>): string {
  const keywordFreq = new Map<string, number>();
  for (const a of abstracts) {
    for (const k of a.keywords) {
      if (typeof k !== "string") continue;
      const lower = k.toLowerCase();
      keywordFreq.set(lower, (keywordFreq.get(lower) || 0) + 1);
    }
  }

  const topKeywords = [...keywordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([k, count]) => `${k} (${count} papers)`);

  const wordFreq = new Map<string, number>();
  for (const a of abstracts) {
    const words = (a.title + " " + a.abstract).toLowerCase().split(/\s+/);
    for (const w of words) {
      if (w.length > 5) {
        wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
      }
    }
  }

  const topTerms = [...wordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([term]) => term);

  return `Trending keywords: ${topKeywords.join(", ")}\nFrequent terms: ${topTerms.join(", ")}\nTotal papers analyzed: ${abstracts.length}`;
}

export function clusterByKeywords(abstracts: Array<{ title: string; abstract: string; keywords: string[] }>): Map<string, Array<{ title: string; abstract: string }>> {
  const clusters = new Map<string, Array<{ title: string; abstract: string }>>();

  for (const a of abstracts) {
    for (const k of a.keywords) {
      if (typeof k !== "string") continue;
      const lower = k.toLowerCase();
      if (!clusters.has(lower)) clusters.set(lower, []);
      clusters.get(lower)!.push({ title: a.title, abstract: a.abstract });
    }
  }

  const sorted = [...clusters.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10);

  return new Map(sorted);
}
