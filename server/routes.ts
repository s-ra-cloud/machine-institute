import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertPaperSchema, insertResearchEventSchema, insertLiteratureReviewSchema, insertProjectPaperSchema, insertEditorialSchema, insertAgentMemberSchema } from "@shared/schema";
import { fromZodError } from "zod-validation-error";
import { z } from "zod";
import path from "path";
import fs from "fs";
import OpenAI from "openai";
import { JSDOM } from "jsdom";
import DOMPurify from "dompurify";

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
      const limit = req.query.limit ? Math.max(1, parseInt(req.query.limit as string) || 500) : undefined;
      const events = since
        ? await storage.getEventsSince(new Date(since))
        : await storage.getRecentEvents(limit || 500);
      const activeEvents = await storage.getActiveEvents(10);
      const active = activeEvents.length > 0;

      return res.json({
        active,
        events: events.reverse(),
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
    "autonomous-journal-machine-psychology": "ixli00u1vnheboi9z80ml9o6",
  };

  const INITIATIVE_INSTITUTIONS: Record<string, string[]> = {
    "autonomous-journal-machine-psychology": ["Machine Institute"],
  };

  const INITIATIVE_SLUGS: Record<string, string> = {
    "autonomous-journal-machine-psychology": "autonomous-journal-of-machine-psychology",
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

  async function fetchAllContributions(institutions: string[]): Promise<any[]> {
    const PAGE_SIZE = 25;
    let page = 1;
    let all: any[] = [];
    let pageCount = 1;

    while (page <= pageCount) {
      const url = `https://future-science.org/api/v1/public/contributions?pagination[pageSize]=${PAGE_SIZE}&pagination[page]=${page}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`Future Science API returned ${resp.status} on page ${page}`);
      }
      const json = await resp.json() as any;
      const items = json?.data || [];
      pageCount = json?.meta?.pagination?.pageCount || 1;

      const filtered = items.filter((c: any) => {
        const authors = Array.isArray(c.author) ? c.author : (c.author ? [c.author] : []);
        return authors.some((a: any) =>
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

      const sourceDocIds = contributions.map((c: any) => c.documentId);
      const existing = await storage.getProjectPapersBySourceDocIds(sourceDocIds);
      const existingDocIds = new Set(existing.map(p => p.sourceDocumentId));

      const initiativeSlug = INITIATIVE_SLUGS[projectId] || "papers";
      const buildPaperUrl = (c: any) => {
        if (c.url) return c.url;
        if (c.publicUrl) return c.publicUrl;
        if (c.slug) return `https://future-science.org/${initiativeSlug}/${c.slug}`;
        if (c.documentId) return `https://future-science.org/${initiativeSlug}/${c.documentId}`;
        return null;
      };

      const newPapers = contributions
        .filter((c: any) => !existingDocIds.has(c.documentId))
        .map((c: any) => {
          const authorRaw = c.author;
          const authorArr = Array.isArray(authorRaw) ? authorRaw : (authorRaw ? [authorRaw] : []);
          const authorList = authorArr
            .map((a: any) => `${a.firstName || ""} ${a.lastName || ""}`.trim() + (a.institution ? ` (${a.institution})` : ""))
            .filter((s: string) => s.length > 0)
            .join(", ");
          return {
            projectId,
            title: c.subtitle ? `${c.title}: ${c.subtitle}` : c.title,
            description: c.abstract || "No abstract available.",
            authors: authorList || "Unknown",
            date: c.publishedAt ? c.publishedAt.split("T")[0] : new Date().toISOString().split("T")[0],
            type: (c.type || "article").toLowerCase(),
            sourceDocumentId: c.documentId,
            url: buildPaperUrl(c),
          };
        });

      if (newPapers.length > 0) {
        await storage.createProjectPapers(newPapers);
      }

      for (const c of contributions) {
        if (existingDocIds.has(c.documentId)) {
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
   Author. Date. "Full Paper Title." *Autonomous Journal of Machine Psychology*, future-science.org.
   Example: MachinePsyKw DS32E-N1. 2026a. "Dark Triad Emergence in DeepSeek Chat." *Autonomous Journal of Machine Psychology*, future-science.org.
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
Author. Date. "Full Paper Title." *Autonomous Journal of Machine Psychology*, future-science.org.

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
   Author. Date. "Full Paper Title." *Autonomous Journal of Machine Psychology*, future-science.org.
   Example: MachinePsyKw DS32E-N1. 2026a. "Dark Triad Emergence in DeepSeek Chat." *Autonomous Journal of Machine Psychology*, future-science.org.
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
Author. Date. "Full Paper Title." *Autonomous Journal of Machine Psychology*, future-science.org.

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

  const reviewRateLimit = new Map<string, number>();

  app.post("/api/literature-reviews", async (req, res) => {
    try {
      if (!process.env.OPENROUTER_API_KEY) {
        return res.status(503).json({ error: "Literature review generation is not configured. OPENROUTER_API_KEY is missing." });
      }

      const clientIp = req.ip || "unknown";
      const lastRequest = reviewRateLimit.get(clientIp) || 0;
      if (Date.now() - lastRequest < 60000) {
        return res.status(429).json({ error: "Please wait at least 1 minute between review requests." });
      }
      reviewRateLimit.set(clientIp, Date.now());

      const { projectId, agentId, researchQuestion, prompt } = req.body;

      const defaultPrompt = (agentId && agentId.includes("aLR")) ? DEFAULT_ALR_PROMPT : DEFAULT_BLR_PROMPT;
      const result = insertLiteratureReviewSchema.safeParse({
        projectId,
        agentId,
        researchQuestion,
        prompt: prompt || defaultPrompt,
      });

      if (!result.success) {
        const message = fromZodError(result.error).message;
        return res.status(400).json({ error: message });
      }

      const review = await storage.createLiteratureReview(result.data);

      res.status(201).json(review);

      generateLiteratureReview(review.id, result.data).catch(err => {
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

  async function generateLiteratureReview(reviewId: string, data: { projectId: string; agentId: string; researchQuestion: string; prompt: string }) {
    try {
      await storage.updateLiteratureReview(reviewId, { status: "generating" });

      const projectPapersData = await storage.getProjectPapers(data.projectId);

      if (projectPapersData.length === 0) {
        await storage.updateLiteratureReview(reviewId, {
          status: "failed",
          contentHtml: `<p>No papers found in the project log. Add papers to the project before requesting a literature review.</p>`,
        });
        return;
      }

      const paperTexts = projectPapersData.map((p, i) =>
        `Paper ${i + 1}:\nTitle: ${p.title}\nAuthors: ${p.authors}\nDate: ${p.date}\nAbstract/Summary: ${p.description}`
      );

      const openrouter = new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
      });

      const systemPrompt = data.prompt;
      const userMessage = `Research question: ${data.researchQuestion}\n\nThe following are the papers from the project's publication log:\n\n${paperTexts.join("\n\n---\n\n")}`;

      const completion = await openrouter.chat.completions.create({
        model: "deepseek/deepseek-chat",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_tokens: 12000,
        temperature: 0.3,
      });

      const reviewText = completion.choices[0]?.message?.content || "";
      const rawHtml = markdownToHtml(reviewText);
      const safeHtml = sanitizeHtml(rawHtml);

      await storage.updateLiteratureReview(reviewId, {
        contentHtml: safeHtml,
        status: "completed",
        completedAt: new Date(),
      });

      console.log(`Literature review ${reviewId} completed successfully.`);
    } catch (err: any) {
      console.error(`Literature review ${reviewId} generation failed:`, err);
      const safeError = (err.message || "Unknown error").replace(/[<>&"']/g, "");
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
   - For Machine Institute papers: Author. Date. "Full Paper Title." *Autonomous Journal of Machine Psychology*, future-science.org.
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
- For Machine Institute papers: Author. Date. "Full Paper Title." *Autonomous Journal of Machine Psychology*, future-science.org.
- For arXiv papers: Author(s). Date. "Full Paper Title." arXiv: ID.`;

  const EDITORIAL_RATE_LIMIT_KEY = "editorial-generation-global";
  const EDITORIAL_MAX_PER_24H = 2;
  const EDITORIAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

  async function getEditorialRateLimitStatus(): Promise<{
    remaining: number;
    resetAt: number | null;
    count: number;
  }> {
    const lastSync = await storage.getLastSyncTime(EDITORIAL_RATE_LIMIT_KEY);
    if (!lastSync) {
      return { remaining: EDITORIAL_MAX_PER_24H, resetAt: null, count: 0 };
    }

    const elapsed = Date.now() - lastSync.getTime();
    if (elapsed >= EDITORIAL_COOLDOWN_MS) {
      return { remaining: EDITORIAL_MAX_PER_24H, resetAt: null, count: 0 };
    }

    const countKey = `${EDITORIAL_RATE_LIMIT_KEY}-count`;
    const countSync = await storage.getLastSyncTime(countKey);
    const count = countSync ? countSync.getTime() : 0;

    if (count >= EDITORIAL_MAX_PER_24H) {
      return {
        remaining: 0,
        resetAt: lastSync.getTime() + EDITORIAL_COOLDOWN_MS,
        count,
      };
    }

    return {
      remaining: EDITORIAL_MAX_PER_24H - count,
      resetAt: lastSync.getTime() + EDITORIAL_COOLDOWN_MS,
      count,
    };
  }

  async function incrementEditorialCount(): Promise<void> {
    const lastSync = await storage.getLastSyncTime(EDITORIAL_RATE_LIMIT_KEY);
    const countKey = `${EDITORIAL_RATE_LIMIT_KEY}-count`;
    const elapsed = lastSync ? Date.now() - lastSync.getTime() : EDITORIAL_COOLDOWN_MS + 1;

    if (elapsed >= EDITORIAL_COOLDOWN_MS) {
      await storage.setLastSyncTime(EDITORIAL_RATE_LIMIT_KEY, new Date());
      await storage.setLastSyncTime(countKey, new Date(1));
    } else {
      const countSync = await storage.getLastSyncTime(countKey);
      const currentCount = countSync ? countSync.getTime() : 0;
      await storage.setLastSyncTime(countKey, new Date(currentCount + 1));
    }
  }

  app.get("/api/editorials/status", async (_req, res) => {
    try {
      const status = await getEditorialRateLimitStatus();
      return res.json(status);
    } catch (err: any) {
      console.error("Error getting editorial status:", err);
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

  app.post("/api/editorials/generate", async (req, res) => {
    try {
      if (!process.env.OPENROUTER_API_KEY) {
        return res.status(503).json({ error: "Editorial generation is not configured. OPENROUTER_API_KEY is missing." });
      }

      const status = await getEditorialRateLimitStatus();
      if (status.remaining <= 0) {
        const resetIn = status.resetAt ? Math.ceil((status.resetAt - Date.now()) / 60000) : 0;
        return res.status(429).json({
          error: `Editorial generation limit reached (${EDITORIAL_MAX_PER_24H} per 24 hours). Try again in ${resetIn} minutes.`,
          resetAt: status.resetAt,
        });
      }

      const slug = "editorial-" + Date.now().toString(36);
      const editorial = await storage.createEditorial({
        title: "Generating editorial...",
        slug,
        agentId: "MachInstit CS45O-N1",
        tag: "Editorial",
      });

      await incrementEditorialCount();

      res.status(201).json(editorial);

      generateEditorial(editorial.id).catch(err => {
        console.error("Background editorial generation failed:", err);
      });
    } catch (err: any) {
      console.error("Error creating editorial:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  async function searchArxiv(query: string): Promise<Array<{ title: string; summary: string; authors: string; published: string }>> {
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

  async function generateEditorial(editorialId: string) {
    try {
      await storage.updateEditorial(editorialId, { status: "generating" });

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

      if (allPapers.length === 0) {
        await storage.updateEditorial(editorialId, {
          status: "failed",
          title: "Editorial generation failed",
          contentHtml: `<p>No papers found in the publication log. Papers must be published before an editorial can be generated.</p>`,
        });
        return;
      }

      const paperTexts = allPapers.map((p, i) =>
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

      const topicKeywords: string[] = [];
      for (const p of allPapers.slice(0, 10)) {
        const words = p.title.split(/\s+/).filter(w => w.length > 4);
        topicKeywords.push(...words.slice(0, 3));
      }
      const searchQuery = [...new Set(topicKeywords)].slice(0, 8).join(" ");

      console.log(`Editorial ${editorialId}: Searching arXiv for "${searchQuery}"`);
      const arxivResults = await searchArxiv(searchQuery);

      const arxivTexts = arxivResults.length > 0
        ? arxivResults.map((r, i) =>
            `arXiv Paper ${i + 1}:\narXiv ID: ${r.arxivId}\nTitle: ${r.title}\nAuthors: ${r.authors}\nDate: ${r.published}\nSummary: ${r.summary}`
          ).join("\n\n")
        : "No recent arXiv papers found for the current research topics.";

      const openrouter = new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
      });

      const userMessage = `Topic: Recent developments in AI agent-driven scientific research, machine psychology, and autonomous experimentation — based on the institute's current publication corpus.

Papers from the institute's publication log:

${paperTexts.join("\n\n---\n\n")}

${reviewTexts.length > 0 ? `\nLiterature Reviews conducted by the institute:\n\n${reviewTexts.join("\n\n---\n\n")}` : ""}

Hot arXiv topics (recent publications in related fields):

${arxivTexts}

${previousEditorials.length > 0 ? `IMPORTANT — PREVIOUSLY PUBLISHED EDITORIALS (DO NOT REPEAT THESE TOPICS):
The following editorials have already been published by this journal. You MUST choose a DIFFERENT angle, topic, or thesis. Do not write about the same subject or reach the same conclusions as any of these:

${previousEditorials.map((e, i) => `${i + 1}. "${e.title}" — ${e.excerpt}`).join("\n")}

Pick a fresh perspective, a different subset of papers, or an underexplored theme from the corpus.` : ""}`;

      console.log(`Editorial ${editorialId}: Calling LLM...`);
      const completion = await openrouter.chat.completions.create({
        model: "deepseek/deepseek-chat",
        messages: [
          { role: "system", content: DEFAULT_EDITORIAL_PROMPT },
          { role: "user", content: userMessage },
        ],
        max_tokens: 10000,
        temperature: 0.4,
      });

      let editorialText = completion.choices[0]?.message?.content || "";

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

      await storage.updateEditorial(editorialId, {
        title: extractedTitle,
        excerpt: excerptText || "A synthesized editorial on current research trends.",
        contentHtml: safeHtml,
        status: "completed",
        completedAt: new Date(),
      });

      console.log(`Editorial ${editorialId} completed: "${extractedTitle}"`);
    } catch (err: any) {
      console.error(`Editorial ${editorialId} generation failed:`, err);
      const safeError = (err.message || "Unknown error").replace(/[<>&"']/g, "");
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