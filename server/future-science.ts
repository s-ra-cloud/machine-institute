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
  data?: { documentId?: string; slug?: string };
  documentId?: string;
  slug?: string;
  id?: string;
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

export async function submitLiteratureReviewToFutureScience(
  options: LiteratureReviewSubmitOptions,
): Promise<{ documentId: string; url: string } | null> {
  const apiKey = process.env.FUTURE_SCIENCE_API_KEY;
  if (!apiKey) {
    console.warn("FUTURE_SCIENCE_API_KEY is not set — skipping Future Science submission.");
    return null;
  }

  try {
    const metadata: Record<string, unknown> = {
      title: options.title,
      abstract: options.abstract,
      type: "Unreviewed manuscript",
      language: "en",
      agentName: options.agentName,
      initiative: "efyjiy34s5lgbx2gr50k5h9l",
      keywords: options.keywords.map((k) => ({ text: k })),
      coauthorsNotified: true,
      isFormatCompliant: true,
      sourceLinkCorrect: true,
      isMarkdown: true,
    };
    if (options.orchestratorName) {
      metadata.orchestratorName = options.orchestratorName;
    }
    if (options.agentDescription) {
      metadata.agentDescription = options.agentDescription;
    }

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
    const url = slug
      ? `https://future-science.org/papers/${slug}`
      : documentId
        ? `https://future-science.org/papers/${documentId}`
        : null;

    return { documentId: documentId || "unknown", url: url || "" };
  } catch (err) {
    console.error("Future Science submission error:", err);
    return null;
  }
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
      }],
      content: options.contentHtml,
      status: "unrevised_manuscript",
    };

    if (options.metadata) {
      payload.metadata = {
        generatedBy: "Machine Institute AI Pipeline",
        orchestratorName: options.metadata.orchestratorName,
        agentDescription: options.metadata.agentDescription,
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
    const initiativeSlug = options.initiativeSlug || "papers";
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

export async function fetchAbstractsAndKeywords(institutions: string[], initiativeDocId?: string): Promise<{
  abstracts: FutureScienceAbstract[];
  allKeywords: string[];
}> {
  const PAGE_SIZE = 25;
  let page = 1;
  let pageCount = 1;
  const abstracts: FutureScienceAbstract[] = [];
  const keywordSet = new Set<string>();

  while (page <= pageCount) {
    let url = `${FS_API_BASE}/public/contributions?pagination[pageSize]=${PAGE_SIZE}&pagination[page]=${page}`;
    if (initiativeDocId) {
      url += `&filters[initiative]=${encodeURIComponent(initiativeDocId)}`;
    }
    const resp = await fetch(url);
    if (!resp.ok) break;

    const json: FSContributionsResponse = await resp.json() as FSContributionsResponse;
    const items = json?.data || [];
    pageCount = json?.meta?.pagination?.pageCount || 1;

    for (const c of items) {
      const authors: FSAuthor[] = Array.isArray(c.author) ? c.author : (c.author ? [c.author] : []);
      const matchesInstitution = institutions.length === 0 || authors.some((a) =>
        institutions.some(inst => (a.institution || "").includes(inst))
      );

      if (matchesInstitution) {
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
          documentId: c.documentId || "",
        });
      }
    }
    page++;
  }

  return { abstracts, allKeywords: Array.from(keywordSet) };
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
