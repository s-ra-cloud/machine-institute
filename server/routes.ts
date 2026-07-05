import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertPaperSchema, insertResearchEventSchema, insertLiteratureReviewSchema, insertProjectPaperSchema, insertEditorialSchema, insertAgentMemberSchema, insertEthicsReportSchema, insertPeerReviewSchema, type LiteratureReview, type EditorialRecord, type ResearchEvent, type EthicsReport, type PeerReview, type InsertEthicsReport } from "@shared/schema";
import { H_SOLO_REPORT_CHUNK_1_PROMPT, H_SOLO_REPORT_CHUNK_2_PROMPT, H_SOLO_REPORT_CHUNK_3_PROMPT, H_SINGLE_PAPER_PROMPT, applyJournalName } from "./prompts/h-solo";
import { runEthicsReport, extractFlags, type EthicsReviewOutput, type EthicsFlag } from "./ethics-review";
import { fetchFsPaperContent } from "./citation-verifier";
import { runPeerReview } from "./peer-review";
import { getPeerReviewPrompt, BR_PROMPT, IR_PROMPT, AR_PROMPT, RR_PROMPT, extractRevisions, extractReviewSummary, buildPeerReviewAbstract, buildVerificationSection, hasVerificationSection, derivePeerReviewKeywords, type PeerReviewPersona } from "./prompts/peer-review";
import { buildLiteratureReviewFallbackAbstract } from "./prompts/literature-review";
import { EDITORIAL_SUMMARY_INSTRUCTION, extractEditorialSummary, stripEditorialSummarySection, buildEditorialAbstract, deriveEditorialKeywords } from "./prompts/editorial";
import { fromZodError } from "zod-validation-error";
import { z } from "zod";
import path from "path";
import fs from "fs";
import OpenAI from "openai";
import { JSDOM } from "jsdom";
import DOMPurify from "dompurify";
import { requireAuth, optionalAuth, adminAuth, requireSession } from "./auth";
import { createLLMClient, resolveModelName, generateWithConfig, validateApiKey, PLATFORM_MODELS, BYOC_PROVIDERS, PER_USER_PLATFORM_LIMITS, getReadingBudget, READING_BUDGET, type ModelProviderConfig } from "./model-service";
import { publishToFutureScience, submitLiteratureReviewToFutureScience, submitEthicsReportToFutureScience, submitPeerReviewToFutureScience, fetchAbstractsAndKeywords, extractTrendsAndGaps, scoreRelevance, FutureScienceFetchError, type FutureScienceAbstract, type FSContribution, type FSAuthor, type FSContributionsResponse } from "./future-science";
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
  else if (m.includes("gpt-5")) initials = "G5";
  else if (m.includes("gpt-4o")) initials = "G4O";
  else if (m.includes("gpt-4")) initials = "G4";
  else initials = "ML";
  return `MachInstit ${initials}${agentId}-N1`;
}

// Map publication-audit flags to Future Science revision arrays:
// CRITICAL + MAJOR flags become majorRevisions, MINOR flags become
// minorRevisions. Each flag summary is the revision description.
function flagsToRevisions(flags: EthicsFlag[]): {
  major: Array<{ description: string }>;
  minor: Array<{ description: string }>;
} {
  const major: Array<{ description: string }> = [];
  const minor: Array<{ description: string }> = [];
  for (const f of flags || []) {
    const description = (f?.summary || "").trim();
    if (!description) continue;
    if (f.severity === "CRITICAL" || f.severity === "MAJOR") {
      major.push({ description });
    } else if (f.severity === "MINOR") {
      minor.push({ description });
    }
  }
  return { major, minor };
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

  const JOURNAL_DISPLAY_NAMES: Record<string, string> = {
    "mirror": "Mirror — An Automated Journal of AI Interpretability",
  };

  function getJournalDisplayName(journalId: string): string {
    return JOURNAL_DISPLAY_NAMES[journalId] || journalId;
  }

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
    "rR": "Rigorous Reviewer",
    "bLR": "Basic Literature Reviewer",
    "aLR": "Adversarial Literature Reviewer",
    "bER": "Basic Ethics Reviewer",
    "H": "Research Standards Verification Agent",
    "V": "Reviser",
    "N": "Manager",
  };

  const MODEL_CODES: Record<string, string> = {
    "DS32": "DeepSeek-32B",
    "D32": "DeepSeek-32B",
    "CS45": "Claude 4.5 Sonnet",
    "CS35": "Claude 3.5 Sonnet",
    "QW3": "Qwen 3",
    "X": "Unknown",
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
    const modelDesc = parsed.modelLabel === "Unknown" ? "an unknown model" : parsed.modelLabel;
    return `${fwArticle} ${parsed.framework} agent running on ${modelDesc} as ${roleArticle} ${parsed.roleLabel}${inst}, with ${parsed.memoryLabel.toLowerCase()}.`;
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

  app.post("/api/project-papers/sync", adminAuth, async (req, res) => {
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

  const DEFAULT_BLR_PROMPT = `You are a senior researcher writing a literature review. SYNTHESIZE the provided papers — say what we learn from reading them together — rather than summarizing them one by one.

Rules:
- Cite ONLY papers provided to you. Never invent references, authors, dates, titles, or URLs.
- Cite every provided paper at least once in the body, and list every one in References.
- Inline citations use Chicago author-date as a markdown link to the paper's URL: [(Author, Date)](URL). Use letters for same-author/same-year papers: 2026a, 2026b. If a paper has no URL, keep the text but drop the link.
- Use arXiv papers (under "EXTERNAL CONTEXT FROM ARXIV") only for broader context in the Introduction; the analysis focuses on the journal corpus.

Write in clear academic English, ~3000–5000 words (References excluded). Use these sections in order:

**Keywords:** [6–8 specific technical keywords, comma-separated]

## Abstract
One self-contained paragraph (~150–250 words) covering scope, the synthetic thesis, key findings/tensions, gaps, and the main direction for future work. No citations or links.

## Introduction
Ground the reader in the field using the arXiv context, then state a concrete thesis about what the corpus papers collectively reveal.

## Thematic Review
The core of the review. Organize into 3–5 thematic subsections, each opening with a synthetic claim and weaving evidence from multiple papers to support, qualify, or complicate it. Cite inline as [(Author, Date)](URL). Do not summarize papers one at a time.

## Comparative Discussion
Where papers converge, where they conflict, and how the body of work advances understanding overall.

## Research Gaps
Specific, concrete open questions that follow from the findings above.

## Conclusion
What we have collectively learned, the single most important insight, and the 2–3 most promising directions for future work.

## References
List every cited paper, journal papers and arXiv papers separately:
- Journal: Author. Date. "[Title](URL)." *Mirror: An Automated Journal of AI Interpretability*, future-science.org.
- arXiv: Author(s). Date. "[Title](https://arxiv.org/abs/ID)." arXiv: ID.

Before finishing, re-read and remove any citation that does not match a provided paper.

I will now provide the papers.`;

  const DEFAULT_ALR_PROMPT = `You are an adversarial literature reviewer. Do not summarize or synthesize charitably — tear the literature apart. Expose weaknesses, overinterpretations, methodological flaws, unsupported claims, logical gaps, and contradictions within and across the provided papers. Do not give the benefit of the doubt; if something is wrong, say so plainly and without hedging.

Rules:
- Cite ONLY papers provided to you. Never invent references, authors, dates, titles, or URLs.
- Criticize every provided paper at least once in the body, and list every one in References.
- Inline citations use Chicago author-date as a markdown link to the paper's URL: [(Author, Date)](URL). Use letters for same-author/same-year papers: 2026a, 2026b. If a paper has no URL, keep the text but drop the link.
- Use arXiv papers (under "EXTERNAL CONTEXT FROM ARXIV") only for broader context in the Introduction; the critique focuses on the journal corpus.

Look for, per paper: unsupported/overreaching claims, methodological weaknesses (sample size, design, confounds, missing controls/baselines), logical leaps, cherry-picked results, conclusions that overreach the data. Across papers: unacknowledged contradictions, shared blind spots, circular reasoning, over-reliance on one method, false novelty.

Write in direct, incisive academic English, ~2500–4000 words (References excluded). Use these sections in order:

**Keywords:** [6–8 specific technical keywords, comma-separated]

## Abstract
One self-contained paragraph (~150–250 words) covering scope, the central critical thesis (the most damning weakness), the main categories of flaws, the most consequential cross-paper contradictions, and a blunt verdict. No citations or links.

## Introduction
Briefly establish the field using the arXiv context, then flag the central problems in this literature.

## Critical Analysis
The core of the review. Organize into thematic subsections by category of weakness (e.g. methodological deficiencies, overinterpretation, unsupported generalizations). Cite inline as [(Author, Date)](URL). This section must be extensive.

## Cross-Paper Contradictions
Directly compare papers with conflicting claims or incompatible methods and explain why the contradictions undermine the collective findings.

## Fundamental Gaps and Blind Spots
What these papers collectively fail to address — missing controls, ignored alternative hypotheses, unasked questions.

## Verdict
A blunt assessment: is this literature building reliable knowledge, or an echo chamber of weakly validated claims?

## References
List every cited paper, journal papers and arXiv papers separately:
- Journal: Author. Date. "[Title](URL)." *Mirror: An Automated Journal of AI Interpretability*, future-science.org.
- arXiv: Author(s). Date. "[Title](https://arxiv.org/abs/ID)." arXiv: ID.

Before finishing, re-read and remove any citation that does not match a provided paper.

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
      // Attach the per-model max full-text papers so the dashboard's Step 5 slider
      // can scale its maximum with the selected model's context window.
      platformModels: PLATFORM_MODELS.map(m => ({
        ...m,
        maxFullTextPapers: getReadingBudget({ providerMode: "platform", provider: m.provider, modelName: m.model }).maxFullTextPapers,
      })),
      byocProviders: BYOC_PROVIDERS.map(p => ({
        ...p,
        maxFullTextPapers: getReadingBudget({ providerMode: "byoc", provider: p.id, modelName: "" }).maxFullTextPapers,
      })),
      limits: PER_USER_PLATFORM_LIMITS,
      defaultTopics: {
        editorial: "Recent developments in AI agent-driven scientific research, autonomous experimentation, and AI interpretability",
        "literature-review": "Autonomous AI research agents and their role in scientific discovery",
      },
      ethicsReport: {
        defaultJournalId: "mirror",
        defaultProjectId: "machine-psychology",
        availableProjects: [
          { id: "machine-psychology", label: "Machine Psychology" },
          { id: "mirror", label: "Mirror" },
        ],
        availableJournals: Object.keys(INITIATIVE_DOC_IDS),
        roleCode: "H",
        agentNamePattern: "MachInstit <ModelCode>H-N1",
        chunks: 3,
        severityOrder: ["CRITICAL", "MAJOR", "MINOR"],
      },
      peerReview: {
        defaultJournalId: "mirror",
        availableJournals: Object.keys(INITIATIVE_DOC_IDS),
        personas: [
          { code: "bR", label: "Basic Reviewer" },
          { code: "iR", label: "Innovation Reviewer" },
          { code: "rR", label: "Rigorous Reviewer" },
          { code: "aR", label: "Adversarial Reviewer" },
        ],
        agentNamePattern: "MachInstit <ModelCode><Persona>-N1",
        chunks: 3,
        ethicsCoauthorDefault: true,
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
      await storage.deleteAllEthicsReports();
      await storage.deleteAllPeerReviews();
      return res.json({ success: true });
    } catch (err: any) {
      console.error("Error clearing generation history:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/generation/rate-limit-status", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const PLATFORM_ACCESS_EMAILS = ["jevans@uchicago.edu", "sacharaoult@gmail.com", "akozlo@uchicago.edu"];
      const isPlatformMember = PLATFORM_ACCESS_EMAILS.includes(user.email);

      if (isPlatformMember) {
        return res.json({
          editorial: { remaining: null, max: null, resetAt: null },
          "literature-review": { remaining: null, max: null, resetAt: null },
          "ethics-report": { remaining: null, max: null, resetAt: null },
          "peer-review": { remaining: null, max: null, resetAt: null },
        });
      }

      const editorialLimit = await storage.getUserRateLimit(user.id, "editorial");
      const reviewLimit = await storage.getUserRateLimit(user.id, "literature-review");
      const ethicsLimit = await storage.getUserRateLimit(user.id, "ethics-report");
      const peerLimit = await storage.getUserRateLimit(user.id, "peer-review");
      const editorialConfig = PER_USER_PLATFORM_LIMITS["editorial"];
      const reviewConfig = PER_USER_PLATFORM_LIMITS["literature-review"];
      const ethicsConfig = PER_USER_PLATFORM_LIMITS["ethics-report"];
      const peerConfig = PER_USER_PLATFORM_LIMITS["peer-review"];

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
      const ethicsRemaining = ethicsLimit
        ? (now - ethicsLimit.windowStart.getTime() >= ethicsConfig.windowMs
          ? ethicsConfig.max
          : Math.max(0, ethicsConfig.max - ethicsLimit.count))
        : ethicsConfig.max;
      const peerRemaining = peerLimit
        ? (now - peerLimit.windowStart.getTime() >= peerConfig.windowMs
          ? peerConfig.max
          : Math.max(0, peerConfig.max - peerLimit.count))
        : peerConfig.max;

      return res.json({
        editorial: { remaining: editorialRemaining, max: editorialConfig.max, resetAt: editorialLimit ? editorialLimit.windowStart.getTime() + editorialConfig.windowMs : null },
        "literature-review": { remaining: reviewRemaining, max: reviewConfig.max, resetAt: reviewLimit ? reviewLimit.windowStart.getTime() + reviewConfig.windowMs : null },
        "ethics-report": { remaining: ethicsRemaining, max: ethicsConfig.max, resetAt: ethicsLimit ? ethicsLimit.windowStart.getTime() + ethicsConfig.windowMs : null },
        "peer-review": { remaining: peerRemaining, max: peerConfig.max, resetAt: peerLimit ? peerLimit.windowStart.getTime() + peerConfig.windowMs : null },
      });
    } catch (err: any) {
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  const reviewRateLimit = new Map<string, number>();

  app.post("/api/literature-reviews", requireAuth, async (req, res) => {
    try {
      const { projectId, agentId, researchQuestion, prompt, topic, modelProvider, modelName, providerMode, byocApiKey, orchestratorName, agentDescription, journalId, fullTextCount, includeArxiv } = req.body;

      // Number of top-relevance papers to read in FULL TEXT (rest use abstracts).
      // The maximum scales with the selected model's context window (see getReadingBudget):
      // bigger models can read more papers in full. Default reads the model's full allowance.
      const FULL_TEXT_MAX = getReadingBudget({
        providerMode: (providerMode === "byoc" ? "byoc" : "platform") as "platform" | "byoc",
        provider: modelProvider || "openrouter",
        modelName: modelName || "",
      }).maxFullTextPapers;
      const parsedFullText = Number(fullTextCount);
      // Only honor a real positive number; null/""/non-numeric all fall back to the model's max.
      const effectiveFullTextCount = (fullTextCount !== undefined && fullTextCount !== null && fullTextCount !== "" && Number.isFinite(parsedFullText) && parsedFullText >= 1)
        ? Math.min(FULL_TEXT_MAX, Math.max(1, Math.round(parsedFullText)))
        : FULL_TEXT_MAX;
      // arXiv external context is on by default; only an explicit `false` disables it.
      const effectiveIncludeArxiv = includeArxiv !== false;

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
        if (!PLATFORM_ACCESS_EMAILS.includes(user.email)) {
          const limitConfig = PER_USER_PLATFORM_LIMITS["literature-review"];
          const rateCheck = await storage.checkAndIncrementRateLimit(user.id, "literature-review", limitConfig.max, limitConfig.windowMs);
          if (!rateCheck.allowed) {
            return res.status(429).json({ error: `Review generation limit reached (${limitConfig.max} per 24 hours). Try again later.` });
          }
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

      if (!PLATFORM_ACCESS_EMAILS.includes(user.email)) {
        const clientIp = req.ip || "unknown";
        const lastRequest = reviewRateLimit.get(clientIp) || 0;
        if (Date.now() - lastRequest < 30000) {
          return res.status(429).json({ error: "Please wait at least 30 seconds between review requests." });
        }
        reviewRateLimit.set(clientIp, Date.now());
      }

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
      generateLiteratureReview(review.id, { ...result.data, topic: effectiveTopic, userId: user.id, journalId: effectiveJournalId, fullTextCount: effectiveFullTextCount, includeArxiv: effectiveIncludeArxiv }, modelConfig, accessToken).catch(err => {
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
    const LIMIT = 50;
    const MAX_CURSORS = 200;
    const INITIATIVE = "efyjiy34s5lgbx2gr50k5h9l";
    const BASE = "https://future-science.org/api/v1";
    let cursor = 1;
    let pageCount = 1;
    const seenDocIds = new Set<string>();
    const all: unknown[] = [];
    while (cursor <= pageCount && cursor <= MAX_CURSORS) {
      const url = `${BASE}/initiatives/${INITIATIVE}/contributions?cursor=${cursor}&limit=${LIMIT}&isOriginal=true`;
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
      if (items.length === 0) break;
      if (newItems === 0) break;
      cursor++;
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

  app.post("/api/initiative-publications/sync", adminAuth, async (req, res) => {
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

    const isUl = (s: string) => s.startsWith("- ") || s.startsWith("* ");
    const isOl = (s: string) => /^(?:\[?\d+[\].)]\s|[a-zA-Z][).]\s)/.test(s);

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) {
        // Blank line: keep the current list open if the next non-blank line is
        // another item of the same list. Authors (and LLMs) often separate list
        // items with blank lines for readability — each item must NOT restart
        // the numbering of an <ol>.
        if (listType) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          const next = j < lines.length ? lines[j].trim() : "";
          const continuesList =
            (listType === "ul" && isUl(next)) ||
            (listType === "ol" && isOl(next));
          if (!continuesList) closeList();
        }
        continue;
      }
      if (trimmed.startsWith("# ")) { closeList(); htmlLines.push(`<h1>${inlineFormat(trimmed.slice(2))}</h1>`); }
      else if (trimmed.startsWith("## ")) { closeList(); htmlLines.push(`<h2>${inlineFormat(trimmed.slice(3))}</h2>`); }
      else if (trimmed.startsWith("### ")) { closeList(); htmlLines.push(`<h3>${inlineFormat(trimmed.slice(4))}</h3>`); }
      else if (trimmed.startsWith("#### ")) { closeList(); htmlLines.push(`<h4>${inlineFormat(trimmed.slice(5))}</h4>`); }
      else if (trimmed.startsWith("---")) { closeList(); htmlLines.push("<hr>"); }
      else if (isUl(trimmed)) {
        if (listType !== "ul") { closeList(); htmlLines.push("<ul>"); listType = "ul"; }
        htmlLines.push(`<li>${inlineFormat(trimmed.slice(2))}</li>`);
      } else if (isOl(trimmed)) {
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
    data: { projectId: string; agentId: string; researchQuestion: string; prompt: string; topic?: string; orchestratorName?: string | null; agentDescription?: string | null; userId?: string; journalId?: string; fullTextCount?: number; includeArxiv?: boolean },
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

      if (fsFetchFailed) {
        await emitLREvent("paper-fetch", `Future Science fetch failed: ${fsFetchFailureReason}. Continuing with ${projectPapersData.length} paper(s) from project log.`);
      } else if (fsAbstracts.length === 0) {
        await emitLREvent("paper-fetch", `Future Science initiative "${lrJournalId}" has no contributions. Using ${projectPapersData.length} paper(s) from project log.`);
      } else if (filteredAbstracts.length === 0) {
        await emitLREvent("paper-fetch", `Fetched ${fsAbstracts.length} paper(s) from Future Science but all were existing literature reviews and were filtered out. Using ${projectPapersData.length} paper(s) from project log.`);
      } else {
        await emitLREvent("paper-fetch", `Fetched ${fsAbstracts.length} unique paper(s) from Future Science (filtered to ${filteredAbstracts.length} after removing existing LRs). Using Future Science as the sole source (the synced project log is skipped).`);
      }

      // Number of top-ranked papers Stage 5 will read in full text (rest stay abstract-only).
      // The cap scales with the selected model's context window (see getReadingBudget),
      // so bigger models read more papers in full and the input budget grows with them.
      const readingBudget = getReadingBudget(modelConfig || { providerMode: "platform", provider: "openrouter", modelName: "" });
      const FULL_TEXT_TARGET = Math.min(readingBudget.maxFullTextPapers, Math.max(1, data.fullTextCount ?? readingBudget.maxFullTextPapers));
      // Keep the shortlist at least 3× the full-text read target so the full-text stage
      // always has a healthy candidate pool (e.g. 45 papers when 15 are read in full).
      // Scales with whatever fullTextCount the run uses; if fewer relevant candidates
      // exist, all of them are kept.
      const SHORTLIST_SIZE = FULL_TEXT_TARGET * 3;
      const MAX_SELECTED_PAPERS = SHORTLIST_SIZE;
      const MAX_INPUT_TOKENS = readingBudget.maxInputTokens;

      const lrInitiativeSlug = INITIATIVE_SLUGS[lrJournalId] || "papers";
      const fsPaperUrl = (docId: string | undefined) => docId ? `https://future-science.org/${lrInitiativeSlug}/${docId}` : "";
      type CorpusPaper = { title: string; authors: string; date: string; abstract: string; url: string; documentId: string; fullText?: string };
      type Candidate = CorpusPaper & { keywords: string[] };

      // The Mirror project log is just a synced copy of Future Science contributions, so
      // when Future Science returns papers we treat it as the sole source. The project log
      // is kept purely as a resilience fallback for when the FS fetch fails or is empty.
      const fsHasPapers = filteredAbstracts.length > 0;
      const projectCorpus: CorpusPaper[] = projectPapersData.map(p => ({ title: p.title, authors: p.authors, date: p.date, abstract: p.description, url: p.sourceDocumentId ? fsPaperUrl(p.sourceDocumentId) : "", documentId: p.sourceDocumentId || "" }));
      const candidates: Candidate[] = fsHasPapers
        ? filteredAbstracts.map(a => ({ title: a.title, authors: a.authors, date: a.date, abstract: a.abstract, url: fsPaperUrl(a.documentId), documentId: a.documentId || "", keywords: Array.isArray(a.keywords) ? a.keywords : [] }))
        : projectCorpus.map(p => ({ ...p, keywords: [] as string[] }));
      const corpusSource: "future-science" | "project-log-fallback" = fsHasPapers ? "future-science" : "project-log-fallback";

      // Resolve the model config up front — the selection stages below call the model too.
      const config = modelConfig || { providerMode: "platform" as const, provider: "openrouter", modelName: "deepseek/deepseek-chat" };
      if (config.providerMode === "byoc" && !config.apiKey && data.userId) {
        const storedKey = getEphemeralKey(data.userId, config.provider);
        if (storedKey) config.apiKey = storedKey;
      }
      const model = resolveModelName(config);

      // Best-effort JSON extraction from a model response (handles code fences / stray prose).
      const parseJsonLoose = (text: string): any => {
        if (!text) return null;
        let t = text.trim();
        const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence) t = fence[1].trim();
        const startIdx = t.search(/[\[{]/);
        if (startIdx > 0) t = t.slice(startIdx);
        const endIdx = Math.max(t.lastIndexOf("]"), t.lastIndexOf("}"));
        if (endIdx >= 0) t = t.slice(0, endIdx + 1);
        try { return JSON.parse(t); } catch { return null; }
      };

      // STAGE 3 — LLM shortlist: keep only papers whose title and keyword tags relate to the question.
      const llmSelectByKeywords = async (papers: Candidate[]): Promise<number[] | null> => {
        const list = papers.map((p, i) => `${i}: ${p.title} — keywords: ${p.keywords.length ? p.keywords.join(", ") : "(none)"}`).join("\n");
        const sys = "You are a research librarian deciding which papers belong in a literature review. Judge each paper by whether its title AND keyword tags are topically related to the research question. Reply with a JSON array of the integer indices to KEEP and nothing else.";
        const user = `Research question: ${data.researchQuestion}\n\nPapers (index: title — keywords):\n${list}\n\nReturn a JSON array of the indices whose title and keywords are topically related to the research question, e.g. [0,3,4]. Keep every paper that is plausibly related; return [] only if none relate.`;
        try {
          const r = await generateWithConfig(config, sys, user, { maxTokens: 1200, temperature: 0 });
          const parsed = parseJsonLoose(r.content);
          if (!Array.isArray(parsed)) return null;
          const idxs = parsed.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n) && n >= 0 && n < papers.length);
          return Array.from(new Set(idxs));
        } catch (e) {
          console.error(`[LR ${reviewId}] LLM keyword filter failed:`, e);
          return null;
        }
      };

      // STAGE 4 — LLM abstract scoring: score each selected paper 0-100 for closeness to the topic.
      const llmScoreByAbstract = async (papers: Candidate[]): Promise<number[] | null> => {
        const list = papers.map((p, i) => `${i}: ${p.title}\nAbstract: ${(p.abstract || "").slice(0, 600)}`).join("\n\n");
        const sys = "You score how closely each paper matches a research question, using its abstract. Score each paper from 0 (unrelated) to 100 (directly on-topic). Reply with a JSON array of {\"i\": index, \"s\": score} objects and nothing else.";
        const user = `Research question: ${data.researchQuestion}\n\nPapers:\n${list}\n\nReturn JSON like [{"i":0,"s":88},{"i":1,"s":12}] with an entry for every index.`;
        try {
          const r = await generateWithConfig(config, sys, user, { maxTokens: 1500, temperature: 0 });
          const parsed = parseJsonLoose(r.content);
          if (!Array.isArray(parsed)) return null;
          const scores: number[] = new Array(papers.length).fill(0);
          for (const item of parsed) {
            const i = Number(item?.i);
            const s = Number(item?.s);
            if (Number.isInteger(i) && i >= 0 && i < papers.length && !Number.isNaN(s)) scores[i] = s;
          }
          return scores;
        } catch (e) {
          console.error(`[LR ${reviewId}] LLM abstract scoring failed:`, e);
          return null;
        }
      };

      // STAGE 3: relevance pre-filter.
      // The LLM keyword pre-filter only makes sense when papers carry keyword tags.
      // Future Science contributions currently expose NO keywords, so judging by
      // keywords collapses the pool to ~1 paper. When no candidate has keyword tags,
      // rank by deterministic title/abstract relevance instead.
      // A deterministic pre-rank also bounds the candidate set before the (token-heavy)
      // abstract-scoring stage so the whole corpus can be fetched without blowing limits.
      // Keep the pool at least 3× the full-text read target so the caps never trim the
      // shortlist below what the full-text stage will draw from.
      const PRE_SCORE_LIMIT = SHORTLIST_SIZE;
      let selected: Candidate[] = candidates;
      let keywordFilterMode: "llm" | "fallback" | "deterministic" | "skipped" = "skipped";
      if (fsHasPapers && candidates.length > 1) {
        // Only trust the keyword-LLM filter when keyword tags are reasonably common;
        // if most papers lack tags, keyword-only judging over-prunes the pool.
        const keywordCoverage = candidates.filter(c => c.keywords.length > 0).length / candidates.length;
        const hasUsableKeywords = keywordCoverage >= 0.3;
        if (hasUsableKeywords) {
          await emitLREvent("keyword-filter", `Shortlisting ${candidates.length} paper(s) by title + keyword relevance to the research question with the model.`);
          const idxs = await llmSelectByKeywords(candidates);
          if (idxs && idxs.length > 0) {
            keywordFilterMode = "llm";
            selected = idxs.map(i => candidates[i]);
            await emitLREvent("keyword-filter", `Title + keyword shortlist selected ${selected.length} of ${candidates.length} paper(s) whose title and keywords relate to the question.`);
          } else {
            keywordFilterMode = "fallback";
            const { relevant } = scoreRelevance(candidates, data.researchQuestion);
            selected = (relevant.length > 0 ? relevant : candidates) as Candidate[];
            await emitLREvent("keyword-filter", `LLM keyword scoring unavailable; fell back to deterministic title/abstract matching (${selected.length} paper(s)).`);
          }
        } else {
          // Too few papers carry keyword tags — rank by title/abstract relevance instead.
          keywordFilterMode = "deterministic";
          const { relevant } = scoreRelevance(candidates, data.researchQuestion);
          selected = (relevant.length > 0 ? relevant : candidates) as Candidate[];
          await emitLREvent("keyword-filter", `Journal papers have no keyword tags; ranked ${candidates.length} paper(s) by title/abstract relevance and kept ${selected.length}.`);
        }
        // Bound the set handed to the token-heavy abstract-scoring stage.
        if (selected.length > PRE_SCORE_LIMIT) selected = selected.slice(0, PRE_SCORE_LIMIT);
      }

      // STAGE 4: abstract scoring / ranking (LLM, with fallback to keyword-selection order).
      let abstractScoreMode: "llm" | "fallback" | "skipped" = "skipped";
      if (selected.length > 1) {
        await emitLREvent("abstract-score", `Reading ${selected.length} abstract(s) and scoring each for closeness to the topic with the model.`);
        const scores = await llmScoreByAbstract(selected);
        if (scores) {
          abstractScoreMode = "llm";
          selected = selected
            .map((p, i) => ({ p, s: scores[i] ?? 0 }))
            .sort((a, b) => b.s - a.s)
            .map(x => x.p);
          await emitLREvent("abstract-score", `Abstract scoring complete; ${selected.length} paper(s) ranked by closeness to the topic.`);
        } else {
          abstractScoreMode = "fallback";
          await emitLREvent("abstract-score", `LLM abstract scoring unavailable; keeping the keyword-selection order.`);
        }
      }

      if (selected.length > MAX_SELECTED_PAPERS) selected = selected.slice(0, MAX_SELECTED_PAPERS);

      // Downstream code works on relevantPapers/backgroundPapers; the new funnel produces a
      // single ranked list, so relevantPapers = the ranked selection and there is no separate
      // background tier.
      let relevantPapers: CorpusPaper[] = selected.map(({ keywords, ...rest }) => rest);
      let backgroundPapers: CorpusPaper[] = [];

      const allPaperSources = [...relevantPapers, ...backgroundPapers];

      // STAGE 5 — Read the FULL TEXT of the top-ranked papers (the rest stay abstract-only).
      // FULL_TEXT_TARGET is declared above (the shortlist is sized to 3× of it).
      // Cap each paper's full text at its ~8k-token share (in characters) so a whole paper
      // can actually use its budget instead of being cut to a small excerpt.
      const FULL_TEXT_PER_PAPER_CHARS = readingBudget.fullTextPerPaperChars;
      // relevantPapers is the ranked selection, so the top-ranked ones with a Future Science
      // documentId are the ones we read in full.
      const fullTextCandidates: CorpusPaper[] = relevantPapers
        .filter(p => p.documentId)
        .slice(0, FULL_TEXT_TARGET);
      const fullTextLog: Array<{ title: string; documentId: string; readFullText: boolean }> = [];
      if (fullTextCandidates.length > 0) {
        await emitLREvent("full-text-read", `Reading the full text of the ${fullTextCandidates.length} most relevant paper(s); the remaining papers are analyzed from their abstracts.`);
        await Promise.all(fullTextCandidates.map(async (p) => {
          try {
            const text = await fetchFsPaperContent(p.documentId, lrInitiativeSlug);
            const cleaned = (text || "").trim();
            if (cleaned.length > 0) {
              p.fullText = cleaned.length > FULL_TEXT_PER_PAPER_CHARS
                ? cleaned.slice(0, FULL_TEXT_PER_PAPER_CHARS - 1).trimEnd() + "…"
                : cleaned;
            }
          } catch (e) {
            console.error(`[LR ${reviewId}] Full-text fetch failed for "${p.title}" (${p.documentId}):`, e);
          }
          fullTextLog.push({ title: p.title, documentId: p.documentId, readFullText: Boolean(p.fullText) });
        }));
        const readCount = fullTextLog.filter(f => f.readFullText).length;
        await emitLREvent("full-text-read", `Full text retrieved for ${readCount}/${fullTextCandidates.length} paper(s); any that could not be fetched fall back to their abstract.`);
      }

      // Render one corpus entry, preferring full text when available, else the abstract.
      const formatPaperEntry = (p: CorpusPaper, i: number) =>
        `Paper ${i + 1}:\nTitle: ${p.title}\nAuthors: ${p.authors}\nDate: ${p.date}${p.url ? `\nURL: ${p.url}` : ""}\n${p.fullText ? `Full Text (excerpt):\n${p.fullText}` : `Abstract/Summary: ${p.abstract}`}`;

      const includeArxiv = data.includeArxiv !== false;
      const searchTerms = data.researchQuestion.trim().length > 0 ? data.researchQuestion.trim() : data.researchQuestion.split(/\s+/).filter(w => w.length > 4).slice(0, 6).join(" ");
      let arxivResults: Awaited<ReturnType<typeof searchArxiv>> = [];
      if (includeArxiv) {
        console.log(`Literature review ${reviewId}: arXiv retrieval for "${searchTerms}"`);
        await emitLREvent("arxiv-search", `Searching arXiv for recent papers matching: "${searchTerms}"`);
        arxivResults = await searchArxiv(searchTerms);
        await emitLREvent("arxiv-search", `arXiv search returned ${arxivResults.length} result(s).`);
      } else {
        await emitLREvent("arxiv-search", "arXiv external context disabled for this run; using the journal corpus only.");
      }
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

      const systemPrompt = data.prompt;
      const allFSPapers = [...relevantPapers, ...backgroundPapers];
      let papersSection = "";
      if (allFSPapers.length > 0) {
        const allPaperTexts = allFSPapers.map((p, i) => formatPaperEntry(p, i));
        papersSection += `\n\nJOURNAL CORPUS — ${allFSPapers.length} PAPERS (you MUST cite and discuss EVERY one of these):\n\n${allPaperTexts.join("\n\n---\n\n")}`;
      }

      const paperCitationChecklist = allFSPapers.length > 0
        ? `\n\n---\n\nCITATION CHECKLIST — You MUST cite each of these ${allFSPapers.length} papers at least once in the review body AND include each in the References section. Use the URL in markdown link format for each citation. Do NOT skip any paper:\n${allFSPapers.map((p, i) => `${i + 1}. "${p.title}" by ${p.authors}${p.url ? ` — ${p.url}` : ""}`).join("\n")}`
        : "";

      let userMessage = `Research question: ${data.researchQuestion}${data.topic ? `\nTopic: ${data.topic}` : ""}${papersSection}${arxivTexts ? `\n\n---\n\nEXTERNAL CONTEXT FROM ARXIV — Use these papers to establish the broader research context in the Introduction section. Cite them as (Author et al., Date) or (arXiv: ID):\n\n${arxivTexts}` : ""}${paperCitationChecklist}`;

      const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);
      const fullTextPaperCount = [...relevantPapers, ...backgroundPapers].filter(p => p.fullText).length;
      let estimatedInput = estimateTokens(systemPrompt + userMessage);
      // Trim only abstract-only papers to fit the budget; never silently drop the full-text papers the user asked to read.
      while (estimatedInput > MAX_INPUT_TOKENS && (relevantPapers.length + backgroundPapers.length) > Math.max(fullTextPaperCount, 1)) {
        if (backgroundPapers.length > 0) {
          backgroundPapers = backgroundPapers.slice(0, -1);
        } else {
          relevantPapers = relevantPapers.slice(0, -1);
        }
        const trimmedAllPapers = [...relevantPapers, ...backgroundPapers];
        const trimmedPaperTexts = trimmedAllPapers.map((p, i) => formatPaperEntry(p, i));
        let trimmedPapers = "";
        if (trimmedPaperTexts.length > 0) {
          trimmedPapers += `\n\nJOURNAL CORPUS — ${trimmedAllPapers.length} PAPERS (you MUST cite and discuss EVERY one of these):\n\n${trimmedPaperTexts.join("\n\n---\n\n")}`;
        }
        const trimmedChecklist = trimmedAllPapers.length > 0
          ? `\n\n---\n\nCITATION CHECKLIST — You MUST cite each of these ${trimmedAllPapers.length} papers at least once in the review body AND include each in the References section. Use the URL in markdown link format for each citation. Do NOT skip any paper:\n${trimmedAllPapers.map((p, i) => `${i + 1}. "${p.title}" by ${p.authors}${p.url ? ` — ${p.url}` : ""}`).join("\n")}`
          : "";
        userMessage = `Research question: ${data.researchQuestion}${data.topic ? `\nTopic: ${data.topic}` : ""}${trimmedPapers}${arxivTexts ? `\n\n---\n\nEXTERNAL CONTEXT FROM ARXIV — Use these papers to establish the broader research context in the Introduction section. Cite them as (Author et al., Date) or (arXiv: ID):\n\n${arxivTexts}` : ""}${trimmedChecklist}`;
        estimatedInput = estimateTokens(systemPrompt + userMessage);
      }
      if (relevantPapers.length + backgroundPapers.length < allPaperSources.length) {
        console.log(`Literature review ${reviewId}: Trimmed papers from ${allPaperSources.length} to ${relevantPapers.length + backgroundPapers.length} to fit within ~${MAX_INPUT_TOKENS} token budget (estimated ${estimatedInput} tokens).`);
      }

      // If even the full-text papers alone exceed the model budget, stop instead of silently dropping them.
      if (estimatedInput > MAX_INPUT_TOKENS) {
        const remainingFullText = [...relevantPapers, ...backgroundPapers].filter(p => p.fullText);
        const fullTextTokens = remainingFullText.reduce((sum, p, i) => sum + estimateTokens(formatPaperEntry(p, i)), 0);
        const overheadTokens = Math.max(0, estimatedInput - fullTextTokens);
        const avgPerPaper = remainingFullText.length > 0 ? fullTextTokens / remainingFullText.length : Math.max(1, fullTextTokens);
        const recommendedMax = Math.max(1, Math.floor((MAX_INPUT_TOKENS - overheadTokens) / Math.max(1, avgPerPaper)));
        const overBudgetMsg = `The ${remainingFullText.length} full-text paper(s) selected total roughly ${estimatedInput.toLocaleString()} tokens, which exceeds this model's input budget of about ${MAX_INPUT_TOKENS.toLocaleString()} tokens. Lower the "full text" count to about ${recommendedMax} paper(s) or fewer and generate again.`;
        console.log(`Literature review ${reviewId}: aborting before LLM call — ${overBudgetMsg}`);
        await emitLREvent("failure", overBudgetMsg);
        await storage.updateLiteratureReview(reviewId, {
          status: "failed",
          contentHtml: `<p>${overBudgetMsg}</p>`,
        });
        return;
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
        selection: {
          keywordFilterMode,
          abstractScoreMode,
          candidateCount: candidates.length,
          selectedCount: relevantPapers.length + backgroundPapers.length,
        },
        arxivResults: arxivResults.map(r => ({ arxivId: r.arxivId, title: r.title, authors: r.authors })),
        corpusSource,
        fullTextSettings: { requested: FULL_TEXT_TARGET, includeArxiv },
        fullTextPapers: fullTextLog,
        abstractOnlyPapers: [...relevantPapers, ...backgroundPapers]
          .filter(p => !p.fullText)
          .map(p => ({ title: p.title, documentId: p.documentId })),
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
          "Generated review did not contain a parseable Abstract section; composing a substantive abstract from the review's own conclusion/findings instead.",
        );
        extractedAbstract = buildLiteratureReviewFallbackAbstract({
          researchQuestion: data.researchQuestion,
          contentMarkdown: cleanReviewText,
        });
        // Keep the locally-stored review consistent with what was submitted: prepend the
        // fallback abstract to the body so the UI shows the same text as the FS metadata.
        cleanReviewText = `## Abstract\n\n${extractedAbstract}\n\n${cleanReviewText}`;
      }

      const rawHtml = markdownToHtml(cleanReviewText);
      const safeHtml = sanitizeHtml(rawHtml);

      const submissionKeywords = parsedKeywords.length >= 3
        ? parsedKeywords
        : parsedKeywords.concat(fsKeywords.slice(0, Math.max(0, 5 - parsedKeywords.length)));

      const updates: Partial<LiteratureReview> = {
        contentMarkdown: cleanReviewText,
        contentHtml: safeHtml,
        status: "completed",
        completedAt: new Date(),
      };
      // Persist the exact keywords/abstract used for submission inside the existing
      // sourceTrace JSON (no new column) so a later manual retry can re-publish faithfully.
      try {
        const stObj = JSON.parse(sourceTrace);
        stObj.submission = { keywords: submissionKeywords, abstract: extractedAbstract };
        updates.sourceTrace = JSON.stringify(stObj);
      } catch {}

      let publishedToFS = false;
      if (!process.env.FUTURE_SCIENCE_API_KEY) {
        console.warn(`Literature review ${reviewId}: FUTURE_SCIENCE_API_KEY not set — skipping Future Science submission.`);
        await emitLREvent("fs-submission-skipped", "Future Science submission skipped: FUTURE_SCIENCE_API_KEY is not configured.");
      } else {
        try {
          const robotAgentName = buildConventionName(model, data.agentId || "bLR");
          const humanOrchestratorName = data.orchestratorName && data.orchestratorName !== robotAgentName
            ? data.orchestratorName
            : undefined;
          console.log(`[LR ${reviewId}] Future Science submission metadata summary:`, {
            agentName: robotAgentName,
            orchestratorName: humanOrchestratorName || null,
            hasAgentDescription: Boolean(data.agentDescription),
            keywordCount: submissionKeywords.length,
          });
          const subResult = await submitLiteratureReviewToFutureScience({
            title: `Literature Review: ${data.researchQuestion}`,
            markdownContent: cleanReviewText,
            abstract: extractedAbstract,
            keywords: submissionKeywords,
            agentName: robotAgentName,
            orchestratorName: humanOrchestratorName,
            agentDescription: data.agentDescription,
          });

          if (subResult) {
            updates.publishedDocumentId = subResult.documentId;
            publishedToFS = true;
            await emitLREvent("fs-submission-success", `Literature review submitted to Future Science successfully. Document ID: ${subResult.documentId}`);
            console.log(`Literature review ${reviewId} submitted to Future Science: ${subResult.documentId}`);
          } else {
            await emitLREvent("fs-submission-failed", "Future Science submission failed after multiple attempts (their media service returned an error). The review is saved here — you can try publishing again later.");
          }
        } catch (err) {
          console.error("Future Science submission failed (non-fatal):", err);
          const errMsg = err instanceof Error ? err.message : "Unknown error";
          await emitLREvent("fs-submission-failed", `Future Science submission failed: ${errMsg}`);
        }
      }

      await storage.updateLiteratureReview(reviewId, updates);
      const completedMsg = publishedToFS
        ? `Literature review published to Future Science successfully: "${data.researchQuestion}"`
        : `Literature review generated and saved: "${data.researchQuestion}". It was NOT published to Future Science — see the submission message above.`;
      await emitLREvent("completed", completedMsg);

      console.log(`Literature review ${reviewId} completed (Future Science published: ${publishedToFS}).`);
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

  const ethicsRateLimit = new Map<string, number>();

  app.get("/api/ethics-reports/default-prompts", (req, res) => {
    const journalIdRaw = (req.query.journalId as string | undefined) || "";
    const substitution = journalIdRaw && JOURNAL_DISPLAY_NAMES[journalIdRaw]
      ? JOURNAL_DISPLAY_NAMES[journalIdRaw]
      : "this journal";
    res.json({
      prompt1: applyJournalName(H_SOLO_REPORT_CHUNK_1_PROMPT, substitution),
      prompt2: applyJournalName(H_SOLO_REPORT_CHUNK_2_PROMPT, substitution),
      prompt3: applyJournalName(H_SOLO_REPORT_CHUNK_3_PROMPT, substitution),
      singlePaperPrompt: applyJournalName(H_SINGLE_PAPER_PROMPT, substitution),
    });
  });

  // List Mirror papers available for a single-paper ethics audit, each with an `alreadyReviewed` flag.
  app.get("/api/ethics-reports/available-papers", async (req, res) => {
    try {
      const journalId = (req.query.journalId as string | undefined) || "mirror";
      const initiativeDocId = INITIATIVE_DOC_IDS[journalId];
      if (!initiativeDocId) return res.status(400).json({ error: "Unknown journal." });
      const initiativeSlug = INITIATIVE_SLUGS[journalId] || journalId;

      const [fsData, lockedIds, projectPapers] = await Promise.all([
        fetchAbstractsAndKeywords([], initiativeDocId).catch(() => ({ abstracts: [] })),
        storage.getAuditedPaperIdsForJournal(journalId),
        storage.getProjectPapers(journalId),
      ]);
      const lockedSet = new Set(lockedIds);

      // Filter out our own published outputs from the audit-target list:
      // publication audits, field-level audits, literature reviews, and
      // editorials. These were published to the same FS initiative and would
      // otherwise show up here as "papers" to audit. Both old (ethics-audit)
      // and new (publication-audit) title prefixes are matched for back-compat.
      const isOwnPublication = (title: string, authors: string): boolean => {
        const t = (title || "").toLowerCase().trim();
        const a = (authors || "").toLowerCase();
        if (t.startsWith("single-paper ethics audit") || t.startsWith("publication audit")) return true;
        if (t.startsWith("field ethics report") || t.startsWith("publication audit field report")) return true;
        if (t.startsWith("literature review:")) return true;
        if (t.startsWith("editorial:")) return true;
        // Author-based fallback for MachInstit ethics / lit-review / editorialist agents.
        if (/machinstit\s+\S+(h|ber|blr|alr|o)-n\d/.test(a)) return true;
        return false;
      };

      // Combine FS abstracts with project papers, dedup by documentId/title
      const seen = new Set<string>();
      const out: Array<{ documentId: string; title: string; authors: string; date: string; url: string; alreadyReviewed: boolean }> = [];
      for (const a of fsData.abstracts) {
        const key = a.documentId;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (isOwnPublication(a.title, a.authors)) continue;
        const isReviewed = lockedSet.has(`doc:${a.documentId}`) || lockedSet.has(`title:${a.title.toLowerCase().trim()}`);
        out.push({
          documentId: a.documentId,
          title: a.title,
          authors: a.authors,
          date: a.date,
          url: `https://future-science.org/${initiativeSlug}/${a.documentId}`,
          alreadyReviewed: isReviewed,
        });
      }
      for (const p of projectPapers) {
        if (!p.sourceDocumentId || seen.has(p.sourceDocumentId)) continue;
        seen.add(p.sourceDocumentId);
        if (isOwnPublication(p.title, p.authors)) continue;
        const isReviewed = lockedSet.has(`doc:${p.sourceDocumentId}`) || lockedSet.has(`title:${p.title.toLowerCase().trim()}`);
        out.push({
          documentId: p.sourceDocumentId,
          title: p.title,
          authors: p.authors,
          date: p.date,
          url: p.url || `https://future-science.org/${initiativeSlug}/${p.sourceDocumentId}`,
          alreadyReviewed: isReviewed,
        });
      }
      out.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      res.json({ papers: out, lockedCount: lockedIds.length });
    } catch (err: any) {
      console.error("Error listing available papers:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin: delete a single ethics report
  app.delete("/api/ethics-reports/:id", adminAuth, async (req, res) => {
    try {
      await storage.deleteEthicsReport(String(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      console.error("Error deleting ethics report:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin: republish an existing ethics report to Future Science.
  // Useful when the original FS submission failed (publishedDocumentId is empty)
  // — re-runs only the FS submission step using the already-stored report content.
  app.post("/api/ethics-reports/:id/republish", adminAuth, async (req, res) => {
    try {
      const reportId = String(req.params.id);
      const report = await storage.getEthicsReportById(reportId);
      if (!report) return res.status(404).json({ error: "Ethics report not found." });
      if (report.status !== "completed") {
        return res.status(400).json({ error: `Report is not completed (status: ${report.status}).` });
      }
      if (!report.contentMarkdown || !report.reportTitle || !report.reportAbstract) {
        return res.status(400).json({ error: "Report is missing content/title/abstract." });
      }
      if (!process.env.FUTURE_SCIENCE_API_KEY) {
        return res.status(500).json({ error: "FUTURE_SCIENCE_API_KEY is not configured." });
      }

      const initiativeDocId = INITIATIVE_DOC_IDS[report.journalId] || INITIATIVE_DOC_IDS["mirror"];
      const robotAgentName = buildConventionName(report.modelName || "", report.agentId || "H");
      const humanOrchestratorName = report.orchestratorName && report.orchestratorName !== robotAgentName
        ? report.orchestratorName
        : undefined;
      const submissionKeywords = (report.keywords?.length ?? 0) >= 3
        ? report.keywords.slice(0, 8)
        : ["ethics", "ai research", "automated science", ...(report.keywords || [])].slice(0, 5);
      const linkOriginalContribution = report.documentId
        ? `https://future-science.org/${report.journalId}/${report.documentId}`
        : undefined;
      let republishFlags: EthicsFlag[] = [];
      try {
        republishFlags = JSON.parse(report.flagsJson || "[]");
      } catch {}
      if (!republishFlags.length) {
        republishFlags = extractFlags(report.contentMarkdown);
      }
      const { major: ethicsMajor, minor: ethicsMinor } = flagsToRevisions(republishFlags);

      const subResult = await submitEthicsReportToFutureScience({
        title: report.reportTitle,
        markdownContent: report.contentMarkdown,
        abstract: report.reportAbstract,
        keywords: submissionKeywords,
        agentName: robotAgentName,
        initiativeDocId,
        initiativeSlug: report.journalId,
        orchestratorName: humanOrchestratorName,
        agentDescription: report.agentDescription || undefined,
        linkOriginalContribution,
        majorRevisions: ethicsMajor,
        minorRevisions: ethicsMinor,
      });

      if (!subResult) {
        return res.status(502).json({ error: "Future Science rejected all fallback types. See server logs." });
      }
      await storage.updateEthicsReport(reportId, { publishedDocumentId: subResult.documentId });
      await storage.createResearchEvent({
        source: robotAgentName,
        agentId: report.agentId || "H",
        phase: "fs-submission-success",
        message: `Ethics report republished to Future Science. Document ID: ${subResult.documentId}`,
      });
      res.json({ success: true, documentId: subResult.documentId, url: subResult.url });
    } catch (err: any) {
      console.error("Error republishing ethics report:", err);
      res.status(500).json({ error: err?.message || "Internal server error" });
    }
  });

  // ============ PEER REVIEW ROUTES ============

  app.get("/api/peer-reviews/status", optionalAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const PLATFORM_ACCESS_EMAILS = ["jevans@uchicago.edu", "sacharaoult@gmail.com", "akozlo@uchicago.edu"];
      const limitConfig = PER_USER_PLATFORM_LIMITS["peer-review"];
      if (!user) return res.json({ remaining: limitConfig.max, resetAt: null, count: 0 });
      if (PLATFORM_ACCESS_EMAILS.includes(user.email)) return res.json({ remaining: null, resetAt: null, count: 0 });
      const currentLimit = await storage.getUserRateLimit(user.id, "peer-review");
      if (!currentLimit) return res.json({ remaining: limitConfig.max, resetAt: null, count: 0 });
      const elapsed = Date.now() - currentLimit.windowStart.getTime();
      if (elapsed >= limitConfig.windowMs) return res.json({ remaining: limitConfig.max, resetAt: null, count: 0 });
      return res.json({
        remaining: Math.max(0, limitConfig.max - currentLimit.count),
        resetAt: currentLimit.windowStart.getTime() + limitConfig.windowMs,
        count: currentLimit.count,
      });
    } catch (err: any) {
      console.error("Error getting peer-review status:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/peer-reviews/default-prompts", (req, res) => {
    const persona = (req.query.persona as string | undefined) || "bR";
    if (persona === "aR") return res.json({ prompt: AR_PROMPT });
    if (persona === "iR") return res.json({ prompt: IR_PROMPT });
    if (persona === "rR") return res.json({ prompt: RR_PROMPT });
    return res.json({ prompt: BR_PROMPT });
  });

  app.get("/api/peer-reviews/available-papers", async (req, res) => {
    try {
      const journalId = (req.query.journalId as string | undefined) || "mirror";
      const initiativeDocId = INITIATIVE_DOC_IDS[journalId];
      if (!initiativeDocId) return res.status(400).json({ error: "Unknown journal." });
      const initiativeSlug = INITIATIVE_SLUGS[journalId] || journalId;

      const [fsData, reviewedRows, projectPapers] = await Promise.all([
        fetchAbstractsAndKeywords([], initiativeDocId).catch(() => ({ abstracts: [] })),
        storage.getReviewedPaperPersonasForJournal(journalId),
        storage.getProjectPapers(journalId),
      ]);
      const reviewedMap = new Map<string, Set<string>>();
      for (const r of reviewedRows) {
        if (!reviewedMap.has(r.documentId)) reviewedMap.set(r.documentId, new Set());
        reviewedMap.get(r.documentId)!.add(r.persona);
      }

      const isOwnPublication = (title: string, authors: string): boolean => {
        const t = (title || "").toLowerCase().trim();
        const a = (authors || "").toLowerCase();
        if (t.startsWith("single-paper ethics audit") || t.startsWith("publication audit")) return true;
        if (t.startsWith("field ethics report") || t.startsWith("publication audit field report")) return true;
        if (t.startsWith("literature review:")) return true;
        if (t.startsWith("editorial:")) return true;
        if (t.startsWith("basic peer review:") || t.startsWith("adversarial peer review:") || t.startsWith("innovation peer review:") || t.startsWith("rigorous peer review:")) return true;
        if (/machinstit\s+\S+(h|ber|blr|alr|o|br|ar|ir|rr)-n\d/.test(a)) return true;
        return false;
      };

      // Build two maps per documentId:
      //   reviewedPersonas: Set<persona>   — for the display badge (which personas have any review)
      //   lockedCombos: Set<"persona:model"> — for model-aware lock check in the UI
      const reviewedPersonasMap = new Map<string, Set<string>>();
      const lockedCombosMap = new Map<string, Set<string>>();
      for (const r of reviewedRows) {
        if (!reviewedPersonasMap.has(r.documentId)) reviewedPersonasMap.set(r.documentId, new Set());
        reviewedPersonasMap.get(r.documentId)!.add(r.persona);
        if (!lockedCombosMap.has(r.documentId)) lockedCombosMap.set(r.documentId, new Set());
        lockedCombosMap.get(r.documentId)!.add(`${r.persona}:${r.modelName || ""}`);
      }

      const seen = new Set<string>();
      const out: Array<{ documentId: string; title: string; authors: string; date: string; url: string; reviewedPersonas: string[]; lockedCombos: string[] }> = [];
      for (const a of fsData.abstracts) {
        const key = a.documentId;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (isOwnPublication(a.title, a.authors)) continue;
        out.push({
          documentId: a.documentId,
          title: a.title,
          authors: a.authors,
          date: a.date,
          url: `https://future-science.org/${initiativeSlug}/${a.documentId}`,
          reviewedPersonas: Array.from(reviewedPersonasMap.get(a.documentId) || []),
          lockedCombos: Array.from(lockedCombosMap.get(a.documentId) || []),
        });
      }
      for (const p of projectPapers) {
        if (!p.sourceDocumentId || seen.has(p.sourceDocumentId)) continue;
        seen.add(p.sourceDocumentId);
        if (isOwnPublication(p.title, p.authors)) continue;
        out.push({
          documentId: p.sourceDocumentId,
          title: p.title,
          authors: p.authors,
          date: p.date,
          url: p.url || `https://future-science.org/${initiativeSlug}/${p.sourceDocumentId}`,
          reviewedPersonas: Array.from(reviewedPersonasMap.get(p.sourceDocumentId) || []),
          lockedCombos: Array.from(lockedCombosMap.get(p.sourceDocumentId) || []),
        });
      }
      out.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      res.json({ papers: out });
    } catch (err: any) {
      console.error("Error listing peer-review available papers:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/peer-reviews", async (req, res) => {
    try {
      const projectId = req.query.projectId as string | undefined;
      const reviews = projectId
        ? await storage.getPeerReviewsByProject(projectId)
        : await storage.getAllPeerReviews();
      return res.json(reviews);
    } catch (err: any) {
      console.error("Error fetching peer reviews:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/peer-reviews/:id", async (req, res) => {
    try {
      const review = await storage.getPeerReviewById(req.params.id);
      if (!review) return res.status(404).json({ error: "Peer review not found" });
      return res.json(review);
    } catch (err: any) {
      console.error("Error fetching peer review:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/peer-reviews/:id", adminAuth, async (req, res) => {
    try {
      await storage.deletePeerReview(String(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      console.error("Error deleting peer review:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  const peerReviewRateLimit = new Map<string, number>();

  app.post("/api/peer-reviews", requireAuth, async (req, res) => {
    try {
      const {
        projectId, journalId, persona, documentId, paperTitle,
        prompt,
        modelProvider, modelName, providerMode, byocApiKey,
        orchestratorName, agentDescription,
        includeEthicsCoauthor,
      } = req.body;

      const VALID_PROVIDER_MODES = ["platform", "byoc"];
      const VALID_PROVIDERS = ["openai", "anthropic", "openrouter"];
      const VALID_PERSONAS: PeerReviewPersona[] = ["bR", "iR", "aR", "rR"];
      if (providerMode && !VALID_PROVIDER_MODES.includes(providerMode)) return res.status(400).json({ error: "Invalid providerMode." });
      if (modelProvider && !VALID_PROVIDERS.includes(modelProvider)) return res.status(400).json({ error: "Invalid modelProvider." });
      const effectivePersona: PeerReviewPersona = VALID_PERSONAS.includes(persona) ? persona : "bR";

      const PLATFORM_ACCESS_EMAILS = ["jevans@uchicago.edu", "sacharaoult@gmail.com", "akozlo@uchicago.edu"];
      const user = (req as any).user;
      const isPlatform = providerMode !== "byoc";

      if (isPlatform && !PLATFORM_ACCESS_EMAILS.includes(user.email)) {
        return res.status(403).json({ error: "Platform model access is restricted to institute members. Please use Bring Your Own Key mode." });
      }
      if (isPlatform) {
        if (!process.env.OPENROUTER_API_KEY) return res.status(503).json({ error: "Peer review generation is not configured. OPENROUTER_API_KEY is missing." });
        const limitConfig = PER_USER_PLATFORM_LIMITS["peer-review"];
        const rateCheck = await storage.checkAndIncrementRateLimit(user.id, "peer-review", limitConfig.max, limitConfig.windowMs);
        if (!rateCheck.allowed) return res.status(429).json({ error: `Peer review generation limit reached (${limitConfig.max} per 24 hours). Try again later.` });
      }
      if (providerMode === "byoc") {
        if (!byocApiKey) return res.status(400).json({ error: "BYOC mode requires an API key." });
        const keyValidation = await validateApiKey(modelProvider || "openrouter", byocApiKey);
        if (!keyValidation.valid) return res.status(400).json({ error: keyValidation.error || "Invalid BYOC API key." });
        await storeEphemeralKey(user.id, modelProvider || "openrouter", byocApiKey);
      }
      {
        const clientIp = req.ip || "unknown";
        const last = peerReviewRateLimit.get(clientIp) || 0;
        if (Date.now() - last < 30000) return res.status(429).json({ error: "Please wait at least 30 seconds between peer review requests." });
        peerReviewRateLimit.set(clientIp, Date.now());
      }

      const effectiveJournalId = journalId && INITIATIVE_DOC_IDS[journalId] ? journalId : "mirror";
      if (!documentId || typeof documentId !== "string") return res.status(400).json({ error: "documentId is required." });

      const modelConfig: ModelProviderConfig = {
        providerMode: (providerMode === "byoc" ? "byoc" : "platform") as "platform" | "byoc",
        provider: modelProvider || "openrouter",
        modelName: modelName || "",
        apiKey: providerMode === "byoc" ? byocApiKey : undefined,
      };

      // Per-paper-per-persona-per-model lock
      const reviewed = await storage.getReviewedPaperPersonasForJournal(effectiveJournalId);
      const resolvedModelForCheck = resolveModelName(modelConfig);
      if (reviewed.some(r => r.documentId === documentId && r.persona === effectivePersona && r.modelName === resolvedModelForCheck)) {
        return res.status(409).json({ error: `This paper has already been reviewed by the ${effectivePersona} persona using this model. Select a different model to run another review.` });
      }

      const defaultPrompt = getPeerReviewPrompt(effectivePersona);
      const effectivePrompt = prompt || defaultPrompt;
      const effectiveOrchestratorName = orchestratorName || buildConventionName(modelName || "", effectivePersona);
      const includeEthics = !!includeEthicsCoauthor;

      const parsed = insertPeerReviewSchema.safeParse({
        projectId: projectId || effectiveJournalId,
        agentId: effectivePersona,
        journalId: effectiveJournalId,
        persona: effectivePersona,
        documentId,
        paperTitle: paperTitle || null,
        includeEthicsCoauthor: includeEthics,
        prompt1: effectivePrompt,
        prompt2: "",
        prompt3: "",
        userId: user?.id || null,
        orchestratorName: effectiveOrchestratorName,
        agentDescription: agentDescription || null,
        modelProvider: modelConfig.provider,
        modelName: resolveModelName(modelConfig),
        providerMode: modelConfig.providerMode,
      });
      if (!parsed.success) return res.status(400).json({ error: fromZodError(parsed.error).message });

      const review = await storage.createPeerReview(parsed.data);
      if (!review) {
        return res.status(409).json({ error: `This paper has already been reviewed by the ${effectivePersona} persona.` });
      }
      res.status(201).json(review);

      generatePeerReviewBackground(review.id, parsed.data, modelConfig, includeEthics).catch(err => {
        console.error("Background peer review generation failed:", err);
      });
    } catch (err: any) {
      console.error("Error creating peer review:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  async function generatePeerReviewBackground(
    reviewId: string,
    data: { projectId: string; agentId: string; journalId: string; persona: string; documentId: string; paperTitle?: string | null; prompt1: string; prompt2?: string; prompt3?: string; userId?: string | null; orchestratorName?: string | null; agentDescription?: string | null },
    modelConfig: ModelProviderConfig,
    includeEthicsCoauthor: boolean,
  ) {
    const initiativeDocId = INITIATIVE_DOC_IDS[data.journalId] || INITIATIVE_DOC_IDS["mirror"];
    if (modelConfig.providerMode === "byoc" && !modelConfig.apiKey && data.userId) {
      const stored = getEphemeralKey(data.userId, modelConfig.provider);
      if (stored) modelConfig.apiKey = stored;
    }
    const resolvedModel = resolveModelName(modelConfig);
    const persona = data.persona as PeerReviewPersona;
    const robotAgentName = buildConventionName(resolvedModel, persona);
    const ethicsAgentName = buildConventionName(resolvedModel, "H");

    async function emit(phase: string, message: string) {
      try {
        await storage.createResearchEvent({ source: robotAgentName, agentId: persona, phase, message });
      } catch (e) {
        console.error(`[PeerReview ${reviewId}] Failed to emit event:`, e);
      }
    }

    try {
      await storage.updatePeerReview(reviewId, { status: "generating" });
      await emit("peer-review-init", `${persona} peer review started for paper ${data.documentId} in ${data.journalId}.`);

      // Optionally launch ethics co-author pipeline in parallel (or reuse existing completed report).
      let ethicsPromise: Promise<EthicsReviewOutput | null> = Promise.resolve(null);
      let reusedEthicsReportId: string | null = null;
      if (includeEthicsCoauthor) {
        const existingReports = await storage.getEthicsReportsByProject(data.projectId);
        const existing = existingReports.find(r => r.status === "completed" && r.documentId === data.documentId && r.contentMarkdown);
        if (existing) {
          reusedEthicsReportId = existing.id;
          await emit("peer-review-ethics-reuse", `Reusing existing completed ethics audit ${existing.id} for ethics co-author block.`);
          let flagsList: EthicsReviewOutput["flagsList"] = [];
          let recommendations: string[] = [];
          try { flagsList = JSON.parse(existing.flagsJson || "[]"); } catch {}
          try { recommendations = JSON.parse(existing.recommendationsJson || "[]"); } catch {}
          const reused: EthicsReviewOutput = {
            ethicsText: existing.contentMarkdown!,
            chunk1: "", chunk2: "", chunk3: "",
            flagsList,
            recommendations,
            clearanceStatement: existing.clearanceStatement || "",
            clearanceStatus: (existing.clearanceStatus as EthicsReviewOutput["clearanceStatus"]) || "CLEARED_WITH_CONDITIONS",
            reportTitle: existing.reportTitle || "",
            reportAbstract: existing.reportAbstract || "",
            durationSeconds: 0,
            papersUsed: [{ title: existing.paperTitle || "", authors: "", date: "", documentId: data.documentId }],
            auditedPaperIds: existing.auditedPaperIds || [],
          };
          ethicsPromise = Promise.resolve(reused);
        } else {
          await emit("peer-review-ethics-launch", `Launching parallel ethics co-author audit (${ethicsAgentName}).`);
          const ethicsReportInput: InsertEthicsReport = {
            projectId: data.projectId,
            agentId: "H",
            journalId: data.journalId,
            keywords: [],
            researchQuestion: `Publication audit (peer-review co-author) of "${data.paperTitle || data.documentId}" in ${getJournalDisplayName(data.journalId)}`,
            documentId: data.documentId,
            paperTitle: data.paperTitle || null,
            prompt1: H_SINGLE_PAPER_PROMPT,
            prompt2: H_SOLO_REPORT_CHUNK_2_PROMPT,
            prompt3: H_SOLO_REPORT_CHUNK_3_PROMPT,
            userId: data.userId || null,
            orchestratorName: data.orchestratorName || null,
            agentDescription: "Research Standards Verification Agent (H) operating in peer-review co-author mode.",
            modelProvider: modelConfig.provider,
            modelName: resolvedModel,
            providerMode: modelConfig.providerMode,
          };
          const ethicsReport = await storage.createEthicsReport(ethicsReportInput);
          await storage.updateEthicsReport(ethicsReport.id, { status: "generating" });
          // Reserve ethics lock atomically
          const reservedIds = [`doc:${data.documentId}`];
          if (data.paperTitle) reservedIds.push(`title:${data.paperTitle.toLowerCase().trim()}`);
          await storage.updateEthicsReport(ethicsReport.id, { auditedPaperIds: reservedIds });
          reusedEthicsReportId = ethicsReport.id;

          ethicsPromise = (async () => {
            try {
              const eResult = await runEthicsReport({
                reportId: ethicsReport.id,
                projectId: data.projectId,
                agentId: "H",
                agentName: ethicsAgentName,
                journalId: data.journalId,
                journalName: getJournalDisplayName(data.journalId),
                initiativeDocId,
                initiativeSlug: INITIATIVE_SLUGS[data.journalId] || data.journalId,
                journalDisplayName: JOURNAL_DISPLAY_NAMES[data.journalId] || data.journalId,
                keywords: [],
                topic: null,
                prompt1: H_SINGLE_PAPER_PROMPT,
                prompt2: H_SOLO_REPORT_CHUNK_2_PROMPT,
                prompt3: H_SOLO_REPORT_CHUNK_3_PROMPT,
                documentId: data.documentId,
                paperTitle: data.paperTitle || null,
                singlePaperPrompt: H_SINGLE_PAPER_PROMPT,
                modelConfig: { ...modelConfig, modelName: resolvedModel },
                emitEvent: async (phase, msg) => {
                  try { await storage.createResearchEvent({ source: ethicsAgentName, agentId: "H", phase, message: msg }); } catch {}
                },
              });
              const rawHtml = markdownToHtml(eResult.ethicsText);
              const safeHtml = sanitizeHtml(rawHtml);
              await storage.updateEthicsReport(ethicsReport.id, {
                contentMarkdown: eResult.ethicsText,
                contentHtml: safeHtml,
                reportTitle: eResult.reportTitle,
                reportAbstract: eResult.reportAbstract,
                clearanceStatus: eResult.clearanceStatus,
                clearanceStatement: eResult.clearanceStatement,
                flagsJson: JSON.stringify(eResult.flagsList),
                recommendationsJson: JSON.stringify(eResult.recommendations),
                auditedPaperIds: eResult.auditedPaperIds,
                status: "completed",
                completedAt: new Date(),
              });
              return eResult;
            } catch (err) {
              console.error(`[PeerReview ${reviewId}] Ethics co-author pipeline failed:`, err);
              await storage.updateEthicsReport(ethicsReport.id, { status: "failed" });
              return null;
            }
          })();
        }
      }

      // Pass the ethics promise (NOT awaited) so peer-review chunks 1+2 run in parallel with the ethics audit.
      // runPeerReview will await the promise only just before chunk 3 (final synthesis).
      const result = await runPeerReview({
        reviewId,
        projectId: data.projectId,
        persona,
        agentName: robotAgentName,
        journalId: data.journalId,
        initiativeDocId,
        initiativeSlug: INITIATIVE_SLUGS[data.journalId] || data.journalId,
        journalDisplayName: JOURNAL_DISPLAY_NAMES[data.journalId] || data.journalId,
        documentId: data.documentId,
        paperTitle: data.paperTitle || null,
        prompt: data.prompt1,
        modelConfig: { ...modelConfig, modelName: resolvedModel },
        emitEvent: emit,
        ethicsPromise: includeEthicsCoauthor ? ethicsPromise : undefined,
      });

      const rawHtml = markdownToHtml(result.reviewText);
      const safeHtml = sanitizeHtml(rawHtml);

      const promptTrace = JSON.stringify({
        prompt: data.prompt1,
        model: resolvedModel, provider: modelConfig.provider, providerMode: modelConfig.providerMode,
        timestamp: new Date().toISOString(),
      });
      // Only link the ethics report if the parallel ethics audit actually
      // produced a usable result that was integrated into the synthesis.
      const linkedEthicsReportId = result.ethicsUsed ? reusedEthicsReportId : null;

      const sourceTrace = JSON.stringify({
        journalId: data.journalId,
        documentId: data.documentId,
        paperUsed: result.paperUsed,
        ethicsReportId: linkedEthicsReportId,
        ethicsRequested: includeEthicsCoauthor,
        ethicsUsed: result.ethicsUsed,
        ethicsSummary: result.ethicsSummary || null,
        // Persist the derived keywords (sourced from the audited paper's FS
        // keywords + title) so the admin republish path can reproduce the exact
        // same keywords without refetching from Future Science.
        keywords: result.keywords,
      });

      const updates: Partial<PeerReview> = {
        contentMarkdown: result.reviewText,
        contentHtml: safeHtml,
        reviewTitle: result.reviewTitle,
        reviewAbstract: result.reviewAbstract,
        recommendation: result.recommendation,
        promptTrace,
        sourceTrace,
        ethicsReportId: linkedEthicsReportId,
        status: "completed",
        completedAt: new Date(),
      };

      // Submit to Future Science
      if (!process.env.FUTURE_SCIENCE_API_KEY) {
        await emit("fs-submission-skipped", "Future Science submission skipped: FUTURE_SCIENCE_API_KEY is not configured.");
      } else {
        try {
          const humanOrchestratorName = data.orchestratorName && data.orchestratorName !== robotAgentName
            ? data.orchestratorName
            : undefined;
          const linkOriginalContribution = `https://future-science.org/${data.journalId}/${data.documentId}`;
          const subResult = await submitPeerReviewToFutureScience({
            title: result.reviewTitle,
            markdownContent: result.reviewText,
            abstract: result.reviewAbstract,
            keywords: result.keywords,
            agentName: robotAgentName,
            initiativeDocId,
            initiativeSlug: data.journalId,
            orchestratorName: humanOrchestratorName,
            agentDescription: data.agentDescription || undefined,
            linkOriginalContribution,
            ethicsCoauthorName: includeEthicsCoauthor && result.ethicsUsed ? ethicsAgentName : undefined,
            majorRevisions: result.majorRevisions,
            minorRevisions: result.minorRevisions,
          });
          if (subResult) {
            updates.publishedDocumentId = subResult.documentId;
            await emit("fs-submission-success", `Peer review submitted to Future Science. Document ID: ${subResult.documentId}`);
          } else {
            await emit("fs-submission-failed", "Future Science submission failed (non-fatal).");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          await emit("fs-submission-failed", `Future Science submission failed: ${msg}`);
        }
      }

      await storage.updatePeerReview(reviewId, updates);
      await emit("peer-review-completed", `${persona} peer review completed (recommendation: ${result.recommendation}).`);
    } catch (err: any) {
      console.error(`[PeerReview ${reviewId}] Generation failed:`, err);
      const safeError = (err.message || "Unknown error").replace(/[<>&"']/g, "");
      await emit("failure", `Peer review generation failed: ${safeError}`);
      await storage.updatePeerReview(reviewId, {
        status: "failed",
        contentHtml: `<p>Generation failed: ${safeError}</p>`,
      });
    }
  }

  app.post("/api/peer-reviews/:id/republish", adminAuth, async (req, res) => {
    try {
      const reviewId = String(req.params.id);
      const review = await storage.getPeerReviewById(reviewId);
      if (!review) return res.status(404).json({ error: "Peer review not found." });
      if (review.status !== "completed") return res.status(400).json({ error: `Review is not completed (status: ${review.status}).` });
      if (!review.contentMarkdown || !review.reviewTitle || !review.reviewAbstract) {
        return res.status(400).json({ error: "Review is missing content/title/abstract." });
      }
      if (!process.env.FUTURE_SCIENCE_API_KEY) return res.status(500).json({ error: "FUTURE_SCIENCE_API_KEY is not configured." });

      const initiativeDocId = INITIATIVE_DOC_IDS[review.journalId] || INITIATIVE_DOC_IDS["mirror"];
      const robotAgentName = buildConventionName(review.modelName || "", review.persona);
      const humanOrchestratorName = review.orchestratorName && review.orchestratorName !== robotAgentName
        ? review.orchestratorName
        : undefined;
      // Only declare H as co-author on republish if ethics was actually
      // integrated at original generation (i.e. ethicsReportId was stored).
      const ethicsAgentName = review.includeEthicsCoauthor && review.ethicsReportId
        ? buildConventionName(review.modelName || "", "H")
        : undefined;
      const linkOriginalContribution = `https://future-science.org/${review.journalId}/${review.documentId}`;
      const { major: republishMajor, minor: republishMinor } = extractRevisions(review.contentMarkdown);

      // Ensure the Research Standards Verification section is present. Reviews
      // generated before this feature won't have it embedded in their markdown,
      // so rebuild it from the linked ethics report (stored data) when possible.
      let republishMarkdown = review.contentMarkdown;
      if (ethicsAgentName && review.ethicsReportId && !hasVerificationSection(republishMarkdown)) {
        const report = await storage.getEthicsReportById(review.ethicsReportId);
        if (report && report.clearanceStatus) {
          let flags: EthicsFlag[] = [];
          let recommendations: string[] = [];
          try { flags = JSON.parse(report.flagsJson || "[]"); } catch {}
          try { recommendations = JSON.parse(report.recommendationsJson || "[]"); } catch {}
          const verificationSection = buildVerificationSection({
            clearanceStatus: report.clearanceStatus,
            clearanceStatement: report.clearanceStatement || "",
            flags,
            recommendations,
          });
          republishMarkdown = `${republishMarkdown.trimEnd()}\n\n---\n\n${verificationSection}\n`;
        }
      }

      // Reuse the exact keywords persisted at generation time (in sourceTrace)
      // so republish has parity with the original submission. Fall back to
      // re-deriving from stored paper data for legacy reviews that predate the
      // persisted keywords.
      let republishKeywords: string[] | undefined;
      try {
        const parsedSource = review.sourceTrace ? JSON.parse(review.sourceTrace) : null;
        if (parsedSource && Array.isArray(parsedSource.keywords) && parsedSource.keywords.length >= 3) {
          republishKeywords = parsedSource.keywords.filter((k: unknown): k is string => typeof k === "string");
        }
      } catch {}
      if (!republishKeywords || republishKeywords.length < 3) {
        republishKeywords = derivePeerReviewKeywords({
          paperTitle: review.paperTitle,
          persona: review.persona,
        });
      }

      // Re-derive the substantive abstract from stored data so republished
      // reviews (including legacy reviews whose stored abstract is the old
      // boilerplate) get the same informative abstract as freshly generated
      // ones. No new columns: the summary is parsed from contentMarkdown, the
      // revisions are extracted, and the ethics note comes from sourceTrace.
      let republishEthicsSummary: string | null = null;
      try {
        const parsedSource = review.sourceTrace ? JSON.parse(review.sourceTrace) : null;
        if (parsedSource && typeof parsedSource.ethicsSummary === "string") {
          republishEthicsSummary = parsedSource.ethicsSummary;
        }
      } catch {}
      const republishAbstract = buildPeerReviewAbstract({
        title: review.paperTitle || review.reviewTitle,
        persona: review.persona,
        recommendation: review.recommendation,
        summary: extractReviewSummary(review.contentMarkdown),
        majorRevisions: republishMajor,
        minorRevisions: republishMinor,
        ethicsSummary: republishEthicsSummary,
      });

      const subResult = await submitPeerReviewToFutureScience({
        title: review.reviewTitle,
        markdownContent: republishMarkdown,
        abstract: republishAbstract,
        keywords: republishKeywords,
        agentName: robotAgentName,
        initiativeDocId,
        initiativeSlug: review.journalId,
        orchestratorName: humanOrchestratorName,
        agentDescription: review.agentDescription || undefined,
        linkOriginalContribution,
        ethicsCoauthorName: ethicsAgentName,
        majorRevisions: republishMajor,
        minorRevisions: republishMinor,
      });
      if (!subResult) return res.status(502).json({ error: "Future Science rejected all fallback types." });
      await storage.updatePeerReview(reviewId, { publishedDocumentId: subResult.documentId, reviewAbstract: republishAbstract });
      res.json({ success: true, documentId: subResult.documentId, url: subResult.url });
    } catch (err: any) {
      console.error("Error republishing peer review:", err);
      res.status(500).json({ error: err?.message || "Internal server error" });
    }
  });

  // ============ END PEER REVIEW ROUTES ============

  // Admin: delete a single literature review
  app.delete("/api/literature-reviews/:id", adminAuth, async (req, res) => {
    try {
      await storage.deleteLiteratureReview(String(req.params.id));
      res.json({ success: true });
    } catch (err: any) {
      console.error("Error deleting literature review:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Manually retry publishing a completed-but-unpublished literature review to Future Science.
  // Allowed for the review's owner or an admin. Reconstructs the submission from the stored
  // record (no regeneration) so a transient FS failure can be recovered without re-running the LLM.
  app.post("/api/literature-reviews/:id/republish", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      const ADMIN_EMAIL = "sacharaoult@gmail.com";
      const review = await storage.getLiteratureReviewById(String(req.params.id));
      if (!review) return res.status(404).json({ error: "Literature review not found." });

      const isOwner = review.userId && review.userId === user.id;
      const isAdmin = user.email === ADMIN_EMAIL;
      if (!isOwner && !isAdmin) {
        return res.status(403).json({ error: "You can only retry publishing your own reviews." });
      }
      if (review.status !== "completed") {
        return res.status(400).json({ error: `Review is not completed (status: ${review.status}).` });
      }
      if (review.publishedDocumentId) {
        return res.status(400).json({ error: "This review is already published to Future Science." });
      }
      if (!review.contentMarkdown) {
        return res.status(400).json({ error: "Review has no stored content to publish." });
      }
      if (!process.env.FUTURE_SCIENCE_API_KEY) {
        return res.status(500).json({ error: "FUTURE_SCIENCE_API_KEY is not configured." });
      }

      // Reconstruct the abstract: prefer the exact value stored at generation time, else
      // parse the "## Abstract" section from the stored markdown, else compose a fallback.
      let storedSubmission: { keywords?: string[]; abstract?: string } | undefined;
      let storedFsKeywords: string[] = [];
      try {
        const st = review.sourceTrace ? JSON.parse(review.sourceTrace) : {};
        if (st?.submission) storedSubmission = st.submission;
        if (Array.isArray(st?.futureScienceKeywords)) storedFsKeywords = st.futureScienceKeywords;
      } catch {}

      let abstract = storedSubmission?.abstract?.trim() || "";
      if (!abstract) {
        const abstractMatch = review.contentMarkdown.match(/##\s*Abstract\s*\n+([\s\S]+?)(?=\n##\s|$)/);
        abstract = abstractMatch
          ? abstractMatch[1]
              .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
              .replace(/\*\*([^*]+)\*\*/g, "$1")
              .replace(/\s+/g, " ")
              .trim()
          : buildLiteratureReviewFallbackAbstract({
              researchQuestion: review.researchQuestion,
              contentMarkdown: review.contentMarkdown,
            });
      }

      // Reconstruct keywords: stored submission keywords > stored journal keywords >
      // derived from the research question. Enforce Future Science's 3-keyword minimum.
      let keywords: string[] = (storedSubmission?.keywords || storedFsKeywords)
        .map((k) => String(k).trim())
        .filter(Boolean)
        .slice(0, 8);
      if (keywords.length < 3) {
        const derived = review.researchQuestion
          .split(/\s+/)
          .map((w) => w.replace(/[^A-Za-z0-9-]/g, ""))
          .filter((w) => w.length > 4);
        keywords = Array.from(new Set([...keywords, ...derived])).slice(0, 5);
      }
      const genericFallbacks = ["AI interpretability", "machine learning", "literature review"];
      for (const g of genericFallbacks) {
        if (keywords.length >= 3) break;
        if (!keywords.includes(g)) keywords.push(g);
      }

      const robotAgentName = buildConventionName(review.modelName || "", review.agentId || "bLR");
      const humanOrchestratorName = review.orchestratorName && review.orchestratorName !== robotAgentName
        ? review.orchestratorName
        : undefined;

      const subResult = await submitLiteratureReviewToFutureScience({
        title: `Literature Review: ${review.researchQuestion}`,
        markdownContent: review.contentMarkdown,
        abstract,
        keywords,
        agentName: robotAgentName,
        orchestratorName: humanOrchestratorName,
        agentDescription: review.agentDescription || undefined,
      });

      if (!subResult) {
        return res.status(502).json({ error: "Future Science rejected the submission. See server logs and try again later." });
      }

      await storage.updateLiteratureReview(review.id, { publishedDocumentId: subResult.documentId });
      await storage.createResearchEvent({
        source: robotAgentName,
        agentId: review.agentId || "bLR",
        phase: "fs-submission-success",
        message: `Literature review published to Future Science on retry. Document ID: ${subResult.documentId}`,
      });
      res.json({ success: true, documentId: subResult.documentId, url: subResult.url });
    } catch (err: any) {
      console.error("Error republishing literature review:", err);
      res.status(500).json({ error: err?.message || "Internal server error" });
    }
  });

  // Admin: reset the global "already reviewed" lock for a journal
  app.post("/api/admin/peer-review-lock/reset", adminAuth, async (req, res) => {
    try {
      const journalId = (req.body?.journalId as string | undefined) || "mirror";
      if (!INITIATIVE_DOC_IDS[journalId]) return res.status(400).json({ error: "Unknown journal." });
      const cleared = await storage.resetPeerReviewLocksForJournal(journalId);
      res.json({ success: true, clearedReviews: cleared });
    } catch (err: any) {
      console.error("Error resetting peer review lock:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/admin/audit-lock/reset", adminAuth, async (req, res) => {
    try {
      const journalId = (req.body?.journalId as string | undefined) || "mirror";
      if (!INITIATIVE_DOC_IDS[journalId]) return res.status(400).json({ error: "Unknown journal." });
      const cleared = await storage.resetAuditLockForJournal(journalId);
      res.json({ success: true, clearedReports: cleared });
    } catch (err: any) {
      console.error("Error resetting audit lock:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/ethics-reports", async (req, res) => {
    try {
      const projectId = req.query.projectId as string | undefined;
      const reports = projectId
        ? await storage.getEthicsReportsByProject(projectId)
        : await storage.getAllEthicsReports();
      return res.json(reports);
    } catch (err: any) {
      console.error("Error fetching ethics reports:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/ethics-reports/:id", async (req, res) => {
    try {
      const report = await storage.getEthicsReportById(req.params.id);
      if (!report) return res.status(404).json({ error: "Ethics report not found" });
      return res.json(report);
    } catch (err: any) {
      console.error("Error fetching ethics report:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/ethics-reports", requireAuth, async (req, res) => {
    try {
      const {
        projectId, agentId, journalId, keywords, topic, prompt1, prompt2, prompt3,
        modelProvider, modelName, providerMode, byocApiKey,
        orchestratorName, agentDescription,
        documentId, paperTitle, singlePaperPrompt,
      } = req.body;

      const VALID_PROVIDER_MODES = ["platform", "byoc"];
      const VALID_PROVIDERS = ["openai", "anthropic", "openrouter"];
      if (providerMode && !VALID_PROVIDER_MODES.includes(providerMode)) {
        return res.status(400).json({ error: `Invalid providerMode.` });
      }
      if (modelProvider && !VALID_PROVIDERS.includes(modelProvider)) {
        return res.status(400).json({ error: `Invalid modelProvider.` });
      }

      const PLATFORM_ACCESS_EMAILS = ["jevans@uchicago.edu", "sacharaoult@gmail.com", "akozlo@uchicago.edu"];
      const user = (req as any).user;
      const isPlatform = providerMode !== "byoc";

      if (isPlatform && !PLATFORM_ACCESS_EMAILS.includes(user.email)) {
        return res.status(403).json({ error: "Platform model access is restricted to institute members. Please use Bring Your Own Key mode." });
      }

      if (isPlatform) {
        if (!process.env.OPENROUTER_API_KEY) {
          return res.status(503).json({ error: "Ethics report generation is not configured. OPENROUTER_API_KEY is missing." });
        }
        if (!PLATFORM_ACCESS_EMAILS.includes(user.email)) {
          const limitConfig = PER_USER_PLATFORM_LIMITS["ethics-report"];
          const rateCheck = await storage.checkAndIncrementRateLimit(user.id, "ethics-report", limitConfig.max, limitConfig.windowMs);
          if (!rateCheck.allowed) {
            return res.status(429).json({ error: `Ethics report generation limit reached (${limitConfig.max} per 24 hours). Try again later.` });
          }
        }
      }

      if (providerMode === "byoc") {
        if (!byocApiKey) return res.status(400).json({ error: "BYOC mode requires an API key." });
        const keyValidation = await validateApiKey(modelProvider || "openrouter", byocApiKey);
        if (!keyValidation.valid) {
          return res.status(400).json({ error: keyValidation.error || "Invalid BYOC API key." });
        }
        await storeEphemeralKey(user.id, modelProvider || "openrouter", byocApiKey);
      }

      if (!PLATFORM_ACCESS_EMAILS.includes(user.email)) {
        const clientIp = req.ip || "unknown";
        const last = ethicsRateLimit.get(clientIp) || 0;
        if (Date.now() - last < 30000) {
          return res.status(429).json({ error: "Please wait at least 30 seconds between ethics report requests." });
        }
        ethicsRateLimit.set(clientIp, Date.now());
      }

      const effectiveJournalId = journalId && INITIATIVE_DOC_IDS[journalId] ? journalId : "mirror";
      const effectiveKeywords: string[] = Array.isArray(keywords)
        ? keywords.map((k: unknown) => String(k).trim()).filter(Boolean)
        : (typeof keywords === "string" ? keywords.split(",").map((k: string) => k.trim()).filter(Boolean) : []);
      const rawAgentId = agentId && agentId.includes("MachInstit") ? "H" : (agentId || "H");
      const effectiveOrchestratorName = orchestratorName || buildConventionName(modelName || "", rawAgentId);
      const effectiveTopic: string | null = typeof topic === "string" && topic.trim() ? topic.trim() : null;
      const effectiveDocumentId: string | null = typeof documentId === "string" && documentId.trim() ? documentId.trim() : null;
      const effectivePaperTitle: string | null = typeof paperTitle === "string" && paperTitle.trim() ? paperTitle.trim() : null;

      // Enforce global "already audited" lock for single-paper mode
      if (effectiveDocumentId) {
        const lockedIds = await storage.getAuditedPaperIdsForJournal(effectiveJournalId);
        if (lockedIds.includes(`doc:${effectiveDocumentId}`)) {
          return res.status(409).json({ error: "This paper has already been ethics-reviewed. An admin can reset the lock to allow re-review." });
        }
      }

      const researchQuestion = effectiveDocumentId
        ? `Publication audit of "${effectivePaperTitle || effectiveDocumentId}" in ${getJournalDisplayName(effectiveJournalId)}`
        : `Field-level publication audit of ${getJournalDisplayName(effectiveJournalId)}${effectiveTopic ? ` — topic: ${effectiveTopic}` : ""}${effectiveKeywords.length ? ` (filters: ${effectiveKeywords.join(", ")})` : ""}`;

      const modelConfig: ModelProviderConfig = {
        providerMode: (providerMode === "byoc" ? "byoc" : "platform") as "platform" | "byoc",
        provider: modelProvider || "openrouter",
        modelName: modelName || "",
        apiKey: providerMode === "byoc" ? byocApiKey : undefined,
      };

      const parsed = insertEthicsReportSchema.safeParse({
        projectId,
        agentId: agentId || effectiveOrchestratorName,
        journalId: effectiveJournalId,
        keywords: effectiveKeywords,
        researchQuestion,
        topic: effectiveTopic,
        documentId: effectiveDocumentId,
        paperTitle: effectivePaperTitle,
        prompt1: (effectiveDocumentId ? (singlePaperPrompt || H_SINGLE_PAPER_PROMPT) : (prompt1 || H_SOLO_REPORT_CHUNK_1_PROMPT)),
        prompt2: prompt2 || H_SOLO_REPORT_CHUNK_2_PROMPT,
        prompt3: prompt3 || H_SOLO_REPORT_CHUNK_3_PROMPT,
        userId: user?.id || null,
        orchestratorName: effectiveOrchestratorName,
        agentDescription: agentDescription || null,
        modelProvider: modelConfig.provider,
        modelName: resolveModelName(modelConfig),
        providerMode: modelConfig.providerMode,
      });

      if (!parsed.success) {
        return res.status(400).json({ error: fromZodError(parsed.error).message });
      }

      const report = await storage.createEthicsReport(parsed.data);

      // Atomically reserve the lock for single-paper mode by writing the auditedPaperIds immediately.
      // Combined with getAuditedPaperIdsForJournal including all non-failed statuses, this prevents
      // two concurrent requests from both passing the pre-check.
      if (effectiveDocumentId) {
        const reservedIds = [`doc:${effectiveDocumentId}`];
        if (effectivePaperTitle) reservedIds.push(`title:${effectivePaperTitle.toLowerCase().trim()}`);
        await storage.updateEthicsReport(report.id, { auditedPaperIds: reservedIds });
      }
      res.status(201).json(report);

      generateEthicsReportBackground(report.id, parsed.data, modelConfig).catch(err => {
        console.error("Background ethics report generation failed:", err);
      });
    } catch (err: any) {
      console.error("Error creating ethics report:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  async function generateEthicsReportBackground(
    reportId: string,
    data: { projectId: string; agentId: string; journalId: string; keywords: string[]; topic?: string | null; prompt1: string; prompt2: string; prompt3: string; userId?: string | null; orchestratorName?: string | null; agentDescription?: string | null; documentId?: string | null; paperTitle?: string | null },
    modelConfig: ModelProviderConfig,
  ) {
    const initiativeDocId = INITIATIVE_DOC_IDS[data.journalId] || INITIATIVE_DOC_IDS["mirror"];
    if (modelConfig.providerMode === "byoc" && !modelConfig.apiKey && data.userId) {
      const stored = getEphemeralKey(data.userId, modelConfig.provider);
      if (stored) modelConfig.apiKey = stored;
    }
    const resolvedModel = resolveModelName(modelConfig);
    const robotAgentName = buildConventionName(resolvedModel, "H");

    async function emit(phase: string, message: string) {
      try {
        await storage.createResearchEvent({ source: robotAgentName, agentId: "H", phase, message });
      } catch (e) {
        console.error(`[Ethics ${reportId}] Failed to emit event:`, e);
      }
    }

    try {
      await storage.updateEthicsReport(reportId, { status: "generating" });
      await emit("ethics-init", `Field ethics report started for journal ${data.journalId}.`);

      const result = await runEthicsReport({
        reportId,
        projectId: data.projectId,
        agentId: data.agentId,
        agentName: robotAgentName,
        journalId: data.journalId,
        journalName: getJournalDisplayName(data.journalId),
        initiativeDocId,
        initiativeSlug: INITIATIVE_SLUGS[data.journalId] || data.journalId,
        journalDisplayName: JOURNAL_DISPLAY_NAMES[data.journalId] || data.journalId,
        keywords: data.keywords,
        topic: data.topic || null,
        prompt1: data.prompt1,
        prompt2: data.prompt2,
        prompt3: data.prompt3,
        documentId: data.documentId || null,
        paperTitle: data.paperTitle || null,
        singlePaperPrompt: data.documentId ? data.prompt1 : undefined,
        modelConfig: { ...modelConfig, modelName: resolvedModel },
        emitEvent: emit,
      });

      const rawHtml = markdownToHtml(result.ethicsText);
      const safeHtml = sanitizeHtml(rawHtml);

      const promptTrace = JSON.stringify({
        prompt1: data.prompt1, prompt2: data.prompt2, prompt3: data.prompt3,
        model: resolvedModel, provider: modelConfig.provider, providerMode: modelConfig.providerMode,
        timestamp: new Date().toISOString(),
      });
      const sourceTrace = JSON.stringify({
        journalId: data.journalId,
        keywordsFilter: data.keywords,
        papersUsed: result.papersUsed,
      });

      const updates: Partial<EthicsReport> = {
        contentMarkdown: result.ethicsText,
        contentHtml: safeHtml,
        reportTitle: result.reportTitle,
        reportAbstract: result.reportAbstract,
        clearanceStatus: result.clearanceStatus,
        clearanceStatement: result.clearanceStatement,
        flagsJson: JSON.stringify(result.flagsList),
        recommendationsJson: JSON.stringify(result.recommendations),
        promptTrace,
        sourceTrace,
        auditedPaperIds: result.auditedPaperIds,
        status: "completed",
        completedAt: new Date(),
      };

      if (!process.env.FUTURE_SCIENCE_API_KEY) {
        await emit("fs-submission-skipped", "Future Science submission skipped: FUTURE_SCIENCE_API_KEY is not configured.");
      } else {
        try {
          const humanOrchestratorName = data.orchestratorName && data.orchestratorName !== robotAgentName
            ? data.orchestratorName
            : undefined;
          const submissionKeywords = data.keywords.length >= 3
            ? data.keywords.slice(0, 8)
            : ["ethics", "ai research", "automated science", ...data.keywords].slice(0, 5);
          // Single-paper audits are submitted as "Response to a contribution"
          // with linkOriginalContribution pointing at the audited paper's FS URL.
          const linkOriginalContribution = data.documentId
            ? `https://future-science.org/${data.journalId}/${data.documentId}`
            : undefined;
          const { major: ethicsMajor, minor: ethicsMinor } = flagsToRevisions(result.flagsList);
          const subResult = await submitEthicsReportToFutureScience({
            title: result.reportTitle,
            markdownContent: result.ethicsText,
            abstract: result.reportAbstract,
            keywords: submissionKeywords,
            agentName: robotAgentName,
            initiativeDocId,
            initiativeSlug: data.journalId,
            orchestratorName: humanOrchestratorName,
            agentDescription: data.agentDescription || undefined,
            linkOriginalContribution,
            majorRevisions: ethicsMajor,
            minorRevisions: ethicsMinor,
          });
          if (subResult) {
            updates.publishedDocumentId = subResult.documentId;
            await emit("fs-submission-success", `Ethics report submitted to Future Science. Document ID: ${subResult.documentId}`);
          } else {
            await emit("fs-submission-failed", "Future Science submission failed (non-fatal).");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          await emit("fs-submission-failed", `Future Science submission failed: ${msg}`);
        }
      }

      await storage.updateEthicsReport(reportId, updates);
      await emit("ethics-completed", `Field ethics report completed (${result.flagsList.length} flag(s), status: ${result.clearanceStatus}).`);
    } catch (err: any) {
      console.error(`[Ethics ${reportId}] Generation failed:`, err);
      const safeError = (err.message || "Unknown error").replace(/[<>&"']/g, "");
      await emit("failure", `Ethics report generation failed: ${safeError}`);
      await storage.updateEthicsReport(reportId, {
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
      const PLATFORM_ACCESS_EMAILS = ["jevans@uchicago.edu", "sacharaoult@gmail.com", "akozlo@uchicago.edu"];
      if (!user) {
        const limitConfig = PER_USER_PLATFORM_LIMITS["editorial"];
        return res.json({ remaining: limitConfig.max, resetAt: null, count: 0 });
      }
      if (PLATFORM_ACCESS_EMAILS.includes(user.email)) {
        return res.json({ remaining: null, resetAt: null, count: 0 });
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
        if (!PLATFORM_ACCESS_EMAILS.includes(user.email)) {
          const limitConfig = PER_USER_PLATFORM_LIMITS["editorial"];
          const rateCheck = await storage.checkAndIncrementRateLimit(user.id, "editorial", limitConfig.max, limitConfig.windowMs);
          if (!rateCheck.allowed) {
            return res.status(429).json({
              error: `Editorial generation limit reached (${limitConfig.max} per 24 hours). Try again later.`,
            });
          }
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
      const effectiveTopic = topic || "Recent developments in AI agent-driven scientific research, autonomous experimentation, and AI interpretability";

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

  // Fetch the full HTML body of an arXiv paper (the ar5iv/arXiv HTML version
  // is available for most papers from 2022 onwards). Strips tags down to plain
  // text and truncates to a safe length so the editorial prompt stays bounded.
  // Returns null on any network/parse error so the caller can fall back to the
  // arXiv API <summary> (i.e. the abstract) without failing the whole run.
  async function fetchArxivFullText(arxivId: string, maxChars = 6000): Promise<string | null> {
    const tryUrls = [
      `https://arxiv.org/html/${encodeURIComponent(arxivId)}`,
      `https://arxiv.org/html/${encodeURIComponent(arxivId)}v1`,
    ];
    for (const url of tryUrls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const resp = await fetch(url, { redirect: "follow", signal: controller.signal });
        if (!resp.ok) { clearTimeout(timer); continue; }
        const html = await resp.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/\s+/g, " ")
          .trim();
        clearTimeout(timer);
        if (text.length < 400) continue;
        return text.slice(0, maxChars);
      } catch (err) {
        clearTimeout(timer);
        // try next URL
      }
    }
    return null;
  }

  const ARXIV_STOPWORDS = new Set([
    "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "for", "with",
    "by", "from", "as", "at", "is", "are", "was", "were", "be", "been", "being",
    "do", "does", "did", "how", "what", "why", "when", "where", "which", "who",
    "whom", "that", "this", "these", "those", "it", "its", "if", "then", "than",
    "so", "such", "can", "could", "would", "should", "may", "might", "will",
    "about", "into", "over", "under", "between", "happen", "happens", "happened",
    "occur", "occurs", "cause", "causes", "caused", "effect", "effects", "make",
    "makes", "get", "gets", "use", "used", "using", "study", "paper", "research",
  ]);

  function extractArxivTerms(query: string): string[] {
    const words = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !ARXIV_STOPWORDS.has(w));
    return Array.from(new Set(words));
  }

  async function searchArxiv(query: string): Promise<Array<{ title: string; summary: string; authors: string; published: string; arxivId: string }>> {
    const parseEntries = (xml: string) => {
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
        const arxivId = rawId.replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/v\d+$/, "");
        entries.push({
          title: (titleMatch?.[1] || "").trim().replace(/\s+/g, " "),
          summary: (summaryMatch?.[1] || "").trim().replace(/\s+/g, " ").substring(0, 500),
          authors: authorMatches.map(m => m[1].trim()).join(", "),
          published: (publishedMatch?.[1] || "").trim().substring(0, 10),
          arxivId,
        });
      }
      return entries;
    };

    const fetchArxiv = async (searchExpr: string) => {
      // Sort by relevance so results actually match the topic, not just the newest submissions.
      const url = `https://export.arxiv.org/api/query?search_query=${searchExpr}&start=0&max_results=10&sortBy=relevance&sortOrder=descending`;
      const response = await fetch(url);
      if (!response.ok) {
        console.error(`arXiv API returned ${response.status}`);
        return [];
      }
      return parseEntries(await response.text());
    };

    try {
      const terms = extractArxivTerms(query);
      // AND the most salient topic terms so results are on-topic; fall back to the raw query if nothing survives cleaning.
      const andExpr = terms.length > 0
        ? terms.slice(0, 4).map(t => `all:${encodeURIComponent(t)}`).join("+AND+")
        : `all:${encodeURIComponent(query.trim())}`;
      let entries = await fetchArxiv(andExpr);
      // If the AND query was too strict and returned nothing, broaden to an OR of the terms.
      if (entries.length === 0 && terms.length > 1) {
        const orExpr = terms.slice(0, 6).map(t => `all:${encodeURIComponent(t)}`).join("+OR+");
        entries = await fetchArxiv(orExpr);
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

      // Relevance-rank both Future Science papers and arXiv hits against the
      // editorial topic, then fetch full text for the top-K of each so the
      // editorialist can ground specific claims in actual paper bodies rather
      // than abstracts alone.
      const TOP_K_FS = 5;
      const TOP_K_ARXIV = 5;
      const FS_EXCERPT_CHARS = 5000;
      const ARXIV_EXCERPT_CHARS = 5000;

      const scoreAgainstTopic = (text: string, terms: string[]): number => {
        const lower = (text || "").toLowerCase();
        let s = 0;
        for (const t of terms) {
          if (!t) continue;
          if (lower.includes(t)) s += 1;
        }
        return s;
      };
      const topicTerms = ((topic || "") + " " + (userPrompt || ""))
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(w => w.length > 4);

      const fsRanked = fsAbstracts
        .map(a => ({ a, score: scoreAgainstTopic(a.title + " " + a.abstract + " " + a.keywords.join(" "), topicTerms) }))
        .sort((x, y) => y.score - x.score)
        .slice(0, TOP_K_FS)
        .map(x => x.a);

      const arxivRanked = arxivResults
        .map(r => ({ r, score: scoreAgainstTopic(r.title + " " + r.summary, topicTerms) }))
        .sort((x, y) => y.score - x.score)
        .slice(0, TOP_K_ARXIV)
        .map(x => x.r);

      await emitEDEvent(edAgentId, "relevance-ranking", `Selected top ${fsRanked.length} Future Science paper(s) and top ${arxivRanked.length} arXiv paper(s) by topic relevance for full-text reading.`);

      const edInitiativeSlug = INITIATIVE_SLUGS[edJournalId] || "mirror";

      type ReadResult = {
        source: "FS" | "arXiv";
        title: string;
        authors: string;
        date: string;
        identifier: string;
        body: string;
        readInFull: boolean;
      };

      const fsReads: ReadResult[] = await Promise.all(
        fsRanked.map(async (a) => {
          const full = await fetchFsPaperContent(a.documentId, edInitiativeSlug).catch(() => null);
          const hadFull = !!(full && full.length > 400);
          return {
            source: "FS",
            title: a.title,
            authors: a.authors,
            date: a.date,
            identifier: a.documentId,
            body: hadFull ? full!.slice(0, FS_EXCERPT_CHARS) : (a.abstract || ""),
            readInFull: hadFull,
          };
        }),
      );
      const fsFullCount = fsReads.filter(r => r.readInFull).length;
      await emitEDEvent(edAgentId, "fs-fulltext", `Read ${fsFullCount}/${fsReads.length} Future Science paper(s) in full (rest fell back to abstract).`);

      const arxivReads: ReadResult[] = await Promise.all(
        arxivRanked.map(async (r) => {
          const full = await fetchArxivFullText(r.arxivId, ARXIV_EXCERPT_CHARS).catch(() => null);
          const hadFull = !!(full && full.length > 400);
          return {
            source: "arXiv",
            title: r.title,
            authors: r.authors,
            date: r.published,
            identifier: r.arxivId,
            body: hadFull ? full! : (r.summary || ""),
            readInFull: hadFull,
          };
        }),
      );
      const arxivFullCount = arxivReads.filter(r => r.readInFull).length;
      await emitEDEvent(edAgentId, "arxiv-fulltext", `Read ${arxivFullCount}/${arxivReads.length} arXiv paper(s) in full (rest fell back to abstract).`);

      const allReads = [...fsReads, ...arxivReads];
      const fullTextExcerpts = allReads.length > 0
        ? allReads.map((r, i) => {
            const idLine = r.source === "arXiv" ? `arXiv: ${r.identifier}` : `Future Science doc: ${r.identifier}`;
            const note = r.readInFull ? "" : " — NOTE: full text unavailable; excerpt is the abstract only.";
            return `Full-text Excerpt ${i + 1} [${r.source}]${note}\nTitle: ${r.title}\nAuthors: ${r.authors}\nDate: ${r.date}\n${idLine}\nBody:\n${r.body}`;
          }).join("\n\n---\n\n")
        : "";

      const config = modelConfig || { providerMode: "platform" as const, provider: "openrouter", modelName: "deepseek/deepseek-chat" };
      if (config.providerMode === "byoc" && !config.apiKey) {
        const editorialForKey = await storage.getEditorialById(editorialId);
        if (editorialForKey?.userId) {
          const storedKey = getEphemeralKey(editorialForKey.userId, config.provider);
          if (storedKey) config.apiKey = storedKey;
        }
      }
      const model = resolveModelName(config);

      const effectiveTopic = topic || "Recent developments in AI agent-driven scientific research, autonomous experimentation, and AI interpretability";
      const effectiveSystemPrompt = `${editablePrompt || DEFAULT_EDITORIAL_PROMPT}\n\n${EDITORIAL_SUMMARY_INSTRUCTION}`;

      const userMessage = `Topic: ${effectiveTopic} — based on the institute's current publication corpus.
${userPrompt ? `\nAdditional user instructions: ${userPrompt}` : ""}
${trendsAnalysis ? `\nCorpus analysis:\n${trendsAnalysis}` : ""}

Papers from the institute's publication log:

${paperTexts.join("\n\n---\n\n")}

${reviewTexts.length > 0 ? `\nLiterature Reviews conducted by the institute:\n\n${reviewTexts.join("\n\n---\n\n")}` : ""}

Hot arXiv topics (recent publications in related fields):

${arxivTexts}

${fullTextExcerpts ? `\nFull-text excerpts (use these to ground specific claims and quotations — these are the actual paper bodies, not just abstracts):\n\n${fullTextExcerpts}\n` : ""}
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
        fullTextReads: allReads.map(r => ({
          source: r.source,
          title: r.title,
          identifier: r.identifier,
          readInFull: r.readInFull,
          excerptChars: r.body.length,
        })),
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

      // Lift the leading "## In Brief" summary into the published abstract, then
      // strip that section so the displayed editorial keeps its flowing-prose
      // style. extractEditorialSummary returns null if the model omitted it
      // (e.g. when a custom prompt is used), in which case the abstract falls
      // back deterministically to the editorial's own opening prose.
      const parsedEditorialSummary = extractEditorialSummary(editorialText);
      editorialText = stripEditorialSummarySection(editorialText);

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

      // Build one substantive abstract from the parsed "## In Brief" summary
      // (or a deterministic fallback from the editorial's opening prose) and use
      // it for BOTH the stored excerpt and the Future Science submission, so a
      // reader scanning either learns the editorial's actual thesis rather than
      // a hook fragment. excerptText is retained only as a last-resort signal.
      const editorialAbstract = buildEditorialAbstract({
        title: extractedTitle,
        summary: parsedEditorialSummary || excerptText,
        bodyText: editorialText,
      });
      const editorialKeywords = deriveEditorialKeywords({
        title: extractedTitle,
        bodyText: editorialText,
      });

      const updates: Partial<EditorialRecord> = {
        title: extractedTitle,
        excerpt: editorialAbstract,
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
            abstract: editorialAbstract,
            authorFirstName: (editorial?.orchestratorName || "Machine").split(" ")[0] || "Machine",
            authorLastName: (editorial?.orchestratorName || "Institute").split(" ").slice(1).join(" ") || "Institute",
            authorInstitution: "Machine Institute",
            authorEmail: "research@machine-institute.org",
            keywords: editorialKeywords,
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