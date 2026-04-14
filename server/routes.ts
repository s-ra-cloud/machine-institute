import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertPaperSchema, insertResearchEventSchema, insertLiteratureReviewSchema, insertProjectPaperSchema, insertEditorialSchema, insertAgentMemberSchema, type LiteratureReview, type EditorialRecord, type ResearchEvent } from "@shared/schema";
import { fromZodError } from "zod-validation-error";
import { z } from "zod";
import path from "path";
import fs from "fs";
import OpenAI from "openai";
import { JSDOM } from "jsdom";
import DOMPurify from "dompurify";
import { requireAuth, optionalAuth, adminAuth, requireSession } from "./auth";
import { createLLMClient, resolveModelName, generateWithConfig, validateApiKey, PLATFORM_MODELS, BYOC_PROVIDERS, PER_USER_PLATFORM_LIMITS, type ModelProviderConfig } from "./model-service";
import { publishToFutureScience, submitLiteratureReviewToFutureScience, fetchAbstractsAndKeywords, extractTrendsAndGaps, clusterByKeywords, scoreRelevance, type FutureScienceAbstract, type FSContribution, type FSAuthor, type FSContributionsResponse } from "./future-science";
import { storeEphemeralKey, getEphemeralKey } from "./ephemeral-keys";

function buildConventionName(modelName: string, agentId: string): string {
  const m = (modelName || "").toLowerCase();
  let initials: string;
  if (m.includes("deepseek-r1")) initials = "DSR1";
  else if (m.includes("deepseek")) initials = "DS32";
  else if (m.includes("claude-sonnet-4-5") || m.includes("sonnet-4-5")) initials = "CS45";
  else if (m.includes("claude-sonnet-4") || m.includes("sonnet-4")) initials = "CS4";
  else if (m.includes("claude-opus")) initials = "CO";
  else if (m.includes("claude-haiku")) initials = "CH";
  else if (m.includes("gpt-4o")) initials = "G4O";
  else if (m.includes("gpt-4")) initials = "G4";
  else initials = "ML";
  return `MachInstit ${initials}${agentId}-N1`;
}

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 80)
    + "-" + Date.now().toString(36);
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  const uploadsDir = path.resolve("uploads");
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  app.post("/api/papers", async (req, res) => {
    try {
      const result = insertPaperSchema.safeParse(req.body);
      if (!result.success) {
        const message = fromZodError(result.error).message;
        return res.status(400).json({ error: message });
      }

      const data = result.data;

      if ((data.type === "review" || data.type === "revision") && !data.linkedPaperId) {
        return res.status(400).json({
          error: `Papers of type "${data.type}" require a linkedPaperId referencing the original paper.`
        });
      }

      if (data.linkedPaperId) {
        const linked = await storage.getPaperById(data.linkedPaperId);
        if (!linked) {
          return res.status(400).json({
            error: `Linked paper with id "${data.linkedPaperId}" not found.`
          });
        }
      }

      const slug = generateSlug(data.title);

      const paper = await storage.createPaper({ ...data, slug });

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const publicationUrl = `${baseUrl}/papers/${paper.slug}`;

      return res.status(201).json({
        paper,
        publicationUrl
      });
    } catch (err: any) {
      console.error("Error creating paper:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/papers/:id/upload", async (req, res) => {
    try {
      const paper = await storage.getPaperById(req.params.id);
      if (!paper) {
        return res.status(404).json({ error: "Paper not found" });
      }

      const contentType = req.headers["content-type"] || "";

      if (contentType.includes("text/html") || contentType.includes("application/json")) {
        let htmlContent: string;

        if (contentType.includes("application/json") && req.body.html) {
          htmlContent = req.body.html;
        } else {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          await new Promise((resolve) => req.on("end", resolve));
          htmlContent = Buffer.concat(chunks).toString("utf-8");
        }

        const filePath = path.join(uploadsDir, `${paper.id}.html`);
        fs.writeFileSync(filePath, htmlContent);

        const { db } = await import("./db");
        const { papers } = await import("@shared/schema");
        const { eq } = await import("drizzle-orm");
        await db.update(papers).set({
          contentHtml: htmlContent,
          fileUrl: `/api/papers/${paper.id}/file`
        }).where(eq(papers.id, paper.id));

        return res.status(200).json({
          message: "HTML content uploaded successfully",
          fileUrl: `/api/papers/${paper.id}/file`
        });
      }

      if (contentType.includes("application/zip") || contentType.includes("application/octet-stream")) {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        await new Promise((resolve) => req.on("end", resolve));
        const buffer = Buffer.concat(chunks);

        const filePath = path.join(uploadsDir, `${paper.id}.zip`);
        fs.writeFileSync(filePath, buffer);

        const { db } = await import("./db");
        const { papers } = await import("@shared/schema");
        const { eq } = await import("drizzle-orm");
        await db.update(papers).set({
          fileUrl: `/api/papers/${paper.id}/file`
        }).where(eq(papers.id, paper.id));

        return res.status(200).json({
          message: "ZIP file uploaded successfully",
          fileUrl: `/api/papers/${paper.id}/file`
        });
      }

      return res.status(400).json({
        error: "Unsupported content type. Use text/html, application/json with {html: '...'}, or application/zip."
      });
    } catch (err: any) {
      console.error("Error uploading file:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/papers/:id/file", async (req, res) => {
    try {
      const paper = await storage.getPaperById(req.params.id);
      if (!paper) {
        return res.status(404).json({ error: "Paper not found" });
      }

      const htmlPath = path.join(uploadsDir, `${paper.id}.html`);
      const zipPath = path.join(uploadsDir, `${paper.id}.zip`);

      if (fs.existsSync(htmlPath)) {
        res.setHeader("Content-Type", "text/html");
        return res.sendFile(htmlPath);
      }

      if (fs.existsSync(zipPath)) {
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="${paper.slug}.zip"`);
        return res.sendFile(zipPath);
      }

      return res.status(404).json({ error: "No file uploaded for this paper" });
    } catch (err: any) {
      console.error("Error serving file:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/papers", async (_req, res) => {
    try {
      const type = _req.query.type as string | undefined;
      let allPapers;
      if (type && ["article", "review", "revision"].includes(type)) {
        allPapers = await storage.getPapersByType(type);
      } else {
        allPapers = await storage.getAllPapers();
      }

      const baseUrl = `${_req.protocol}://${_req.get("host")}`;
      const papersWithUrls = allPapers.map(p => ({
        ...p,
        publicationUrl: `${baseUrl}/papers/${p.slug}`
      }));

      return res.json(papersWithUrls);
    } catch (err: any) {
      console.error("Error fetching papers:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/papers/:idOrSlug", async (req, res) => {
    try {
      const { idOrSlug } = req.params;
      let paper = await storage.getPaperById(idOrSlug);
      if (!paper) {
        paper = await storage.getPaperBySlug(idOrSlug);
      }
      if (!paper) {
        return res.status(404).json({ error: "Paper not found" });
      }

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      return res.json({
        ...paper,
        publicationUrl: `${baseUrl}/papers/${paper.slug}`
      });
    } catch (err: any) {
      console.error("Error fetching paper:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/research/events", async (req, res) => {
    try {
      const apiKey = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
      if (!apiKey || apiKey !== process.env.RESEARCH_API_KEY) {
        return res.status(401).json({ error: "Unauthorized. Provide a valid API key via X-API-Key header or Bearer token." });
      }

      const body = req.body;
      const isArray = Array.isArray(body);
      const items = isArray ? body : [body];

      const validated = [];
      for (const item of items) {
        const result = insertResearchEventSchema.safeParse(item);
        if (!result.success) {
          const message = fromZodError(result.error).message;
          return res.status(400).json({ error: message });
        }
        validated.push(result.data);
      }

      const agentsToUpsert = new Map<string, any>();
      for (const item of validated) {
        const fullName = `${item.source} ${item.agentId}`;
        const id = fullName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        if (!agentsToUpsert.has(id)) {
          const parsed = parseAgentName(fullName);
          const desc = buildAgentDescription(parsed);
          agentsToUpsert.set(id, {
            id,
            name: fullName,
            plainDescription: desc,
            framework: parsed.framework,
            model: parsed.modelLabel,
            role: parsed.roleLabel,
            memory: parsed.memoryLabel,
          });
        }
      }
      if (agentsToUpsert.size > 0) {
        await storage.upsertAgentMembers(Array.from(agentsToUpsert.values()));
      }

      if (validated.length === 1) {
        const event = await storage.createResearchEvent(validated[0]);
        return res.status(201).json(event);
      }

      const events = await storage.createResearchEvents(validated);
      return res.status(201).json(events);
    } catch (err: any) {
      console.error("Error creating research event:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/research/events", async (req, res) => {
    try {
      const since = req.query.since as string | undefined;
      const before = req.query.before as string | undefined;
      const limit = req.query.limit ? Math.max(1, parseInt(req.query.limit as string) || 200) : 200;
      let events: ResearchEvent[];
      if (before) {
        events = await storage.getEventsBefore(new Date(before), limit);
      } else if (since) {
        events = await storage.getEventsSince(new Date(since));
      } else {
        events = await storage.getRecentEvents(limit);
      }
      const activeEvents = await storage.getActiveEvents(10);
      const active = activeEvents.length > 0;

      return res.json({
        active,
        events: events.reverse(),
        hasMore: before ? events.length === limit : false,
      });
    } catch (err: any) {
      console.error("Error fetching research events:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/project-papers", async (req, res) => {
    try {
      const projectId = req.query.projectId as string;
      if (projectId) {
        const papers = await storage.getProjectPapers(projectId);
        return res.json(papers);
      }
      const all = await storage.getAllProjectPapers();
      return res.json(all);
    } catch (err: any) {
      console.error("Error fetching project papers:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/project-papers", async (req, res) => {
    try {
      const apiKey = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
      if (!apiKey || apiKey !== process.env.RESEARCH_API_KEY) {
        return res.status(401).json({ error: "Unauthorized." });
      }

      const body = req.body;
      const isArray = Array.isArray(body);
      const items = isArray ? body : [body];

      const validated = [];
      for (const item of items) {
        const result = insertProjectPaperSchema.safeParse(item);
        if (!result.success) {
          const message = fromZodError(result.error).message;
          return res.status(400).json({ error: message });
        }
        validated.push(result.data);
      }

      if (validated.length === 1) {
        const paper = await storage.createProjectPaper(validated[0]);
        return res.status(201).json(paper);
      }

      const papers = await storage.createProjectPapers(validated);
      return res.status(201).json(papers);
    } catch (err: any) {
      console.error("Error creating project paper:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  const INITIATIVE_DOC_IDS: Record<string, string> = {
    "mirror": "efyjiy34s5lgbx2gr50k5h9l",
  };

  const INITIATIVE_INSTITUTIONS: Record<string, string[]> = {
    "mirror": ["Machine Institute"],
  };

  const INITIATIVE_SLUGS: Record<string, string> = {
    "mirror": "mirror-an-automated-journal-of-ai-interpretability",
  };

  const ROLE_CODES: Record<string, string> = {
    "E": "Experimenter",
    "R": "Reviewer",
    "A": "Analyst",
    "M": "Meta-analyst",
    "O": "Editorialist",
    "bR": "Basic Reviewer",
    "aR": "Adversarial Reviewer",
    "iR": "Innovation Reviewer",
    "bLR": "Basic Literature Reviewer",
    "aLR": "Adversarial Literature Reviewer",
    "H": "Ethicist",
    "V": "Reviser",
    "N": "Manager",
  };

  const MODEL_CODES: Record<string, string> = {
    "DS32": "DeepSeek-32B",
    "D32": "DeepSeek-32B",
    "CS45": "Claude 4.5 Sonnet",
    "CS35": "Claude 3.5 Sonnet",
    "QW3": "Qwen 3",
  };

  const MEMORY_CODES: Record<string, string> = {
    "N1": "No external memory, config v1",
    "N2": "No external memory, config v2",
    "N3": "No external memory, config v3",
    "N4": "No external memory, config v4",
  };

  interface ParsedAgentName {
    framework: string;
    modelCode: string;
    modelLabel: string;
    roleCode: string;
    roleLabel: string;
    memoryCode: string;
    memoryLabel: string;
  }

  function parseAgentName(name: string): ParsedAgentName {
    const parts = name.split(" ");
    const framework = parts[0] || "Unknown";
    const defaults: ParsedAgentName = {
      framework,
      modelCode: "Unknown", modelLabel: "Unknown",
      roleCode: "Unknown", roleLabel: "Researcher",
      memoryCode: "Unknown", memoryLabel: "Unknown",
    };
    if (parts.length < 2) return defaults;

    const codePart = parts[1];
    const fullMatch = codePart.match(/^([A-Z][A-Za-z0-9]*?)([a-zA-Z]+)-(N\d+)$/);
    if (!fullMatch) return defaults;

    const modelCode = fullMatch[1];
    const roleCode = fullMatch[2];
    const memoryCode = fullMatch[3];

    return {
      framework,
      modelCode,
      modelLabel: MODEL_CODES[modelCode] || modelCode,
      roleCode,
      roleLabel: ROLE_CODES[roleCode] || "Researcher",
      memoryCode,
      memoryLabel: MEMORY_CODES[memoryCode] || memoryCode,
    };
  }

  function buildAgentDescription(parsed: ParsedAgentName, institution?: string): string {
    const roleArticle = /^[AEIOU]/i.test(parsed.roleLabel) ? "an" : "a";
    const fwArticle = /^[AEIOU]/i.test(parsed.framework) ? "An" : "A";
    const inst = institution ? ` from ${institution}` : "";
    return `${fwArticle} ${parsed.framework} agent running on ${parsed.modelLabel} as ${roleArticle} ${parsed.roleLabel}${inst}, with ${parsed.memoryLabel.toLowerCase()}.`;
  }

  const SYNC_COOLDOWN_MS = 60 * 60 * 1000;

  async function fetchAllContributions(institutions: string[]): Promise<FSContribution[]> {
    const PAGE_SIZE = 25;
    let page = 1;
    let all: FSContribution[] = [];
    let pageCount = 1;

    while (page <= pageCount) {
      const url = `https://future-science.org/api/v1/public/contributions?pagination[pageSize]=${PAGE_SIZE}&pagination[page]=${page}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`Future Science API returned ${resp.status} on page ${page}`);
      }
      const json: FSContributionsResponse = await resp.json() as FSContributionsResponse;
      const items = json?.data || [];
      pageCount = json?.meta?.pagination?.pageCount || 1;

      const filtered = items.filter((c) => {
        const authors: FSAuthor[] = Array.isArray(c.author) ? c.author : (c.author ? [c.author] : []);
        return authors.some((a) =>
          institutions.some(inst => (a.institution || "").includes(inst))
        );
      });
      all = all.concat(filtered);
      page++;
    }

    return all;
  }

  app.post("/api/project-papers/sync", async (req, res) => {
    try {
      const { projectId } = req.body;
      if (!projectId || !INITIATIVE_DOC_IDS[projectId]) {
        return res.status(400).json({ error: "Unknown or unsupported project for sync." });
      }

      const syncKey = `future-science-sync-global`;
      const lastSync = await storage.getLastSyncTime(syncKey);
      if (lastSync && Date.now() - lastSync.getTime() < SYNC_COOLDOWN_MS) {
        const nextSyncIn = Math.ceil((SYNC_COOLDOWN_MS - (Date.now() - lastSync.getTime())) / 60000);
        return res.json({ synced: false, message: `Sync available in ${nextSyncIn} minutes.`, newPapers: 0 });
      }

      const institutions = INITIATIVE_INSTITUTIONS[projectId] || [];
      const contributions = await fetchAllContributions(institutions);

      if (contributions.length === 0) {
        await storage.setLastSyncTime(syncKey, new Date());
        return res.json({ synced: true, message: "No contributions found.", newPapers: 0 });
      }

      const sourceDocIds = contributions.map((c) => c.documentId).filter((id): id is string => !!id);
      const existing = await storage.getProjectPapersBySourceDocIds(sourceDocIds);
      const existingDocIds = new Set(existing.map(p => p.sourceDocumentId));

      const initiativeSlug = INITIATIVE_SLUGS[projectId] || "papers";
      const buildPaperUrl = (c: FSContribution) => {
        if (c.url) return c.url;
        if (c.publicUrl) return c.publicUrl;
        if (c.slug) return `https://future-science.org/${initiativeSlug}/${c.slug}`;
        if (c.documentId) return `https://future-science.org/${initiativeSlug}/${c.documentId}`;
        return null;
      };

      const newPapers = contributions
        .filter((c) => !existingDocIds.has(c.documentId))
        .map((c) => {
          const authorRaw = c.author;
          const authorArr: FSAuthor[] = Array.isArray(authorRaw) ? authorRaw : (authorRaw ? [authorRaw] : []);
          const authorList = authorArr
            .map((a) => `${a.firstName || ""} ${a.lastName || ""}`.trim() + (a.institution ? ` (${a.institution})` : ""))
            .filter((s) => s.length > 0)
            .join(", ");
          return {
            projectId,
            title: c.subtitle ? `${c.title || ""}: ${c.subtitle}` : (c.title || "Untitled"),
            description: c.abstract || "No abstract available.",
            authors: authorList || "Unknown",
            date: c.publishedAt ? c.publishedAt.split("T")[0] : new Date().toISOString().split("T")[0],
            type: "article",
            sourceDocumentId: c.documentId || "",
            url: buildPaperUrl(c),
          };
        });

      if (newPapers.length > 0) {
        await storage.createProjectPapers(newPapers);
      }

      for (const c of contributions) {
        if (c.documentId && existingDocIds.has(c.documentId)) {
          const paperUrl = buildPaperUrl(c);
          if (paperUrl) {
            await storage.updateProjectPaperUrl(c.documentId, paperUrl);
          }
        }
      }

      const authorSet = new Map<string, { firstName: string; lastName: string; institution: string }>();
      for (const c of contributions) {
        const authorRaw = c.author;
        const authorArr = Array.isArray(authorRaw) ? authorRaw : (authorRaw ? [authorRaw] : []);
        for (const a of authorArr) {
          const firstName = (a.firstName || "").trim();
          const lastName = (a.lastName || "").trim();
          const fullName = `${firstName} ${lastName}`.trim();
          if (fullName.length > 0 && !authorSet.has(fullName)) {
            authorSet.set(fullName, {
              firstName,
              lastName,
              institution: (a.institution || "").trim(),
            });
          }
        }
      }

      if (authorSet.size > 0) {
        const membersToUpsert = [];
        for (const [fullName, info] of authorSet) {
          const id = fullName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          const parsed = parseAgentName(fullName);
          const desc = buildAgentDescription(parsed, info.institution);
          membersToUpsert.push({
            id,
            name: fullName,
            plainDescription: desc,
            framework: parsed.framework,
            model: parsed.modelLabel,
            role: parsed.roleLabel,
            memory: parsed.memoryLabel,
          });
        }

        if (membersToUpsert.length > 0) {
          await storage.upsertAgentMembers(membersToUpsert);
        }
      }

      await storage.setLastSyncTime(syncKey, new Date());

      return res.json({
        synced: true,
        message: `Synced ${newPapers.length} new paper(s) from Future Science.`,
        newPapers: newPapers.length,
        total: contributions.length,
      });
    } catch (err: any) {
      console.error("Error syncing project papers:", err);
      return res.status(500).json({ error: "Internal server error during sync." });
    }
  });

  const DEFAULT_BLR_PROMPT = `You are assisting with an academic literature review.

I will provide a set of academic papers. Your task is to produce a structured literature review based strictly on these papers.

CRITICAL RULES ON REFERENCES (Chicago Author-Date Style):

1. You may ONLY cite papers that are explicitly provided to you. Do NOT invent, fabricate, or hallucinate any reference, author name, date, or paper title under any circumstances.
2. Every paper you cite in the text MUST appear in the References section. Every paper listed in the References section MUST be cited at least once in the text.
3. INLINE CITATIONS: Use Chicago author-date style with the actual author/agent name from the paper. Format: (Author, Date). Example: (MachinePsyKw DS32E-N1, 2026). When the same author has multiple papers from the same year, distinguish them with letters: (MachinePsyKw DS32E-N1, 2026a), (MachinePsyKw DS32E-N1, 2026b), etc.
4. BIBLIOGRAPHY: In the References section, use full Chicago style including the journal. Format:
   Author. Date. "Full Paper Title." *Mirror: An Automated Journal of AI Interpretability*, future-science.org.
   Example: MachinePsyKw DS32E-N1. 2026a. "Dark Triad Emergence in DeepSeek Chat." *Mirror: An Automated Journal of AI Interpretability*, future-science.org.
5. After writing the review, perform a SELF-CHECK: verify that every inline citation matches a real provided paper and that no reference was invented. Remove any citation that cannot be traced to a provided paper.

Instructions:

Read all the provided papers carefully.

Identify the main research question or theme connecting them.

Extract for each paper:
- main argument or hypothesis
- methodology
- key findings
- theoretical framework (if applicable)
- limitations or open questions

Organize the literature review by themes or debates, not by paper summaries alone.

Identify:
- points of agreement between authors
- points of disagreement or competing interpretations
- methodological differences
- gaps in the literature

Write the review in clear academic English suitable for a research paper.

CRITICAL: The bulk of the review must be analytical prose — the Thematic Review and Comparative Discussion sections should make up at least 70% of the total word count. The References section should be a compact list at the end, NOT the main body of the review.

Structure the output as follows:

## Introduction
Short paragraph explaining the general topic and scope of the literature.

## Inclusion Criteria
Briefly state which papers were included and why. Do NOT list every single paper here — just describe the selection criteria and mention a few representative examples.

## Thematic Review of the Literature
This is the core of the review. Organize the discussion into several thematic subsections synthesizing the papers. Use inline citations (Author, Date) throughout. Discuss findings, methodologies, and arguments in depth. This section should be extensive and analytical.

## Comparative Discussion
Explain how the papers relate to each other, including agreements, disagreements, and methodological contrasts. Cite inline.

## Research Gaps
Identify what remains unresolved or insufficiently studied.

## Conclusion
Brief synthesis of the state of the literature.

## References
List every cited paper in Chicago author-date bibliography format:
Author. Date. "Full Paper Title." *Mirror: An Automated Journal of AI Interpretability*, future-science.org.

Additional requirements:

- Base the analysis ONLY on the provided papers. Do not reference any external work.
- Cite every claim or finding with an inline reference.
- Avoid long quotations. Prefer synthesis over sequential summaries.
- Length: about 2500–4000 words of analytical content. The References section does not count toward this target.
- After completing the review, re-read it and confirm that every citation matches a provided paper. If you find a citation that does not match, remove it.

I will now provide the papers.`;

  const DEFAULT_ALR_PROMPT = `You are an adversarial literature reviewer. Your job is NOT to summarize or synthesize charitably. Your job is to tear the literature apart.

I will provide a set of academic papers. Your task is to produce a critical, adversarial literature review that ruthlessly exposes weaknesses, overinterpretations, methodological flaws, unsupported claims, logical gaps, and contradictions in and across these papers.

You are not agreeable. You do not give the benefit of the doubt. If a claim is weakly supported, say so. If a methodology is flawed, explain why. If conclusions overreach the data, call it out. If papers contradict each other, highlight the contradiction and explain why at least one must be wrong. If the entire body of work rests on questionable assumptions, dismantle those assumptions.

CRITICAL RULES ON REFERENCES (Chicago Author-Date Style):

1. You may ONLY cite papers that are explicitly provided to you. Do NOT invent, fabricate, or hallucinate any reference, author name, date, or paper title under any circumstances.
2. Every paper you cite in the text MUST appear in the References section. Every paper listed in the References section MUST be cited at least once in the text.
3. INLINE CITATIONS: Use Chicago author-date style with the actual author/agent name from the paper. Format: (Author, Date). Example: (MachinePsyKw DS32E-N1, 2026). When the same author has multiple papers from the same year, distinguish them with letters: (MachinePsyKw DS32E-N1, 2026a), (MachinePsyKw DS32E-N1, 2026b), etc.
4. BIBLIOGRAPHY: In the References section, use full Chicago style including the journal. Format:
   Author. Date. "Full Paper Title." *Mirror: An Automated Journal of AI Interpretability*, future-science.org.
   Example: MachinePsyKw DS32E-N1. 2026a. "Dark Triad Emergence in DeepSeek Chat." *Mirror: An Automated Journal of AI Interpretability*, future-science.org.
5. After writing the review, perform a SELF-CHECK: verify that every inline citation matches a real provided paper and that no reference was invented. Remove any citation that cannot be traced to a provided paper.

Instructions:

Read all the provided papers carefully — but read them as a skeptic, not as a supporter.

For each paper, identify:
- Unsupported or overreaching claims
- Methodological weaknesses (sample size, experimental design, confounds, lack of controls)
- Logical leaps or non-sequiturs in the argumentation
- Cherry-picked results or selective reporting
- Conclusions that do not follow from the evidence presented
- Missing baselines, missing comparisons, or missing alternative explanations
- Internal contradictions

Across the papers, identify:
- Contradictions between papers that the authors fail to acknowledge
- Shared blind spots or systematic biases across the body of work
- Circular reasoning or mutual citation without independent validation
- Overreliance on the same methodology without cross-validation
- Claims of novelty that are not actually novel

Write the review in direct, incisive academic English. Do not soften your critique with qualifiers like "perhaps" or "it could be argued." State your criticisms plainly.

CRITICAL: The bulk of the review must be analytical critique — the Critical Analysis and Cross-Paper Contradictions sections should make up at least 70% of the total word count. The References section should be a compact list at the end, NOT the main body of the review.

Structure the output as follows:

## Introduction
State the topic and immediately flag the central problems you see in this body of literature.

## Inclusion Criteria
Briefly describe which papers were included and why. Do NOT list every single paper here — just describe the selection criteria and mention a few representative examples.

## Critical Analysis
This is the core of the review. Organize the critique into thematic subsections. Each subsection should center on a specific category of weakness (e.g., "Methodological Deficiencies," "Overinterpretation of Results," "Contradictory Findings," "Unsupported Generalizations"). Cite inline throughout. This section must be extensive and deeply analytical.

## Cross-Paper Contradictions and Inconsistencies
Directly compare papers that make conflicting claims or use incompatible methodologies. Explain why these contradictions undermine the collective findings.

## Fundamental Gaps and Blind Spots
Identify what these papers collectively fail to address. What questions should have been asked but weren't? What controls are missing? What alternative hypotheses are ignored?

## Verdict
A blunt assessment of the state of this literature. Is it building toward reliable knowledge, or is it an echo chamber of weakly validated claims?

## References
List every cited paper in Chicago author-date bibliography format:
Author. Date. "Full Paper Title." *Mirror: An Automated Journal of AI Interpretability*, future-science.org.

Additional requirements:

- Base the analysis ONLY on the provided papers. Do not reference any external work.
- Cite every criticism with an inline reference to the specific paper(s) being criticized.
- Do NOT be charitable. If something is wrong, say it is wrong.
- Length: about 2500–4000 words of analytical content. The References section does not count toward this target.
- After completing the review, re-read it and confirm that every citation matches a provided paper. If you find a citation that does not match, remove it.

I will now provide the papers.`;

  app.get("/api/literature-reviews/default-prompt", (req, res) => {
    const agentId = req.query.agentId as string | undefined;
    if (agentId && agentId.includes("aLR")) {
      return res.json({ prompt: DEFAULT_ALR_PROMPT });
    }
    return res.json({ prompt: DEFAULT_BLR_PROMPT });
  });

  app.get("/api/generation/config", (_req, res) => {
    return res.json({
      platformModels: PLATFORM_MODELS,
      byocProviders: BYOC_PROVIDERS,
      limits: PER_USER_PLATFORM_LIMITS,
      defaultTopics: {
        editorial: "Recent developments in AI agent-driven scientific research, machine psychology, and autonomous experimentation",
        "literature-review": "Autonomous AI research agents and their role in scientific discovery",
      },
    });
  });

  app.post("/api/generation/validate-key", requireAuth, async (req, res) => {
    try {
      const { provider, apiKey } = req.body;
      if (!provider || !apiKey) {
        return res.status(400).json({ error: "Provider and API key are required." });
      }
      const result = await validateApiKey(provider, apiKey);
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ error: "Validation failed." });
    }
  });

  app.delete("/api/generation/history", adminAuth, async (req: Request, res: Response) => {
    try {
      await storage.deleteAllLiteratureReviews();
      await storage.deleteAllEditorials();
      return res.json({ success: true });
    } catch (err: any) {
      console.error("Error clearing generation history:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/generation/rate-limit-status", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const editorialLimit = await storage.getUserRateLimit(user.id, "editorial");
      const reviewLimit = await storage.getUserRateLimit(user.id, "literature-review");
      const editorialConfig = PER_USER_PLATFORM_LIMITS["editorial"];
      const reviewConfig = PER_USER_PLATFORM_LIMITS["literature-review"];

      const now = Date.now();
      const editorialRemaining = editorialLimit
        ? (now - editorialLimit.windowStart.getTime() >= editorialConfig.windowMs
          ? editorialConfig.max
          : Math.max(0, editorialConfig.max - editorialLimit.count))
        : editorialConfig.max;
      const reviewRemaining = reviewLimit
        ? (now - reviewLimit.windowStart.getTime() >= reviewConfig.windowMs
          ? reviewConfig.max
          : Math.max(0, reviewConfig.max - reviewLimit.count))
        : reviewConfig.max;

      return res.json({
        editorial: { remaining: editorialRemaining, max: editorialConfig.max, resetAt: editorialLimit ? editorialLimit.windowStart.getTime() + editorialConfig.windowMs : null },
        "literature-review": { remaining: reviewRemaining, max: reviewConfig.max, resetAt: reviewLimit ? reviewLimit.windowStart.getTime() + reviewConfig.windowMs : null },
      });
    } catch (err: any) {
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  const reviewRateLimit = new Map<string, number>();

  app.post("/api/literature-reviews", requireAuth, async (req, res) => {
    try {
      const { projectId, agentId, researchQuestion, prompt, topic, modelProvider, modelName, providerMode, byocApiKey, orchestratorName, agentDescription, journalId } = req.body;

      const VALID_PROVIDER_MODES = ["platform", "byoc"];
      const VALID_PROVIDERS = ["openai", "anthropic", "openrouter"];
      if (providerMode && !VALID_PROVIDER_MODES.includes(providerMode)) {
        return res.status(400).json({ error: `Invalid providerMode. Must be one of: ${VALID_PROVIDER_MODES.join(", ")}` });
      }
      if (modelProvider && !VALID_PROVIDERS.includes(modelProvider)) {
        return res.status(400).json({ error: `Invalid modelProvider. Must be one of: ${VALID_PROVIDERS.join(", ")}` });
      }

      const PLATFORM_ACCESS_EMAILS = ["jevans@uchicago.edu", "sacharaoult@gmail.com", "akozlo@uchicago.edu"];
      const user = (req as any).user;
      const isPlatform = providerMode !== "byoc";

      if (isPlatform && !PLATFORM_ACCESS_EMAILS.includes(user.email)) {
        return res.status(403).json({ error: "Platform model access is restricted to institute members. Please use Bring Your Own Key mode." });
      }

      if (isPlatform) {
        if (!process.env.OPENROUTER_API_KEY) {
          return res.status(503).json({ error: "Literature review generation is not configured. OPENROUTER_API_KEY is missing." });
        }
        const limitConfig = PER_USER_PLATFORM_LIMITS["literature-review"];
        const rateCheck = await storage.checkAndIncrementRateLimit(user.id, "literature-review", limitConfig.max, limitConfig.windowMs);
        if (!rateCheck.allowed) {
          return res.status(429).json({ error: `Review generation limit reached (${limitConfig.max} per 24 hours). Try again later.` });
        }
      }

      if (providerMode === "byoc") {
        if (!byocApiKey) {
          return res.status(400).json({ error: "BYOC mode requires an API key." });
        }
        const keyValidation = await validateApiKey(modelProvider || "openrouter", byocApiKey);
        if (!keyValidation.valid) {
          return res.status(400).json({ error: keyValidation.error || "Invalid BYOC API key." });
        }
        await storeEphemeralKey(user.id, modelProvider || "openrouter", byocApiKey);
      }

      const clientIp = req.ip || "unknown";
      const lastRequest = reviewRateLimit.get(clientIp) || 0;
      if (Date.now() - lastRequest < 30000) {
        return res.status(429).json({ error: "Please wait at least 30 seconds between review requests." });
      }
      reviewRateLimit.set(clientIp, Date.now());

      const defaultPrompt = (agentId && agentId.includes("aLR")) ? DEFAULT_ALR_PROMPT : DEFAULT_BLR_PROMPT;
      const rawAgentId = agentId && agentId.includes("MachInstit") ? (agentId.includes("aLR") ? "aLR" : "bLR") : (agentId || "bLR");
      const effectiveOrchestratorName = orchestratorName || buildConventionName(modelName || "", rawAgentId);
      const effectiveTopic = topic || "Autonomous AI research agents and their role in scientific discovery";

      const modelConfig: ModelProviderConfig = {
        providerMode: (providerMode === "byoc" ? "byoc" : "platform") as "platform" | "byoc",
        provider: modelProvider || "openrouter",
        modelName: modelName || "",
        apiKey: providerMode === "byoc" ? byocApiKey : undefined,
      };

      const result = insertLiteratureReviewSchema.safeParse({
        projectId,
        agentId: agentId || effectiveOrchestratorName,
        researchQuestion: researchQuestion || effectiveTopic,
        prompt: prompt || defaultPrompt,
        topic: effectiveTopic,
        userId: user?.id || null,
        orchestratorName: effectiveOrchestratorName,
        agentDescription: agentDescription || null,
        modelProvider: modelConfig.provider,
        modelName: resolveModelName(modelConfig),
        providerMode: modelConfig.providerMode,
      });

      if (!result.success) {
        const message = fromZodError(result.error).message;
        return res.status(400).json({ error: message });
      }

      const review = await storage.createLiteratureReview(result.data);

      res.status(201).json(review);

      const accessToken = await getAccessTokenForUser(req);

      const effectiveJournalId = journalId && INITIATIVE_DOC_IDS[journalId] ? journalId : "mirror";
      generateLiteratureReview(review.id, { ...result.data, topic: effectiveTopic, userId: user.id, journalId: effectiveJournalId }, modelConfig, accessToken).catch(err => {
        console.error("Background review generation failed:", err);
      });
    } catch (err: any) {
      console.error("Error creating literature review:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/literature-reviews", async (req, res) => {
    try {
      const projectId = req.query.projectId as string | undefined;
      const reviews = projectId
        ? await storage.getLiteratureReviewsByProject(projectId)
        : await storage.getAllLiteratureReviews();
      return res.json(reviews);
    } catch (err: any) {
      console.error("Error fetching literature reviews:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/initiative-publications", async (req, res) => {
    try {
      const PAGE_SIZE = 25;
      const INITIATIVE = "efyjiy34s5lgbx2gr50k5h9l";
      const BASE = "https://future-science.org/api/v1";
      let page = 1;
      let pageCount = 1;
      const all: unknown[] = [];
      while (page <= pageCount) {
        const url = `${BASE}/public/contributions?filters[initiative]=${INITIATIVE}&pagination[pageSize]=${PAGE_SIZE}&pagination[page]=${page}&sort[0]=publishedAt:desc`;
        const response = await fetch(url);
        if (!response.ok) break;
        const data = await response.json() as { data?: unknown[]; meta?: { pagination?: { pageCount?: number } } };
        const items = data?.data || [];
        all.push(...items);
        pageCount = data?.meta?.pagination?.pageCount || 1;
        page++;
      }
      return res.json({ data: all });
    } catch (err: any) {
      console.error("Error fetching initiative publications:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/initiative-publications/sync", requireAuth, async (req, res) => {
    try {
      const PAGE_SIZE = 25;
      const INITIATIVE = "efyjiy34s5lgbx2gr50k5h9l";
      const BASE = "https://future-science.org/api/v1";
      type Contrib = { title?: string; subtitle?: string; author?: { firstName?: string; lastName?: string } | { firstName?: string; lastName?: string }[] };
      let page = 1;
      let pageCount = 1;
      let synced = 0;

      while (page <= pageCount) {
        const url = `${BASE}/public/contributions?filters[initiative]=${INITIATIVE}&pagination[pageSize]=${PAGE_SIZE}&pagination[page]=${page}&sort[0]=publishedAt:desc`;
        const response = await fetch(url);
        if (!response.ok) break;
        const data = await response.json() as { data?: Contrib[]; meta?: { pagination?: { pageCount?: number } } };
        const contributions = data?.data || [];
        pageCount = data?.meta?.pagination?.pageCount || 1;
        page++;

        for (const contrib of contributions) {
          const authors = Array.isArray(contrib.author)
            ? contrib.author
            : contrib.author
            ? [contrib.author]
            : [];
          const firstAuthor = authors[0];
          const source = firstAuthor
            ? `${firstAuthor.firstName || ""} ${firstAuthor.lastName || ""}`.trim() || "FutureScience"
            : "FutureScience";
          const agentId = firstAuthor?.lastName || "sync";
          const title = contrib.subtitle
            ? `${contrib.title || ""}: ${contrib.subtitle}`
            : contrib.title || "Untitled";

          await storage.createResearchEvent({
            source,
            agentId,
            phase: "publication-sync",
            message: `Published on Future Science: "${title}"`,
          });
          synced++;
        }
      }

      return res.json({ synced });
    } catch (err: any) {
      console.error("Error syncing initiative publications:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/literature-reviews/:id", async (req, res) => {
    try {
      const review = await storage.getLiteratureReviewById(req.params.id);
      if (!review) {
        return res.status(404).json({ error: "Literature review not found" });
      }
      return res.json(review);
    } catch (err: any) {
      console.error("Error fetching literature review:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  function sanitizeHtml(html: string): string {
    const window = new JSDOM("").window;
    const purify = DOMPurify(window as any);
    return purify.sanitize(html, {
      ALLOWED_TAGS: ["h1", "h2", "h3", "h4", "p", "br", "hr", "strong", "em", "ul", "ol", "li", "blockquote", "a"],
      ALLOWED_ATTR: ["href", "target", "rel"],
    });
  }

  function markdownToHtml(text: string): string {
    const lines = text.split("\n");
    const htmlLines: string[] = [];
    let listType: "ul" | "ol" | null = null;

    function closeList() {
      if (listType) { htmlLines.push(`</${listType}>`); listType = null; }
    }

    function inlineFormat(s: string): string {
      return s
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>");
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        closeList();
        continue;
      }
      if (trimmed.startsWith("# ")) { closeList(); htmlLines.push(`<h1>${inlineFormat(trimmed.slice(2))}</h1>`); }
      else if (trimmed.startsWith("## ")) { closeList(); htmlLines.push(`<h2>${inlineFormat(trimmed.slice(3))}</h2>`); }
      else if (trimmed.startsWith("### ")) { closeList(); htmlLines.push(`<h3>${inlineFormat(trimmed.slice(4))}</h3>`); }
      else if (trimmed.startsWith("#### ")) { closeList(); htmlLines.push(`<h4>${inlineFormat(trimmed.slice(5))}</h4>`); }
      else if (trimmed.startsWith("---")) { closeList(); htmlLines.push("<hr>"); }
      else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        if (listType !== "ul") { closeList(); htmlLines.push("<ul>"); listType = "ul"; }
        htmlLines.push(`<li>${inlineFormat(trimmed.slice(2))}</li>`);
      } else if (/^(?:\[?\d+[\].)]\s|[a-zA-Z][).]\s)/.test(trimmed)) {
        if (listType !== "ol") { closeList(); htmlLines.push("<ol>"); listType = "ol"; }
        let content = trimmed.replace(/^(?:\[?\d+[\].)]\s*|[a-zA-Z][).]\s*)/, "");
        htmlLines.push(`<li>${inlineFormat(content)}</li>`);
      } else {
        closeList();
        htmlLines.push(`<p>${inlineFormat(trimmed)}</p>`);
      }
    }
    closeList();
    return htmlLines.join("\n");
  }

  async function getAccessTokenForUser(req: Request): Promise<string | null> {
    try {
      const sessionId = req.cookies?.session_id;
      if (!sessionId) return null;
      const { oauthSessions } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const { db } = await import("./db");
      const [session] = await db.select().from(oauthSessions).where(eq(oauthSessions.id, sessionId)).limit(1);
      return session?.accessToken || null;
    } catch {
      return null;
    }
  }

  async function generateLiteratureReview(
    reviewId: string,
    data: { projectId: string; agentId: string; researchQuestion: string; prompt: string; topic?: string; orchestratorName?: string | null; agentDescription?: string | null; userId?: string; journalId?: string },
    modelConfig?: ModelProviderConfig,
    accessToken?: string | null,
  ) {
    const lrAgentId = data.agentId;
    const LR_SOURCE = buildConventionName(modelConfig?.modelName || "", lrAgentId);

    async function emitLREvent(phase: string, message: string) {
      try {
        await storage.createResearchEvent({ source: LR_SOURCE, agentId: lrAgentId, phase, message });
        console.log(`[LR ${reviewId}] Event emitted — phase=${phase} source=${LR_SOURCE} agentId=${lrAgentId}`);
      } catch (e) {
        console.error(`[LR ${reviewId}] Failed to emit research event phase=${phase}:`, e);
      }
    }

    try {
      await storage.updateLiteratureReview(reviewId, { status: "generating" });
      await emitLREvent("initialization", `Literature review started for: "${data.researchQuestion}"`);

      const projectPapersData = await storage.getProjectPapers(data.projectId);

      const lrJournalId = data.journalId || "mirror";
      const lrInitiativeDocId = INITIATIVE_DOC_IDS[lrJournalId];

      let fsAbstracts: FutureScienceAbstract[] = [];
      let fsKeywords: string[] = [];
      try {
        const fsData = await fetchAbstractsAndKeywords([], lrInitiativeDocId);
        fsAbstracts = fsData.abstracts;
        fsKeywords = fsData.allKeywords;
      } catch (err) {
        console.error("Future Science data retrieval failed (non-fatal):", err);
      }

      const { relevant: relevantFS, other: otherFS } = scoreRelevance(fsAbstracts, data.researchQuestion);
      await emitLREvent("paper-fetch", `Fetched ${fsAbstracts.length} paper(s) from Future Science (${relevantFS.length} topic-relevant, ${otherFS.length} other) and ${projectPapersData.length} from project log.`);

      const MAX_RELEVANT_PAPERS = 60;
      const MAX_BACKGROUND_PAPERS = 20;

      const existingTitles = new Set(projectPapersData.map(p => p.title));
      const relevantPapers = [
        ...projectPapersData.map(p => ({ title: p.title, authors: p.authors, date: p.date, abstract: p.description })),
        ...relevantFS.filter(a => !existingTitles.has(a.title)).slice(0, MAX_RELEVANT_PAPERS).map(a => ({ title: a.title, authors: a.authors, date: a.date, abstract: a.abstract })),
      ];
      const backgroundPapers = otherFS
        .filter(a => !existingTitles.has(a.title))
        .slice(0, MAX_BACKGROUND_PAPERS)
        .map(a => ({ title: a.title, authors: a.authors, date: a.date, abstract: a.abstract }));

      const allPaperSources = [...relevantPapers, ...backgroundPapers];

      const clusters = clusterByKeywords(fsAbstracts);
      let clusterText = "";
      if (clusters.size > 0) {
        const clusterEntries = Array.from(clusters.entries()).map(([keyword, papers]) =>
          `Cluster "${keyword}" (${papers.length} papers): ${papers.map(p => p.title).join("; ")}`
        );
        clusterText = `\n\nIdentified topic clusters from the corpus:\n${clusterEntries.join("\n")}`;
      }

      const trendsAnalysis = extractTrendsAndGaps(fsAbstracts);
      await emitLREvent("trend-analysis", `Clustered corpus into ${clusters.size} topic cluster(s) and extracted trend/gap analysis.`);

      const searchTerms = data.researchQuestion.split(/\s+/).filter(w => w.length > 4).slice(0, 6).join(" ");
      console.log(`Literature review ${reviewId}: arXiv retrieval for "${searchTerms}"`);
      await emitLREvent("arxiv-search", `Searching arXiv for recent papers matching: "${searchTerms}"`);
      const arxivResults = await searchArxiv(searchTerms);
      await emitLREvent("arxiv-search", `arXiv search returned ${arxivResults.length} result(s).`);
      const arxivTexts = arxivResults.length > 0
        ? arxivResults.map((r, i) =>
            `External arXiv Paper ${i + 1}:\narXiv ID: ${r.arxivId}\nTitle: ${r.title}\nAuthors: ${r.authors}\nDate: ${r.published}\nSummary: ${r.summary}`
          ).join("\n\n")
        : "";

      if (allPaperSources.length === 0 && arxivResults.length === 0) {
        await emitLREvent("failure", "No papers found in the project log, Future Science, or arXiv. Cannot generate literature review.");
        await storage.updateLiteratureReview(reviewId, {
          status: "failed",
          contentHtml: `<p>No papers found in the project log, Future Science, or arXiv. Add papers or try a different research question.</p>`,
        });
        return;
      }

      const relevantTexts = relevantPapers.map((p, i) =>
        `Paper ${i + 1}:\nTitle: ${p.title}\nAuthors: ${p.authors}\nDate: ${p.date}\nAbstract/Summary: ${p.abstract}`
      );
      const backgroundTexts = backgroundPapers.map((p, i) =>
        `Paper ${relevantPapers.length + i + 1}:\nTitle: ${p.title}\nAuthors: ${p.authors}\nDate: ${p.date}\nAbstract/Summary: ${p.abstract}`
      );

      const config = modelConfig || { providerMode: "platform" as const, provider: "openrouter", modelName: "deepseek/deepseek-chat" };
      if (config.providerMode === "byoc" && !config.apiKey && data.userId) {
        const storedKey = getEphemeralKey(data.userId, config.provider);
        if (storedKey) config.apiKey = storedKey;
      }
      const model = resolveModelName(config);

      const systemPrompt = data.prompt;
      let papersSection = "";
      if (relevantTexts.length > 0) {
        papersSection += `\n\nPAPERS DIRECTLY RELEVANT TO YOUR RESEARCH QUESTION (these must be prioritized in the review):\n\n${relevantTexts.join("\n\n---\n\n")}`;
      }
      if (backgroundTexts.length > 0) {
        papersSection += `\n\n---\n\nADDITIONAL PAPERS FROM THE JOURNAL CORPUS (use these for broader context if relevant):\n\n${backgroundTexts.join("\n\n---\n\n")}`;
      }
      const userMessage = `Research question: ${data.researchQuestion}${data.topic ? `\nTopic: ${data.topic}` : ""}${clusterText}${trendsAnalysis ? `\n\nCorpus trends and gaps analysis:\n${trendsAnalysis}` : ""}${papersSection}${arxivTexts ? `\n\n---\n\nRecent external research from arXiv:\n\n${arxivTexts}` : ""}`;

      const promptTrace = JSON.stringify({
        systemPrompt,
        userMessage,
        model,
        provider: config.provider,
        providerMode: config.providerMode,
        paperCount: allPaperSources.length,
        timestamp: new Date().toISOString(),
      });

      const sourceTrace = JSON.stringify({
        projectPapers: projectPapersData.map(p => ({ title: p.title, authors: p.authors, sourceDocumentId: p.sourceDocumentId })),
        futureScienceAbstracts: fsAbstracts.map(a => ({ title: a.title, documentId: a.documentId, authors: a.authors })),
        futureScienceKeywords: fsKeywords,
        clusters: Array.from(clusters.entries()).map(([keyword, papers]) => ({ keyword, paperTitles: papers.map(p => p.title) })),
        arxivResults: arxivResults.map(r => ({ arxivId: r.arxivId, title: r.title, authors: r.authors })),
      });

      await storage.updateLiteratureReview(reviewId, { promptTrace, sourceTrace });

      await emitLREvent("llm-start", `Calling LLM (${model}) to synthesize literature review from ${allPaperSources.length} paper(s) and ${arxivResults.length} arXiv result(s).`);
      const generationResult = await generateWithConfig(config, systemPrompt, userMessage, {
        maxTokens: 12000,
        temperature: 0.3,
      });
      await emitLREvent("llm-complete", `LLM synthesis complete. Formatting and saving review.`);

      const reviewText = generationResult.content;
      const rawHtml = markdownToHtml(reviewText);
      const safeHtml = sanitizeHtml(rawHtml);

      const updates: Partial<LiteratureReview> = {
        contentHtml: safeHtml,
        status: "completed",
        completedAt: new Date(),
      };

      if (!process.env.FUTURE_SCIENCE_API_KEY) {
        console.warn(`Literature review ${reviewId}: FUTURE_SCIENCE_API_KEY not set — skipping Future Science submission.`);
        await emitLREvent("fs-submission-skipped", "Future Science submission skipped: FUTURE_SCIENCE_API_KEY is not configured.");
      } else {
        try {
          const subResult = await submitLiteratureReviewToFutureScience({
            title: `Literature Review: ${data.researchQuestion}`,
            markdownContent: reviewText,
            abstract: `A literature review on: ${data.researchQuestion}. Generated by ${data.orchestratorName || data.agentId}.`,
            keywords: fsKeywords.slice(0, 5).concat(["literature review", "AI research"]),
            agentName: buildConventionName(data.modelName || "", data.agentId || "bLR"),
            orchestratorName: data.orchestratorName,
            agentDescription: data.agentDescription,
          });

          if (subResult) {
            updates.publishedDocumentId = subResult.documentId;
            await emitLREvent("fs-submission-success", `Literature review submitted to Future Science successfully. Document ID: ${subResult.documentId}`);
            console.log(`Literature review ${reviewId} submitted to Future Science: ${subResult.documentId}`);
          } else {
            await emitLREvent("fs-submission-failed", "Future Science submission failed (non-fatal). Check server logs for details.");
          }
        } catch (err) {
          console.error("Future Science submission failed (non-fatal):", err);
          const errMsg = err instanceof Error ? err.message : "Unknown error";
          await emitLREvent("fs-submission-failed", `Future Science submission failed: ${errMsg}`);
        }
      }

      await storage.updateLiteratureReview(reviewId, updates);
      await emitLREvent("completed", `Literature review published successfully: "${data.researchQuestion}"`);

      console.log(`Literature review ${reviewId} completed successfully.`);
    } catch (err: any) {
      console.error(`Literature review ${reviewId} generation failed:`, err);
      const safeError = (err.message || "Unknown error").replace(/[<>&"']/g, "");
      await emitLREvent("failure", `Literature review generation failed: ${safeError}`);
      await storage.updateLiteratureReview(reviewId, {
        status: "failed",
        contentHtml: `<p>Generation failed: ${safeError}</p>`,
      });
    }
  }

  const DEFAULT_EDITORIAL_PROMPT = `You are a senior editorial writer for a high-level scientific journal. Your task is to write an editorial/op-ed article that synthesizes recent research and identifies why a given topic is currently important for the scientific community.

You will receive:

A list of academic papers (title, abstract, sometimes excerpts).

A research topic or question.

A list of recent arXiv trends or hot topics relevant to this field.

Your goal is to produce an editorial that:

• Explains the scientific context of the topic
• Synthesizes the main contributions of the provided papers
• Connects them to emerging trends visible in arXiv research activity
• Identifies the larger intellectual stakes and future directions

Method

Follow these steps internally before writing:

Extract the key claims, methods, and results from each paper.

Identify common themes, tensions, or paradigm shifts across the papers.

Compare these themes with the listed arXiv hot topics.

Determine why the field is currently experiencing increased attention.

Identify open questions, unresolved debates, or promising research directions.

Output

Write a 1,200–1,800 word editorial article structured as follows:

IMPORTANT FORMATTING RULES:
- Do NOT include structural labels like "Title:", "Opening (Hook)", "Scientific Background", "Recent Advances", "Why Now?", "Implications", or "Future Directions" as headings or labels. Write the editorial as a flowing article without these scaffolding markers.
- Start with a single markdown heading (# Title) for the title, then write the body as continuous prose. You may use ## subheadings only for the "References" section at the end.
- Do NOT use **bold** markers around the title.
- NEVER truncate the References section. List ALL cited papers completely. Do not write "[Full list truncated for brevity]" or similar — always include every single reference.

The article should follow this internal structure (but do NOT label these sections):

1. Start with a concise, provocative title as a single # heading.
2. Open with a short paragraph explaining why this research area is suddenly important.
3. Explain the field and the core problem in accessible but precise terms.
4. Discuss the contributions of the provided papers and how they push the field forward.
5. Explain how these papers relate to emerging arXiv trends and broader developments.
6. Describe the potential impact on science, technology, or theory.
7. Highlight the most promising research questions and challenges.

CRITICAL RULES ON REFERENCES (Chicago Author-Date Style):

1. You may ONLY cite papers that are explicitly provided to you. Do NOT invent, fabricate, or hallucinate any reference, author name, date, or paper title under any circumstances.
2. Every paper you cite in the text MUST appear in the References section. Every paper listed in the References section MUST be cited at least once in the text.
3. INLINE CITATIONS: Use Chicago author-date style with the actual author/agent name from the paper. Format: (Author, Date). Example: (MachinePsyKw DS32E-N1, 2026). When the same author has multiple papers from the same year, distinguish them with letters: (MachinePsyKw DS32E-N1, 2026a), (MachinePsyKw DS32E-N1, 2026b), etc.
4. For arXiv papers, cite inline as (Author et al., Date) or (arXiv: ID) if author is unknown.
5. BIBLIOGRAPHY: In the References section, use full Chicago style including the journal/source. Format:
   - For Machine Institute papers: Author. Date. "Full Paper Title." *Mirror: An Automated Journal of AI Interpretability*, future-science.org.
   - For arXiv papers: Author(s). Date. "Full Paper Title." arXiv: ID.
6. After writing the editorial, perform a SELF-CHECK: verify that every inline citation matches a real provided paper and that no reference was invented. Remove any citation that cannot be traced to a provided paper.

Style guidelines

• Write like a Nature / Science editorial
• Analytical and synthetic rather than descriptive
• Avoid listing papers one by one; integrate them into a narrative
• Maintain scientific accuracy while keeping the text readable
• Cite papers in parentheses using author and year

## References
List every cited paper in Chicago author-date bibliography format:
- For Machine Institute papers: Author. Date. "Full Paper Title." *Mirror: An Automated Journal of AI Interpretability*, future-science.org.
- For arXiv papers: Author(s). Date. "Full Paper Title." arXiv: ID.`;

  app.get("/api/editorials/default-prompt", (_req, res) => {
    res.json({ prompt: DEFAULT_EDITORIAL_PROMPT });
  });

  app.get("/api/editorials/status", optionalAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      if (!user) {
        const limitConfig = PER_USER_PLATFORM_LIMITS["editorial"];
        return res.json({ remaining: limitConfig.max, resetAt: null, count: 0 });
      }
      const limitConfig = PER_USER_PLATFORM_LIMITS["editorial"];
      const currentLimit = await storage.getUserRateLimit(user.id, "editorial");
      if (!currentLimit) {
        return res.json({ remaining: limitConfig.max, resetAt: null, count: 0 });
      }
      const elapsed = Date.now() - currentLimit.windowStart.getTime();
      if (elapsed >= limitConfig.windowMs) {
        return res.json({ remaining: limitConfig.max, resetAt: null, count: 0 });
      }
      return res.json({
        remaining: Math.max(0, limitConfig.max - currentLimit.count),
        resetAt: currentLimit.windowStart.getTime() + limitConfig.windowMs,
        count: currentLimit.count,
      });
    } catch (err: any) {
      console.error("Error getting editorial status:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/editorials", async (req, res) => {
    const apiKey = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
    if (!apiKey || apiKey !== process.env.RESEARCH_API_KEY) {
      return res.status(401).json({ error: "Unauthorized. Provide a valid API key via X-API-Key header or Bearer token." });
    }
    try {
      await storage.deleteAllEditorials();
      return res.json({ success: true });
    } catch (err: any) {
      console.error("Error deleting editorials:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/editorials", async (_req, res) => {
    try {
      const allEditorials = await storage.getAllEditorials();
      return res.json(allEditorials);
    } catch (err: any) {
      console.error("Error fetching editorials:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/editorials/:idOrSlug", async (req, res) => {
    try {
      const { idOrSlug } = req.params;
      let editorial = await storage.getEditorialById(idOrSlug);
      if (!editorial) {
        editorial = await storage.getEditorialBySlug(idOrSlug);
      }
      if (!editorial) {
        return res.status(404).json({ error: "Editorial not found" });
      }
      return res.json(editorial);
    } catch (err: any) {
      console.error("Error fetching editorial:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/editorials/generate", requireAuth, async (req, res) => {
    try {
      const { topic, modelProvider, modelName, providerMode, byocApiKey, orchestratorName, agentDescription, userPrompt, prompt, journalId } = req.body;

      const VALID_PROVIDER_MODES = ["platform", "byoc"];
      const VALID_PROVIDERS = ["openai", "anthropic", "openrouter"];
      if (providerMode && !VALID_PROVIDER_MODES.includes(providerMode)) {
        return res.status(400).json({ error: `Invalid providerMode. Must be one of: ${VALID_PROVIDER_MODES.join(", ")}` });
      }
      if (modelProvider && !VALID_PROVIDERS.includes(modelProvider)) {
        return res.status(400).json({ error: `Invalid modelProvider. Must be one of: ${VALID_PROVIDERS.join(", ")}` });
      }

      const PLATFORM_ACCESS_EMAILS = ["jevans@uchicago.edu", "sacharaoult@gmail.com", "akozlo@uchicago.edu"];
      const user = (req as any).user;
      const isPlatform = providerMode !== "byoc";

      if (isPlatform && !PLATFORM_ACCESS_EMAILS.includes(user.email)) {
        return res.status(403).json({ error: "Platform model access is restricted to institute members. Please use Bring Your Own Key mode." });
      }

      if (isPlatform) {
        if (!process.env.OPENROUTER_API_KEY) {
          return res.status(503).json({ error: "Editorial generation is not configured. OPENROUTER_API_KEY is missing." });
        }
        const limitConfig = PER_USER_PLATFORM_LIMITS["editorial"];
        const rateCheck = await storage.checkAndIncrementRateLimit(user.id, "editorial", limitConfig.max, limitConfig.windowMs);
        if (!rateCheck.allowed) {
          return res.status(429).json({
            error: `Editorial generation limit reached (${limitConfig.max} per 24 hours). Try again later.`,
          });
        }
      }

      if (providerMode === "byoc") {
        if (!byocApiKey) {
          return res.status(400).json({ error: "BYOC mode requires an API key." });
        }
        const keyValidation = await validateApiKey(modelProvider || "openrouter", byocApiKey);
        if (!keyValidation.valid) {
          return res.status(400).json({ error: keyValidation.error || "Invalid BYOC API key." });
        }
        await storeEphemeralKey(user.id, modelProvider || "openrouter", byocApiKey);
      }

      const effectiveOrchestratorName = orchestratorName || buildConventionName(modelName || "", "O");
      const effectiveTopic = topic || "Recent developments in AI agent-driven scientific research, machine psychology, and autonomous experimentation";

      const modelConfig: ModelProviderConfig = {
        providerMode: (providerMode === "byoc" ? "byoc" : "platform") as "platform" | "byoc",
        provider: modelProvider || "openrouter",
        modelName: modelName || "",
        apiKey: providerMode === "byoc" ? byocApiKey : undefined,
      };

      const slug = "editorial-" + Date.now().toString(36);
      const editorial = await storage.createEditorial({
        title: "Generating editorial...",
        slug,
        agentId: effectiveOrchestratorName,
        tag: "Editorial",
        topic: effectiveTopic,
        userId: user?.id || null,
        orchestratorName: effectiveOrchestratorName,
        agentDescription: agentDescription || null,
        modelProvider: modelConfig.provider,
        modelName: resolveModelName(modelConfig),
        providerMode: modelConfig.providerMode,
        userPrompt: userPrompt || null,
      });

      res.status(201).json(editorial);

      const accessToken = await getAccessTokenForUser(req);

      const effectiveEditorialJournalId = journalId && INITIATIVE_DOC_IDS[journalId] ? journalId : "mirror";
      generateEditorial(editorial.id, modelConfig, effectiveTopic, userPrompt || null, prompt || null, accessToken, effectiveEditorialJournalId).catch(err => {
        console.error("Background editorial generation failed:", err);
      });
    } catch (err: any) {
      console.error("Error creating editorial:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  async function searchArxiv(query: string): Promise<Array<{ title: string; summary: string; authors: string; published: string; arxivId: string }>> {
    try {
      const encodedQuery = encodeURIComponent(query);
      const url = `http://export.arxiv.org/api/query?search_query=all:${encodedQuery}&start=0&max_results=10&sortBy=submittedDate&sortOrder=descending`;
      const response = await fetch(url);
      if (!response.ok) {
        console.error(`arXiv API returned ${response.status}`);
        return [];
      }
      const xml = await response.text();
      const entries: Array<{ title: string; summary: string; authors: string; published: string; arxivId: string }> = [];
      const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
      let match;
      while ((match = entryRegex.exec(xml)) !== null) {
        const entry = match[1];
        const idMatch = entry.match(/<id>([\s\S]*?)<\/id>/);
        const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
        const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
        const publishedMatch = entry.match(/<published>([\s\S]*?)<\/published>/);
        const authorMatches = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)];
        const rawId = (idMatch?.[1] || "").trim();
        const arxivId = rawId.replace("http://arxiv.org/abs/", "").replace(/v\d+$/, "");
        entries.push({
          title: (titleMatch?.[1] || "").trim().replace(/\s+/g, " "),
          summary: (summaryMatch?.[1] || "").trim().replace(/\s+/g, " ").substring(0, 500),
          authors: authorMatches.map(m => m[1].trim()).join(", "),
          published: (publishedMatch?.[1] || "").trim().substring(0, 10),
          arxivId,
        });
      }
      return entries;
    } catch (err) {
      console.error("arXiv search failed:", err);
      return [];
    }
  }

  async function generateEditorial(
    editorialId: string,
    modelConfig?: ModelProviderConfig,
    topic?: string,
    userPrompt?: string | null,
    editablePrompt?: string | null,
    accessToken?: string | null,
    journalId?: string,
  ) {
    const ED_SOURCE = "Editorial";

    async function emitEDEvent(agentId: string, phase: string, message: string) {
      try {
        await storage.createResearchEvent({ source: ED_SOURCE, agentId, phase, message });
      } catch (e) {
        console.error("Failed to emit editorial research event:", e);
      }
    }

    try {
      await storage.updateEditorial(editorialId, { status: "generating" });

      const editorialRecord = await storage.getEditorialById(editorialId);
      const edAgentId = editorialRecord?.agentId || "editorial-agent";

      await emitEDEvent(edAgentId, "initialization", `Editorial generation started${topic ? ` for topic: "${topic}"` : ""}.`);

      const allPapers = await storage.getAllProjectPapers();
      const allReviews = await storage.getAllLiteratureReviews();
      const completedReviews = allReviews.filter(r => r.status === "completed" && r.contentHtml);

      const existingEditorials = await storage.getAllEditorials();
      const previousEditorials = existingEditorials
        .filter(e => e.status === "completed" && e.id !== editorialId && e.contentHtml)
        .map(e => ({
          title: e.title,
          excerpt: e.excerpt || "",
        }));

      const edJournalId = journalId || "mirror";
      const edInstitutions = INITIATIVE_INSTITUTIONS[edJournalId] || ["Machine Institute"];
      const edInitiativeDocId = INITIATIVE_DOC_IDS[edJournalId];

      let fsAbstracts: FutureScienceAbstract[] = [];
      try {
        const fsData = await fetchAbstractsAndKeywords(edInstitutions, edInitiativeDocId);
        fsAbstracts = fsData.abstracts;
      } catch (err) {
        console.error("Future Science data retrieval for editorial failed (non-fatal):", err);
      }

      const allPaperSources = [
        ...allPapers.map(p => ({ title: p.title, authors: p.authors, date: p.date, description: p.description })),
        ...fsAbstracts.filter(a => !allPapers.some(p => p.title === a.title)).map(a => ({ title: a.title, authors: a.authors, date: a.date, description: a.abstract })),
      ];

      await emitEDEvent(edAgentId, "context-building", `Gathered ${allPaperSources.length} paper(s) (${allPapers.length} project, ${fsAbstracts.length} FS).`);
      await emitEDEvent(edAgentId, "review-loading", `Loaded ${completedReviews.length} completed literature review(s) and ${previousEditorials.length} previously published editorial(s) for context.`);

      if (allPaperSources.length === 0) {
        await emitEDEvent(edAgentId, "failure", "No papers found in the publication log or Future Science. Cannot generate editorial.");
        await storage.updateEditorial(editorialId, {
          status: "failed",
          title: "Editorial generation failed",
          contentHtml: `<p>No papers found in the publication log or Future Science. Papers must be published before an editorial can be generated.</p>`,
        });
        return;
      }

      const paperTexts = allPaperSources.map((p, i) =>
        `Paper ${i + 1}:\nTitle: ${p.title}\nAuthors: ${p.authors}\nDate: ${p.date}\nAbstract/Summary: ${p.description}`
      );

      const reviewTexts = completedReviews.map((r, i) => {
        let plainContent = "";
        if (r.contentHtml) {
          plainContent = r.contentHtml
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .substring(0, 2000);
        }
        return `Literature Review ${i + 1}:\nResearch Question: ${r.researchQuestion}\nAgent: ${r.agentId}\nDate: ${r.createdAt?.toISOString().split("T")[0] || "unknown"}\nFindings:\n${plainContent || "No content available."}`;
      });

      const trendsAnalysis = extractTrendsAndGaps(fsAbstracts);

      const topicKeywords: string[] = [];
      for (const p of allPaperSources.slice(0, 10)) {
        const words = p.title.split(/\s+/).filter(w => w.length > 4);
        topicKeywords.push(...words.slice(0, 3));
      }
      const searchQuery = [...new Set(topicKeywords)].slice(0, 8).join(" ");

      console.log(`Editorial ${editorialId}: Searching arXiv for "${searchQuery}"`);
      await emitEDEvent(edAgentId, "arxiv-search", `Searching arXiv for hot topics matching: "${searchQuery}"`);
      const arxivResults = await searchArxiv(searchQuery);
      await emitEDEvent(edAgentId, "arxiv-search", `arXiv search returned ${arxivResults.length} hot-topic result(s).`);

      const arxivTexts = arxivResults.length > 0
        ? arxivResults.map((r, i) =>
            `arXiv Paper ${i + 1}:\narXiv ID: ${r.arxivId}\nTitle: ${r.title}\nAuthors: ${r.authors}\nDate: ${r.published}\nSummary: ${r.summary}`
          ).join("\n\n")
        : "No recent arXiv papers found for the current research topics.";

      const config = modelConfig || { providerMode: "platform" as const, provider: "openrouter", modelName: "deepseek/deepseek-chat" };
      if (config.providerMode === "byoc" && !config.apiKey) {
        const editorialForKey = await storage.getEditorialById(editorialId);
        if (editorialForKey?.userId) {
          const storedKey = getEphemeralKey(editorialForKey.userId, config.provider);
          if (storedKey) config.apiKey = storedKey;
        }
      }
      const model = resolveModelName(config);

      const effectiveTopic = topic || "Recent developments in AI agent-driven scientific research, machine psychology, and autonomous experimentation";
      const effectiveSystemPrompt = editablePrompt || DEFAULT_EDITORIAL_PROMPT;

      const userMessage = `Topic: ${effectiveTopic} — based on the institute's current publication corpus.
${userPrompt ? `\nAdditional user instructions: ${userPrompt}` : ""}
${trendsAnalysis ? `\nCorpus analysis:\n${trendsAnalysis}` : ""}

Papers from the institute's publication log:

${paperTexts.join("\n\n---\n\n")}

${reviewTexts.length > 0 ? `\nLiterature Reviews conducted by the institute:\n\n${reviewTexts.join("\n\n---\n\n")}` : ""}

Hot arXiv topics (recent publications in related fields):

${arxivTexts}

${previousEditorials.length > 0 ? `IMPORTANT — PREVIOUSLY PUBLISHED EDITORIALS (DO NOT REPEAT THESE TOPICS):
The following editorials have already been published by this journal. You MUST choose a DIFFERENT angle, topic, or thesis. Do not write about the same subject or reach the same conclusions as any of these:

${previousEditorials.map((e, i) => `${i + 1}. "${e.title}" — ${e.excerpt}`).join("\n")}

Pick a fresh perspective, a different subset of papers, or an underexplored theme from the corpus.` : ""}`;

      const promptTrace = JSON.stringify({
        systemPrompt: effectiveSystemPrompt,
        userMessage,
        model,
        provider: config.provider,
        providerMode: config.providerMode,
        paperCount: allPaperSources.length,
        reviewCount: completedReviews.length,
        arxivCount: arxivResults.length,
        topic: effectiveTopic,
        timestamp: new Date().toISOString(),
      });

      const sourceTrace = JSON.stringify({
        projectPapers: allPapers.map(p => ({ title: p.title, authors: p.authors, sourceDocumentId: p.sourceDocumentId })),
        futureScienceAbstracts: fsAbstracts.map((a: { title: string; documentId: string; authors: string }) => ({ title: a.title, documentId: a.documentId, authors: a.authors })),
        reviews: completedReviews.map(r => ({ id: r.id, researchQuestion: r.researchQuestion, agentId: r.agentId })),
        arxivResults: arxivResults.map(r => ({ title: r.title, authors: r.authors, published: r.published, arxivId: r.arxivId })),
        previousEditorials: previousEditorials.map(e => ({ title: e.title })),
      });

      await storage.updateEditorial(editorialId, { promptTrace, sourceTrace });

      console.log(`Editorial ${editorialId}: Calling LLM (${model})...`);
      await emitEDEvent(edAgentId, "llm-start", `Calling LLM (${model}) to write editorial from ${allPaperSources.length} paper(s), ${completedReviews.length} review(s), and ${arxivResults.length} arXiv result(s).`);
      const generationResult = await generateWithConfig(config, effectiveSystemPrompt, userMessage, {
        maxTokens: 10000,
        temperature: 0.4,
      });
      await emitEDEvent(edAgentId, "llm-response", `LLM response received. Processing and extracting editorial content.`);

      let editorialText = generationResult.content;

      const titleMatch = editorialText.match(/^#+\s*\*{0,2}(?:Title:\s*)?(.+?)\*{0,2}\s*$/m)
        || editorialText.match(/^\*{2}(?:Title:\s*)?(.+?)\*{2}\s*$/m)
        || editorialText.match(/^#\s+(.+)/m)
        || editorialText.match(/^(.+)\n/);
      let extractedTitle = titleMatch ? titleMatch[1].replace(/^#+\s*/, "").replace(/\*{2}/g, "").replace(/^Title:\s*/i, "").trim() : "Untitled Editorial";

      const structuralHeadings = [
        /^#+\s*\*{0,2}(?:Title[:\s])/im,
        /^#+\s*Opening\s*\(Hook\)/im,
        /^#+\s*Scientific\s+Background/im,
        /^#+\s*Recent\s+Advances/im,
        /^#+\s*Why\s+Now\??/im,
        /^#+\s*Implications/im,
        /^#+\s*Future\s+Directions/im,
      ];

      const lines = editorialText.split("\n");
      const filteredLines: string[] = [];
      let removedTitle = false;

      for (const line of lines) {
        const trimmed = line.trim();

        if (!removedTitle && (
          trimmed === extractedTitle ||
          trimmed === `# ${extractedTitle}` ||
          trimmed === `## ${extractedTitle}` ||
          trimmed === `**${extractedTitle}**` ||
          trimmed === `# **${extractedTitle}**` ||
          trimmed.replace(/^#+\s*\*{0,2}(?:Title:\s*)?/i, "").replace(/\*{0,2}$/, "").trim() === extractedTitle
        )) {
          removedTitle = true;
          continue;
        }

        let isStructural = false;
        for (const pattern of structuralHeadings) {
          if (pattern.test(trimmed)) {
            isStructural = true;
            break;
          }
        }
        if (isStructural) continue;

        filteredLines.push(line);
      }

      editorialText = filteredLines.join("\n").replace(/^\n+/, "");

      let excerptText = "";
      for (const line of filteredLines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#") && trimmed.length > 40) {
          const clean = trimmed.replace(/\*{2}/g, "").replace(/\*/g, "");
          excerptText = clean.substring(0, 200);
          if (clean.length > 200) excerptText += "...";
          break;
        }
      }

      const rawHtml = markdownToHtml(editorialText);
      const safeHtml = sanitizeHtml(rawHtml);

      const updates: Partial<EditorialRecord> = {
        title: extractedTitle,
        excerpt: excerptText || "A synthesized editorial on current research trends.",
        contentHtml: safeHtml,
        status: "completed",
        completedAt: new Date(),
      };

      if (accessToken) {
        try {
          const editorial = await storage.getEditorialById(editorialId);
          const pubResult = await publishToFutureScience({
            title: extractedTitle,
            contentHtml: safeHtml,
            abstract: excerptText || `An editorial on ${effectiveTopic || "current research trends"}.`,
            authorFirstName: (editorial?.orchestratorName || "Machine").split(" ")[0] || "Machine",
            authorLastName: (editorial?.orchestratorName || "Institute").split(" ").slice(1).join(" ") || "Institute",
            authorInstitution: "Machine Institute",
            authorEmail: "research@machine-institute.org",
            keywords: ["editorial", "AI research", "machine psychology"],
            type: "article",
            accessToken,
            initiativeSlug: "mirror-an-automated-journal-of-ai-interpretability",
            metadata: {
              orchestratorName: editorial?.orchestratorName || undefined,
              agentDescription: editorial?.agentDescription || undefined,
              promptUsed: effectiveSystemPrompt,
              topic: effectiveTopic,
              modelProvider: editorial?.modelProvider || config.provider,
              modelName: model,
              providerMode: config.providerMode,
            },
          });

          if (pubResult) {
            updates.publishedDocumentId = pubResult.documentId;
            console.log(`Editorial ${editorialId} published to Future Science: ${pubResult.documentId}`);
          }
        } catch (err) {
          console.error("Future Science editorial publication failed (non-fatal):", err);
        }
      }

      await storage.updateEditorial(editorialId, updates);
      await emitEDEvent(edAgentId, "completed", `Editorial published successfully: "${extractedTitle}"`);

      console.log(`Editorial ${editorialId} completed: "${extractedTitle}"`);
    } catch (err: any) {
      console.error(`Editorial ${editorialId} generation failed:`, err);
      const safeError = (err.message || "Unknown error").replace(/[<>&"']/g, "");
      const editorialForErr = await storage.getEditorialById(editorialId).catch(() => null);
      const errAgentId = editorialForErr?.agentId || "editorial-agent";
      await emitEDEvent(errAgentId, "failure", `Editorial generation failed: ${safeError}`);
      await storage.updateEditorial(editorialId, {
        status: "failed",
        title: "Editorial generation failed",
        contentHtml: `<p>Generation failed: ${safeError}</p>`,
      });
    }
  }

  app.get("/api/agent-members", async (_req, res) => {
    try {
      const members = await storage.getAllAgentMembers();
      return res.json(members);
    } catch (err: any) {
      console.error("Error fetching agent members:", err);
      return res.status(500).json({ error: "Failed to fetch agent members." });
    }
  });

  app.post("/api/agent-members", async (req, res) => {
    try {
      const parsed = insertAgentMemberSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: fromZodError(parsed.error).message });
      }
      const member = await storage.createAgentMember(parsed.data);
      return res.status(201).json(member);
    } catch (err: any) {
      console.error("Error creating agent member:", err);
      return res.status(500).json({ error: "Failed to create agent member." });
    }
  });

  return httpServer;
}