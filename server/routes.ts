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
import { publishToFutureScience, submitLiteratureReviewToFutureScience, fetchAbstractsAndKeywords, extractTrendsAndGaps, clusterByKeywords, scoreRelevance, FutureScienceFetchError, type FutureScienceAbstract, type FSContribution, type FSAuthor, type FSContributionsResponse } from "./future-science";
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface LinkifyPaper {
  title: string;
  authors?: string;
  url?: string;
}

interface LinkifyArxiv {
  title: string;
  arxivId?: string;
  url?: string;
}

function linkifyCitations(
  text: string,
  papers: LinkifyPaper[],
  arxivResults: LinkifyArxiv[]
): string {
  let out = text;

  // 1) Replace plain titles in references with markdown links.
  //    Match each paper's title when it appears in quotes (straight or curly,
  //    single or doubled) and is not already inside a markdown link.
  for (const p of papers) {
    if (!p.url || !p.title) continue;
    const escTitle = escapeRegExp(p.title);
    // Match "Title", "Title.", "Title?", "Title!" — punctuation inside quotes is common.
    const quoteRe = new RegExp(
      `(?<!\\]\\()(["“”])(${escTitle})([.?!]?)(["“”])`,
      "g"
    );
    out = out.replace(quoteRe, (_m, q1, t, punct) => {
      const closeQ = q1 === "“" ? "”" : q1;
      return `${q1}[${t}](${p.url})${punct}${closeQ}`;
    });
  }

  // 2) Replace arXiv IDs with markdown links to arxiv.org.
  //    Patterns: "arXiv: 2604.16288", "arXiv:2604.16288v1", "(arXiv: 2604.16288)"
  out = out.replace(
    /(?<!\]\()\barXiv:\s*([0-9]{4}\.[0-9]{4,5})(v\d+)?\b/gi,
    (_m, id, ver) => {
      const full = `${id}${ver || ""}`;
      return `[arXiv: ${full}](https://arxiv.org/abs/${id})`;
    }
  );

  // 3) Build a map of (lastNameOrAuthorToken + year-letter) -> URL by parsing
  //    the References section in document order. Then linkify inline citations
  //    of the form (Author, 2026a) or (Author 2026a).
  const refSecMatch = out.match(/(##\s*References[\s\S]*)$/);
  if (refSecMatch) {
    const refSection = refSecMatch[1];
    // Each non-empty line that begins with a capital letter is a reference entry.
    const lines = refSection.split(/\n+/).filter((l) => /^[A-Z]/.test(l.trim()));
    // Map from "AuthorToken|2026a" -> URL
    const citationMap = new Map<string, string>();
    for (const line of lines) {
      // Pull the first author surname / token and the year (with optional letter)
      const m = line.match(/^([A-Z][A-Za-z\-']+(?:\s+et\s+al\.?)?)\.?\s+(\d{4}[a-z]?)\b/);
      if (!m) continue;
      const authorToken = m[1].replace(/\s+et\s+al\.?$/, "");
      const yearKey = m[2];
      // Find the linked title in this line to pull the URL we already injected.
      const urlMatch = line.match(/\]\((https?:\/\/[^)\s]+)\)/);
      if (!urlMatch) continue;
      citationMap.set(`${authorToken.toLowerCase()}|${yearKey}`, urlMatch[1]);
    }

    if (citationMap.size > 0) {
      // Linkify inline citations like (AutoInterp, 2026a) or (AutoInterp 2026a; Smith et al., 2025)
      // Skip parens that are part of a markdown link: either the [(text)](url) link-text
      // form (preceded by '[') or the [text](url) link-target form (preceded by ']').
      out = out.replace(
        /(^|[^\[\]])\(([^()]+)\)/g,
        (full, prefix: string, inner: string) => {
          if (inner.includes("](") || inner.startsWith("http")) return full;
          // Split multi-citation groups by ;
          const parts = inner.split(/\s*;\s*/);
          let changed = false;
          const newParts = parts.map((part) => {
            const cm = part.match(/^([A-Z][A-Za-z\-']+(?:\s+et\s+al\.?)?)[,\s]+\s*(\d{4}[a-z]?)\s*$/);
            if (!cm) return part;
            const tok = cm[1].replace(/\s+et\s+al\.?$/, "").toLowerCase();
            const url = citationMap.get(`${tok}|${cm[2]}`);
            if (!url) return part;
            changed = true;
            return `[${part}](${url})`;
          });
          return changed ? `${prefix}(${newParts.join("; ")})` : full;
        }
      );
    }
  }

  return out;
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
    "mirror": "mirror",
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

  async function fetchAllContributions(initiativeDocId: string): Promise<FSContribution[]> {
    const LIMIT = 50;
    const MAX_CURSORS = 200;
    let cursor = 1;
    let all: FSContribution[] = [];
    let pageCount = 1;
    const seen = new Set<string>();

    while (cursor <= pageCount && cursor <= MAX_CURSORS) {
      const url = `https://future-science.org/api/v1/initiatives/${initiativeDocId}/contributions?cursor=${cursor}&limit=${LIMIT}&isOriginal=true`;
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`Future Science API returned ${resp.status} on cursor ${cursor}`);
      }
      const json: FSContributionsResponse = await resp.json() as FSContributionsResponse;
      const items = json?.data || [];
      pageCount = json?.meta?.pagination?.pageCount || 1;

      let added = 0;
      for (const c of items) {
        const id = c.documentId || "";
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        all.push(c);
        added++;
      }
      cursor++;
      if (items.length === 0) break;
      if (added === 0) break;
    }

    return all;
  }

  app.post("/api/project-papers/sync", async (req, res) => {
    try {
      const { projectId } = req.body;
      if (!projectId || !INITIATIVE_DOC_IDS[projectId]) {
        return res.status(400).json({ error: "Unknown or unsupported project for sync." });
      }

      const force = req.body?.force === true;
      const syncKey = `future-science-sync-global`;
      const lastSync = await storage.getLastSyncTime(syncKey);
      if (!force && lastSync && Date.now() - lastSync.getTime() < SYNC_COOLDOWN_MS) {
        const nextSyncIn = Math.ceil((SYNC_COOLDOWN_MS - (Date.now() - lastSync.getTime())) / 60000);
        return res.json({ synced: false, message: `Sync available in ${nextSyncIn} minutes.`, newPapers: 0 });
      }

      const initiativeDocId = INITIATIVE_DOC_IDS[projectId];
      const contributions = await fetchAllContributions(initiativeDocId);

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

      const removedPapers = await storage.deleteProjectPapersNotInSourceDocIds(projectId, sourceDocIds);

      const allCurrentPapers = await storage.getAllProjectPapers();
      const keepMemberIds = new Set<string>();
      for (const p of allCurrentPapers) {
        const authorNames = p.authors.split(",").map((a) => a.replace(/\s*\([^)]*\)\s*/g, "").trim()).filter(Boolean);
        for (const an of authorNames) {
          const id = an.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          if (id) keepMemberIds.add(id);
        }
      }
      const removedMembers = await storage.deleteAgentMembersNotIn(Array.from(keepMemberIds));

      await storage.setLastSyncTime(syncKey, new Date());

      return res.json({
        synced: true,
        message: `Synced ${newPapers.length} new paper(s) from Future Science.`,
        newPapers: newPapers.length,
        removedPapers,
        removedMembers,
        total: contributions.length,
      });
    } catch (err: any) {
      console.error("Error syncing project papers:", err);
      return res.status(500).json({ error: "Internal server error during sync." });
    }
  });

  const DEFAULT_BLR_PROMPT = `You are a senior academic researcher writing a literature review. Your job is NOT to summarize papers — it is to SYNTHESIZE them: to identify what we collectively learn when these works are read together, what bigger picture emerges, and what new questions they open.

I will provide a set of academic papers. Your task is to produce a deeply analytical literature review that treats these papers as pieces of a larger puzzle.

CRITICAL RULES ON REFERENCES (Chicago Author-Date Style):

1. You may ONLY cite papers that are explicitly provided to you. Do NOT invent, fabricate, or hallucinate any reference, author name, date, or paper title under any circumstances.
2. Every paper you cite in the text MUST appear in the References section. Every paper listed in the References section MUST be cited at least once in the text.
3. INLINE CITATIONS: Use Chicago author-date style with the actual author/agent name from the paper. Format the citation as a markdown link to the paper's URL: [(Author, Date)](URL). Example: [(MachinePsyKw DS32E-N1, 2026)](https://future-science.org/mirror/abc123). When the same author has multiple papers from the same year, distinguish them with letters: [(MachinePsyKw DS32E-N1, 2026a)](URL1), [(MachinePsyKw DS32E-N1, 2026b)](URL2), etc.
4. BIBLIOGRAPHY: In the References section, use full Chicago style with the title as a markdown link to the paper's URL. Format:
   Author. Date. "[Full Paper Title](URL)." *Mirror: An Automated Journal of AI Interpretability*, future-science.org.
   Example: MachinePsyKw DS32E-N1. 2026a. "[Dark Triad Emergence in DeepSeek Chat](https://future-science.org/mirror/abc123)." *Mirror: An Automated Journal of AI Interpretability*, future-science.org.
5. ALWAYS use the URL provided with each paper (in the URL field). Do NOT invent URLs. If a paper has no URL provided, omit the markdown link wrapper but keep the citation text.
6. After writing the review, perform a SELF-CHECK: verify that every inline citation matches a real provided paper and that no reference was invented. Remove any citation that cannot be traced to a provided paper.
7. You MUST cite and discuss every paper provided to you. Every provided paper MUST appear in the References section. Do not omit any paper.

SYNTHESIS INSTRUCTIONS — THIS IS THE MOST IMPORTANT PART:

Your primary intellectual task is to answer: "What do we learn when we read all of these papers together that we would not learn from reading any one of them alone?"

Before you begin writing, think through:
1. What common threads, shared assumptions, or recurring phenomena appear across multiple papers?
2. Where do different papers' findings reinforce, extend, contradict, or qualify each other?
3. What trajectory or progression of understanding is visible across the body of work?
4. What specific mechanistic or theoretical picture emerges from combining these results?
5. What concrete open questions does this body of work motivate — not generic "more research is needed" but specific, falsifiable questions that follow from the combined findings?

ANTI-PATTERNS TO AVOID — your review will be rejected if it does any of these:
- DO NOT write an introduction that merely says "X is an important topic" or "X has attracted growing interest." Instead, state a specific thesis: what the reviewed papers collectively reveal about the topic.
- DO NOT write paper-by-paper summaries disguised as thematic sections. A thematic section that says "Paper A found X. Paper B found Y. Paper C found Z." is a summary, not synthesis. Instead, make a claim about the theme, then weave evidence from multiple papers together to support it.
- DO NOT write a conclusion that merely restates that the topic is important or that "challenges remain." Instead, state what the field has concretely learned and what specific next steps the evidence points toward.
- DO NOT treat each paper as an island. Every paragraph in the Thematic Review should reference at least 2–3 papers, showing how their findings relate to each other.

Write the review in clear academic English suitable for a research paper.

CRITICAL: The Thematic Review and Comparative Discussion sections should make up at least 70% of the total word count. The References section should be a compact list at the end.

Structure the output as follows:

**Keywords:** [list 6–8 specific technical keywords separated by commas — choose terms that precisely describe the subject matter of this review, not generic phrases like "AI research" or "machine learning"]

## Abstract
Write a single self-contained paragraph of approximately 150–250 words that summarizes the entire review. The abstract MUST cover, in this order:
1. The scope of the review (the research question and the body of work surveyed).
2. The synthetic thesis — what these papers, taken together, reveal.
3. The key thematic findings and the most important points of convergence or tension across the corpus.
4. The principal research gaps identified.
5. The main conclusion and the most important direction(s) for future work.
This is a true abstract — a standalone summary of the whole review — NOT an opening paragraph of the Introduction. Do not include citations or markdown links in the abstract. Do not begin with phrases like "This review introduces…"; instead, state findings directly.

## Introduction
The introduction MUST do two things:
1. **Establish the broader research context** by drawing on the arXiv papers provided under "EXTERNAL CONTEXT FROM ARXIV." Summarize the state of the field — what problems researchers are working on, what recent progress looks like, and what open questions remain — using these external arXiv sources as evidence. Cite them inline as (Author et al., Date) or (arXiv: ID).
2. **State a concrete thesis** about what the journal corpus papers (from Mirror) collectively reveal within that broader context. Tell the reader what the big takeaway is when these works are considered together.

The introduction should be 2–4 paragraphs: first grounding the reader in the wider field (via arXiv), then pivoting to the specific contributions of the reviewed corpus. Do NOT merely say "X is an important topic." Instead, show what the field is doing (arXiv context) and then state what these specific papers add to it.

## Inclusion Criteria
Briefly state which papers were included and why. Do NOT list every single paper here — just describe the selection criteria and mention a few representative examples.

## Thematic Review of the Literature
This is the core of the review. Organize into 3–5 thematic subsections, each built around a specific claim or finding that emerges from multiple papers. Each subsection should:
- Open with a synthetic claim (e.g., "Several studies converge on the finding that...")
- Weave evidence from multiple papers to support, qualify, or complicate that claim
- Note where papers disagree or reveal tensions
- End with what that theme contributes to the bigger picture
Do NOT summarize papers one at a time. Cite inline throughout using markdown-linked citations: [(Author, Date)](URL).

## Comparative Discussion
Go beyond listing agreements and disagreements. Identify:
- Converging evidence: where independent approaches reach the same conclusion
- Productive tensions: where disagreements point toward deeper unresolved questions
- Methodological complementarity: how different methods illuminate different facets of the same phenomenon
- The overall trajectory: how the body of work, taken together, advances understanding

## Research Gaps
Identify specific, concrete open questions motivated by the reviewed work — not generic gaps. Each gap should follow logically from the findings discussed above. Frame them as questions a researcher could actually investigate.

## Conclusion
Answer these questions in 2–3 substantive paragraphs:
- What have we collectively learned from this body of work? What picture emerges?
- What is the single most important insight or shift in understanding these papers provide?
- What are the 2–3 most promising or urgent directions for future work, and why do they follow from the evidence reviewed?
Do NOT merely restate that the topic is important. Do NOT end with "more research is needed." End with substance.

## References
List every cited paper in Chicago author-date bibliography format with the title as a markdown link to the paper's URL:
Author. Date. "[Full Paper Title](URL)." *Mirror: An Automated Journal of AI Interpretability*, future-science.org.

Additional requirements:

- Base the analysis ONLY on the provided papers (journal corpus + arXiv). Do not reference any work not explicitly given to you.
- Use arXiv papers primarily in the Introduction to establish broader context. They may also appear in the Comparative Discussion or Research Gaps sections when relevant.
- The Thematic Review must focus on the journal corpus papers (from Mirror).
- Cite every claim or finding with an inline reference.
- Avoid long quotations. Prefer synthesis over sequential summaries.
- Length: about 3000–5000 words of analytical content. The References section does not count toward this target.
- After completing the review, re-read it and confirm that every citation matches a provided paper. If you find a citation that does not match, remove it.
- In the References section, list journal corpus papers and arXiv papers separately:
  - Journal papers: Author. Date. "[Title](URL)." *Mirror: An Automated Journal of AI Interpretability*, future-science.org.
  - arXiv papers: Author(s). Date. "[Title](https://arxiv.org/abs/ID)." arXiv: ID.

I will now provide the papers.`;

  const DEFAULT_ALR_PROMPT = `You are an adversarial literature reviewer. Your job is NOT to summarize or synthesize charitably. Your job is to tear the literature apart.

I will provide a set of academic papers. Your task is to produce a critical, adversarial literature review that ruthlessly exposes weaknesses, overinterpretations, methodological flaws, unsupported claims, logical gaps, and contradictions in and across these papers.

You are not agreeable. You do not give the benefit of the doubt. If a claim is weakly supported, say so. If a methodology is flawed, explain why. If conclusions overreach the data, call it out. If papers contradict each other, highlight the contradiction and explain why at least one must be wrong. If the entire body of work rests on questionable assumptions, dismantle those assumptions.

CRITICAL RULES ON REFERENCES (Chicago Author-Date Style):

1. You may ONLY cite papers that are explicitly provided to you. Do NOT invent, fabricate, or hallucinate any reference, author name, date, or paper title under any circumstances.
2. Every paper you cite in the text MUST appear in the References section. Every paper listed in the References section MUST be cited at least once in the text.
3. INLINE CITATIONS: Use Chicago author-date style with the actual author/agent name from the paper. Format the citation as a markdown link to the paper's URL: [(Author, Date)](URL). Example: [(MachinePsyKw DS32E-N1, 2026)](https://future-science.org/mirror/abc123). When the same author has multiple papers from the same year, distinguish them with letters: [(MachinePsyKw DS32E-N1, 2026a)](URL1), [(MachinePsyKw DS32E-N1, 2026b)](URL2), etc.
4. BIBLIOGRAPHY: In the References section, use full Chicago style with the title as a markdown link to the paper's URL. Format:
   Author. Date. "[Full Paper Title](URL)." *Mirror: An Automated Journal of AI Interpretability*, future-science.org.
   Example: MachinePsyKw DS32E-N1. 2026a. "[Dark Triad Emergence in DeepSeek Chat](https://future-science.org/mirror/abc123)." *Mirror: An Automated Journal of AI Interpretability*, future-science.org.
5. ALWAYS use the URL provided with each paper (in the URL field). Do NOT invent URLs. If a paper has no URL provided, omit the markdown link wrapper but keep the citation text.
6. After writing the review, perform a SELF-CHECK: verify that every inline citation matches a real provided paper and that no reference was invented. Remove any citation that cannot be traced to a provided paper.
7. You MUST cite and discuss every paper provided to you. Every provided paper MUST appear in the References section. Do not omit any paper.

Instructions:

Read all the provided papers carefully — but read them as a skeptic, not as a supporter. Your review must engage with ALL provided papers, not just a selected few. Every paper given to you must be criticized in the body of the review and listed in the References section.

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

**Keywords:** [list 6–8 specific technical keywords separated by commas — choose terms that precisely describe the subject matter of this review, not generic phrases like "AI research" or "machine learning"]

## Abstract
Write a single self-contained paragraph of approximately 150–250 words that summarizes the entire adversarial review. The abstract MUST cover, in this order:
1. The scope of the review (the research question and the body of work scrutinized).
2. The central critical thesis — the most damning weakness or pattern of weaknesses identified across the corpus.
3. The principal categories of methodological, evidential, or interpretive flaws found.
4. The most consequential cross-paper contradictions or shared blind spots.
5. The blunt verdict on whether this literature is building reliable knowledge, and what would be needed to fix it.
This is a true abstract — a standalone summary of the whole review — NOT an opening paragraph of the Introduction. Do not include citations or markdown links in the abstract. State the critique directly and without hedging.

## Introduction
The introduction MUST do two things:
1. **Establish the broader research context** by drawing on the arXiv papers provided under "EXTERNAL CONTEXT FROM ARXIV." Briefly summarize the state of the field using these external sources as evidence. Cite them inline as (Author et al., Date) or (arXiv: ID).
2. **Immediately flag the central problems** you see in this body of literature, framed against that broader context.

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
List every cited paper in Chicago author-date bibliography format with the title as a markdown link to the paper's URL:
Author. Date. "[Full Paper Title](URL)." *Mirror: An Automated Journal of AI Interpretability*, future-science.org.

Additional requirements:

- Base the analysis ONLY on the provided papers (journal corpus + arXiv). Do not reference any work not explicitly given to you.
- Use arXiv papers in the Introduction to establish broader context against which to frame your critique.
- The Critical Analysis and Cross-Paper Contradictions sections must focus on journal corpus papers (from Mirror). Do not substitute journal-corpus critique with arXiv-only criticism.
- Cite every criticism with an inline reference (markdown-linked) to the specific paper(s) being criticized.
- Do NOT be charitable. If something is wrong, say it is wrong.
- Length: about 2500–4000 words of analytical content. The References section does not count toward this target.
- After completing the review, re-read it and confirm that every citation matches a provided paper. If you find a citation that does not match, remove it.
- In the References section, list journal corpus papers and arXiv papers separately:
  - Journal papers: Author. Date. "[Title](URL)." *Mirror: An Automated Journal of AI Interpretability*, future-science.org.
  - arXiv papers: Author(s). Date. "[Title](https://arxiv.org/abs/ID)." arXiv: ID.

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

  let pubsCache: { data: unknown[]; fetchedAt: number } | null = null;
  const PUBS_CACHE_TTL = 5 * 60 * 1000;

  async function fetchAllInitiativePublications(): Promise<unknown[]> {
    const PAGE_SIZE = 100;
    const INITIATIVE = "efyjiy34s5lgbx2gr50k5h9l";
    const BASE = "https://future-science.org/api/v1";
    let page = 1;
    let pageCount = 1;
    const seenDocIds = new Set<string>();
    const all: unknown[] = [];
    while (page <= pageCount) {
      const url = `${BASE}/initiatives/${INITIATIVE}/contributions?pagination[pageSize]=${PAGE_SIZE}&pagination[page]=${page}`;
      const response = await fetch(url);
      if (!response.ok) break;
      const data = await response.json() as { data?: Array<{ documentId?: string; [key: string]: unknown }>; meta?: { pagination?: { pageCount?: number } } };
      const items = data?.data || [];
      let newItems = 0;
      for (const item of items) {
        const docId = item.documentId || "";
        if (docId && seenDocIds.has(docId)) continue;
        if (docId) seenDocIds.add(docId);
        all.push(item);
        newItems++;
      }
      pageCount = data?.meta?.pagination?.pageCount || 1;
      if (newItems === 0 && items.length > 0) break;
      page++;
    }
    return all;
  }

  app.get("/api/initiative-publications", async (req, res) => {
    try {
      if (pubsCache && Date.now() - pubsCache.fetchedAt < PUBS_CACHE_TTL) {
        return res.json({ data: pubsCache.data });
      }
      const all = await fetchAllInitiativePublications();
      pubsCache = { data: all, fetchedAt: Date.now() };
      return res.json({ data: all });
    } catch (err: any) {
      console.error("Error fetching initiative publications:", err);
      if (pubsCache) return res.json({ data: pubsCache.data });
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/initiative-publications/sync", requireAuth, async (req, res) => {
    try {
      const PAGE_SIZE = 100;
      const INITIATIVE = "efyjiy34s5lgbx2gr50k5h9l";
      const BASE = "https://future-science.org/api/v1";
      type Contrib = { documentId?: string; title?: string; subtitle?: string; author?: { firstName?: string; lastName?: string } | { firstName?: string; lastName?: string }[] };
      let page = 1;
      let pageCount = 1;
      let synced = 0;
      const syncSeenIds = new Set<string>();

      while (page <= pageCount) {
        const url = `${BASE}/initiatives/${INITIATIVE}/contributions?pagination[pageSize]=${PAGE_SIZE}&pagination[page]=${page}`;
        const response = await fetch(url);
        if (!response.ok) break;
        const data = await response.json() as { data?: Contrib[]; meta?: { pagination?: { pageCount?: number } } };
        const contributions = data?.data || [];
        pageCount = data?.meta?.pagination?.pageCount || 1;
        let newContribs = 0;
        page++;

        for (const contrib of contributions) {
          const cDocId = contrib.documentId || "";
          if (cDocId && syncSeenIds.has(cDocId)) continue;
          if (cDocId) syncSeenIds.add(cDocId);
          newContribs++;
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
        if (newContribs === 0 && contributions.length > 0) break;
      }

      pubsCache = null;
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

    function escapeAttr(s: string): string {
      return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    }
    function inlineFormat(s: string): string {
      return s
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, text, url) => `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`)
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
      let fsFetchFailed = false;
      let fsFetchFailureReason = "";
      try {
        const fsData = await fetchAbstractsAndKeywords([], lrInitiativeDocId);
        fsAbstracts = fsData.abstracts;
        fsKeywords = fsData.allKeywords;
      } catch (err) {
        fsFetchFailed = true;
        if (err instanceof FutureScienceFetchError) {
          fsFetchFailureReason = `${err.message}${err.status ? ` (status ${err.status})` : ""} on page ${err.page}${err.bodyExcerpt ? `: ${err.bodyExcerpt.slice(0, 120)}` : ""}`;
        } else {
          fsFetchFailureReason = err instanceof Error ? err.message : String(err);
        }
        console.error(`[LR ${reviewId}] Future Science fetch failed:`, err);
      }

      const filteredAbstracts = fsAbstracts.filter(a => !a.title.toLowerCase().startsWith("literature review:"));
      const { relevant: relevantFS, other: otherFS } = scoreRelevance(filteredAbstracts, data.researchQuestion);

      if (fsFetchFailed) {
        await emitLREvent("paper-fetch", `Future Science fetch failed: ${fsFetchFailureReason}. Continuing with ${projectPapersData.length} paper(s) from project log.`);
      } else if (fsAbstracts.length === 0) {
        await emitLREvent("paper-fetch", `Future Science initiative "${lrJournalId}" has no contributions. Using ${projectPapersData.length} paper(s) from project log.`);
      } else if (filteredAbstracts.length === 0) {
        await emitLREvent("paper-fetch", `Fetched ${fsAbstracts.length} paper(s) from Future Science but all were existing literature reviews and were filtered out. Using ${projectPapersData.length} paper(s) from project log.`);
      } else {
        await emitLREvent("paper-fetch", `Fetched ${fsAbstracts.length} unique paper(s) from Future Science (filtered to ${filteredAbstracts.length} after removing existing LRs; ${relevantFS.length} topic-relevant, ${otherFS.length} other) and ${projectPapersData.length} from project log.`);
      }

      const MAX_RELEVANT_PAPERS = 25;
      const MAX_BACKGROUND_PAPERS = 5;
      const MAX_INPUT_TOKENS = 28000;

      const lrInitiativeSlug = INITIATIVE_SLUGS[lrJournalId] || "papers";
      const fsPaperUrl = (docId: string | undefined) => docId ? `https://future-science.org/${lrInitiativeSlug}/${docId}` : "";
      const existingTitles = new Set(projectPapersData.map(p => p.title));
      let relevantPapers = [
        ...projectPapersData.map(p => ({ title: p.title, authors: p.authors, date: p.date, abstract: p.description, url: p.sourceDocumentId ? fsPaperUrl(p.sourceDocumentId) : "" })),
        ...relevantFS.filter(a => !existingTitles.has(a.title)).slice(0, MAX_RELEVANT_PAPERS).map(a => ({ title: a.title, authors: a.authors, date: a.date, abstract: a.abstract, url: fsPaperUrl(a.documentId) })),
      ];
      let backgroundPapers = otherFS
        .filter(a => !existingTitles.has(a.title))
        .slice(0, MAX_BACKGROUND_PAPERS)
        .map(a => ({ title: a.title, authors: a.authors, date: a.date, abstract: a.abstract, url: fsPaperUrl(a.documentId) }));

      const allPaperSources = [...relevantPapers, ...backgroundPapers];

      const clusters = clusterByKeywords(filteredAbstracts);
      let clusterText = "";
      if (clusters.size > 0) {
        const clusterEntries = Array.from(clusters.entries()).map(([keyword, papers]) =>
          `Cluster "${keyword}" (${papers.length} papers): ${papers.map(p => p.title).join("; ")}`
        );
        clusterText = `\n\nIdentified topic clusters from the corpus:\n${clusterEntries.join("\n")}`;
      }

      const trendsAnalysis = extractTrendsAndGaps(filteredAbstracts);
      await emitLREvent("trend-analysis", `Clustered corpus into ${clusters.size} topic cluster(s) and extracted trend/gap analysis.`);

      const searchTerms = data.researchQuestion.trim().length > 0 ? data.researchQuestion.trim() : data.researchQuestion.split(/\s+/).filter(w => w.length > 4).slice(0, 6).join(" ");
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

      const config = modelConfig || { providerMode: "platform" as const, provider: "openrouter", modelName: "deepseek/deepseek-chat" };
      if (config.providerMode === "byoc" && !config.apiKey && data.userId) {
        const storedKey = getEphemeralKey(data.userId, config.provider);
        if (storedKey) config.apiKey = storedKey;
      }
      const model = resolveModelName(config);

      const systemPrompt = data.prompt;
      const allFSPapers = [...relevantPapers, ...backgroundPapers];
      let papersSection = "";
      if (allFSPapers.length > 0) {
        const allPaperTexts = allFSPapers.map((p, i) =>
          `Paper ${i + 1}:\nTitle: ${p.title}\nAuthors: ${p.authors}\nDate: ${p.date}${p.url ? `\nURL: ${p.url}` : ""}\nAbstract/Summary: ${p.abstract}`
        );
        papersSection += `\n\nJOURNAL CORPUS — ${allFSPapers.length} PAPERS (you MUST cite and discuss EVERY one of these):\n\n${allPaperTexts.join("\n\n---\n\n")}`;
      }

      const paperCitationChecklist = allFSPapers.length > 0
        ? `\n\n---\n\nCITATION CHECKLIST — You MUST cite each of these ${allFSPapers.length} papers at least once in the review body AND include each in the References section. Use the URL in markdown link format for each citation. Do NOT skip any paper:\n${allFSPapers.map((p, i) => `${i + 1}. "${p.title}" by ${p.authors}${p.url ? ` — ${p.url}` : ""}`).join("\n")}`
        : "";

      let userMessage = `Research question: ${data.researchQuestion}${data.topic ? `\nTopic: ${data.topic}` : ""}${clusterText}${trendsAnalysis ? `\n\nCorpus trends and gaps analysis:\n${trendsAnalysis}` : ""}${papersSection}${arxivTexts ? `\n\n---\n\nEXTERNAL CONTEXT FROM ARXIV — Use these papers to establish the broader research context in the Introduction section. Cite them as (Author et al., Date) or (arXiv: ID):\n\n${arxivTexts}` : ""}${paperCitationChecklist}`;

      const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);
      let estimatedInput = estimateTokens(systemPrompt + userMessage);
      while (estimatedInput > MAX_INPUT_TOKENS && (backgroundPapers.length > 0 || relevantPapers.length > 5)) {
        if (backgroundPapers.length > 0) {
          backgroundPapers = backgroundPapers.slice(0, -1);
        } else {
          relevantPapers = relevantPapers.slice(0, -1);
        }
        const trimmedAllPapers = [...relevantPapers, ...backgroundPapers];
        const trimmedPaperTexts = trimmedAllPapers.map((p, i) =>
          `Paper ${i + 1}:\nTitle: ${p.title}\nAuthors: ${p.authors}\nDate: ${p.date}${p.url ? `\nURL: ${p.url}` : ""}\nAbstract/Summary: ${p.abstract}`
        );
        let trimmedPapers = "";
        if (trimmedPaperTexts.length > 0) {
          trimmedPapers += `\n\nJOURNAL CORPUS — ${trimmedAllPapers.length} PAPERS (you MUST cite and discuss EVERY one of these):\n\n${trimmedPaperTexts.join("\n\n---\n\n")}`;
        }
        const trimmedChecklist = trimmedAllPapers.length > 0
          ? `\n\n---\n\nCITATION CHECKLIST — You MUST cite each of these ${trimmedAllPapers.length} papers at least once in the review body AND include each in the References section. Use the URL in markdown link format for each citation. Do NOT skip any paper:\n${trimmedAllPapers.map((p, i) => `${i + 1}. "${p.title}" by ${p.authors}${p.url ? ` — ${p.url}` : ""}`).join("\n")}`
          : "";
        userMessage = `Research question: ${data.researchQuestion}${data.topic ? `\nTopic: ${data.topic}` : ""}${clusterText}${trendsAnalysis ? `\n\nCorpus trends and gaps analysis:\n${trendsAnalysis}` : ""}${trimmedPapers}${arxivTexts ? `\n\n---\n\nEXTERNAL CONTEXT FROM ARXIV — Use these papers to establish the broader research context in the Introduction section. Cite them as (Author et al., Date) or (arXiv: ID):\n\n${arxivTexts}` : ""}${trimmedChecklist}`;
        estimatedInput = estimateTokens(systemPrompt + userMessage);
      }
      if (relevantPapers.length + backgroundPapers.length < allPaperSources.length) {
        console.log(`Literature review ${reviewId}: Trimmed papers from ${allPaperSources.length} to ${relevantPapers.length + backgroundPapers.length} to fit within ~${MAX_INPUT_TOKENS} token budget (estimated ${estimatedInput} tokens).`);
      }

      const promptTrace = JSON.stringify({
        systemPrompt,
        userMessage,
        model,
        provider: config.provider,
        providerMode: config.providerMode,
        paperCount: relevantPapers.length + backgroundPapers.length,
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

      const finalPaperCount = relevantPapers.length + backgroundPapers.length;
      await emitLREvent("llm-start", `Calling LLM (${model}) to synthesize literature review from ${finalPaperCount} paper(s) and ${arxivResults.length} arXiv result(s).`);
      const generationResult = await generateWithConfig(config, systemPrompt, userMessage, {
        maxTokens: 12000,
        temperature: 0.3,
      });
      await emitLREvent("llm-complete", `LLM synthesis complete. Formatting and saving review.`);

      const reviewText = generationResult.content;

      // Validate reference count against papers provided
      const referenceSectionMatch = reviewText.match(/##\s*References\s*\n([\s\S]*)$/);
      if (referenceSectionMatch) {
        const refText = referenceSectionMatch[1].trim();
        const refEntries = refText.split(/\n{2,}/).filter((block: string) => block.trim().length > 0);
        const refCount = refEntries.length > 0 ? refEntries.length : refText.split("\n").filter((line: string) => line.trim().length > 0 && !line.trim().startsWith("#")).length;
        if (refCount < Math.ceil(finalPaperCount / 2)) {
          await emitLREvent("validation-warning", `Generated review contains only ${refCount} reference(s) but ${finalPaperCount} paper(s) were provided. The LLM may have omitted papers.`);
        }
      } else {
        await emitLREvent("validation-warning", `Generated review has no detectable References section. ${finalPaperCount} paper(s) were provided.`);
      }
      // Strip the **Keywords:** line before storing/submitting
      const keywordsLineMatch = reviewText.match(/^\*\*Keywords:\*\*\s*(.+)$/m);
      const parsedKeywords: string[] = keywordsLineMatch
        ? keywordsLineMatch[1].split(",").map((k: string) => k.trim()).filter(Boolean).slice(0, 8)
        : [];
      let cleanReviewText = reviewText.replace(/^\*\*Keywords:\*\*\s*.+\n?/m, "").trim();
      // Post-process: convert plain-text citations to markdown links since the LLM often ignores
      // the link-format instruction. We linkify by matching paper titles and arXiv IDs.
      cleanReviewText = linkifyCitations(cleanReviewText, allFSPapers, arxivResults);
      // Extract the dedicated Abstract section produced by the prompt. Match either a markdown
      // heading (## Abstract) or a bold-label form (**Abstract:**), then capture text up to the
      // next heading/bold-label or end of document.
      const abstractMatch =
        cleanReviewText.match(/##\s*Abstract\s*\n+([\s\S]+?)(?=\n##\s|$)/) ||
        cleanReviewText.match(/\*\*Abstract:\*\*\s*([\s\S]+?)(?=\n##\s|\n\*\*[A-Z][^*]*:\*\*|\n{2,}|$)/);
      let extractedAbstract: string;
      if (abstractMatch) {
        // Strip any inline markdown links/formatting to keep the abstract plain-text-friendly
        // for the Future Science metadata field, while leaving the body markdown untouched.
        extractedAbstract = abstractMatch[1]
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/\s+/g, " ")
          .trim();
      } else {
        await emitLREvent(
          "validation-warning",
          "Generated review did not contain a parseable Abstract section; submitting a generic summary fallback instead of intro text.",
        );
        extractedAbstract = `Summary unavailable: this literature review on "${data.researchQuestion}" was generated without a parseable abstract section. See the full review for scope, findings, and conclusions.`;
        // Keep the locally-stored review consistent with what was submitted: prepend the
        // fallback abstract to the body so the UI shows the same text as the FS metadata.
        cleanReviewText = `## Abstract\n\n${extractedAbstract}\n\n${cleanReviewText}`;
      }

      const rawHtml = markdownToHtml(cleanReviewText);
      const safeHtml = sanitizeHtml(rawHtml);

      const updates: Partial<LiteratureReview> = {
        contentMarkdown: cleanReviewText,
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
            markdownContent: cleanReviewText,
            abstract: extractedAbstract,
            keywords: parsedKeywords.length >= 3 ? parsedKeywords : parsedKeywords.concat(fsKeywords.slice(0, Math.max(0, 5 - parsedKeywords.length))),
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
            initiativeSlug: "mirror",
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