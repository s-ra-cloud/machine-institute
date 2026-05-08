import { storage } from "./storage";
import { generateWithConfig, type ModelProviderConfig } from "./model-service";
import {
  H_SOLO_REPORT_CHUNK_1_PROMPT,
  H_SOLO_REPORT_CHUNK_2_PROMPT,
  H_SOLO_REPORT_CHUNK_3_PROMPT,
  H_SINGLE_PAPER_PROMPT,
  applyJournalName,
} from "./prompts/h-solo";
import { fetchAbstractsAndKeywords, type FutureScienceAbstract } from "./future-science";
import {
  fetchFsPaperContent,
  extractCitations,
  verifyCitations,
  formatVerificationReport,
  extractUrls,
  verifyUrls,
  formatUrlVerificationReport,
  analyzeInTextVsBibliography,
  formatBibliographyAnalysis,
  type PaperVerification,
} from "./citation-verifier";
import type { EthicsReport, ProjectPaper } from "@shared/schema";

export interface EthicsFlag {
  severity: "CRITICAL" | "MAJOR" | "MINOR";
  summary: string;
}

export interface EthicsReviewOutput {
  ethicsText: string;
  chunk1: string;
  chunk2: string;
  chunk3: string;
  flagsList: EthicsFlag[];
  recommendations: string[];
  clearanceStatement: string;
  clearanceStatus: "CLEARED" | "CLEARED_WITH_CONDITIONS" | "NOT_CLEARED";
  reportTitle: string;
  reportAbstract: string;
  durationSeconds: number;
  papersUsed: { title: string; authors: string; date: string; documentId?: string }[];
  auditedPaperIds: string[];
}

export function extractFlags(ethicsText: string): EthicsFlag[] {
  const flags: EthicsFlag[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:\d+\.?\s*)?(?:\*\*)?(?:\[?\s*)(CRITICAL|MAJOR|MINOR)(?:\s*\]?)(?:\*\*)?[:\s—\-]+(?:\*\*)?\s*(.+)/gi,
    /(?:^|\n)\s*(?:\d+\.?\s*)?(?:\*\*)?FLAG[:\s—\-]+(?:\*\*)?\s*(?:\[?\s*)(CRITICAL|MAJOR|MINOR)(?:\s*\]?)(?:\*\*)?[:\s—\-]+\s*(.+)/gi,
  ];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(ethicsText)) !== null) {
      const severityRaw = match[1].toUpperCase().trim();
      let severity: EthicsFlag["severity"] = "MINOR";
      if (severityRaw === "CRITICAL") severity = "CRITICAL";
      else if (severityRaw === "MAJOR") severity = "MAJOR";
      const summary = match[2]?.replace(/\*\*/g, "").replace(/\s+/g, " ").trim() || "";
      if (summary.length < 5) continue;
      if (/^#+\s/.test(summary)) continue;
      if (/^(CRITICAL|MAJOR|MINOR)\s*(FLAGS?)?$/i.test(summary)) continue;
      if (seen.has(summary)) continue;
      seen.add(summary);
      flags.push({ severity, summary });
    }
  }
  return flags;
}

export function extractClearanceStatus(ethicsText: string): EthicsReviewOutput["clearanceStatus"] {
  const lower = ethicsText.toLowerCase();
  if (lower.includes("not cleared") || lower.includes("not_cleared")) return "NOT_CLEARED";
  if (lower.includes("cleared with conditions") || lower.includes("cleared_with_conditions")) return "CLEARED_WITH_CONDITIONS";
  if (lower.includes("cleared")) return "CLEARED";
  return "CLEARED_WITH_CONDITIONS";
}

export function extractRecommendations(ethicsText: string): string[] {
  const recs: string[] = [];
  const recSection = ethicsText.match(/###?\s*(?:\d+\.?\s*)?(?:Ethics\s+)?Recommendations([\s\S]*?)(?=###?\s|$)/i);
  if (recSection) {
    const lines = recSection[1].split("\n");
    for (const line of lines) {
      const cleaned = line.replace(/^[\s\-*•R\d.]+/, "").trim();
      if (cleaned.length > 10 && !cleaned.startsWith("#")
          && !cleaned.startsWith("**Immediate") && !cleaned.startsWith("**Future")
          && !cleaned.startsWith("**Field") && !cleaned.startsWith("**Systemic")) {
        recs.push(cleaned);
      }
    }
  }
  return recs.slice(0, 20);
}

export function extractClearanceStatement(ethicsText: string): string {
  const section = ethicsText.match(/###?\s*(?:11\.?\s*)?(?:Overall Assessment and\s*)?Clearance Statement([\s\S]*?)(?=###?\s*Bibliography|###?\s*\d|$)/i);
  if (section && section[1].trim().length > 10) return section[1].trim().slice(0, 2000);
  const fallback = ethicsText.match(/(?:CLEARED|NOT.CLEARED|CLEARED.WITH.CONDITIONS)[^\n]*\n?([\s\S]{100,800}?)(?=\n##|\n\*\*|$)/i);
  if (fallback) return fallback[0].trim().slice(0, 2000);
  return "Ethics clearance status could not be determined from the analysis.";
}

function tokenize(s: string): string[] {
  return (s || "").toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
}

function filterByKeywords<T extends { title: string; abstract?: string; description?: string }>(
  items: T[],
  keywords: string[],
): T[] {
  if (keywords.length === 0) return items;
  const userTokens = new Set<string>();
  for (const k of keywords) for (const t of tokenize(k)) userTokens.add(t);
  if (userTokens.size === 0) return items;
  return items.filter(item => {
    const text = `${item.title} ${(item.abstract || item.description || "")}`;
    const itemTokens = new Set(tokenize(text));
    let matched = false;
    userTokens.forEach(t => { if (itemTokens.has(t)) matched = true; });
    return matched;
  });
}

interface RunOptions {
  reportId: string;
  projectId: string;
  agentId: string;
  agentName: string;
  journalId: string;
  journalName?: string;
  initiativeDocId: string;
  initiativeSlug: string;
  journalDisplayName: string;
  keywords: string[];
  topic?: string | null;
  prompt1: string;
  prompt2: string;
  prompt3: string;
  documentId?: string | null;
  paperTitle?: string | null;
  singlePaperPrompt?: string;
  modelConfig: ModelProviderConfig;
  emitEvent: (phase: string, message: string) => Promise<void>;
}

async function buildPrevReport(projectId: string, journalId: string): Promise<{ text: string; date: Date } | null> {
  const projectReports = await storage.getEthicsReportsByProject(projectId);
  const completed = projectReports
    .filter(r => r.status === "completed" && r.journalId === journalId && r.contentMarkdown)
    .sort((a, b) => new Date(b.completedAt || b.createdAt).getTime() - new Date(a.completedAt || a.createdAt).getTime());
  if (completed.length === 0) return null;
  const latest = completed[0];
  return {
    text: latest.contentMarkdown!,
    date: new Date(latest.completedAt || latest.createdAt),
  };
}

export async function runEthicsReport(opts: RunOptions): Promise<EthicsReviewOutput> {
  if (opts.documentId) {
    return runSinglePaperEthicsReport(opts);
  }
  const startTime = Date.now();
  const { projectId, journalId, initiativeDocId, initiativeSlug, journalDisplayName, keywords, topic, prompt1, prompt2, prompt3, modelConfig, emitEvent } = opts;
  const journalName = opts.journalName || journalDisplayName || journalId;
  const sub1 = applyJournalName(prompt1, journalName);
  const sub2 = applyJournalName(prompt2, journalName);
  const sub3 = applyJournalName(prompt3, journalName);
  const fsPaperUrl = (docId: string | undefined | null): string =>
    docId ? `https://future-science.org/${initiativeSlug}/${docId}` : "";

  await emitEvent("ethics-init", `Starting field ethics report on ${journalDisplayName}${topic ? ` — topic "${topic}"` : ""} (${keywords.length} keyword filter(s)).`);

  // Sample sources: project_papers (DB) + Future Science abstracts for the journal
  const projectPapers: ProjectPaper[] = await storage.getProjectPapers(projectId);
  let fsAbstracts: FutureScienceAbstract[] = [];
  try {
    const fsData = await fetchAbstractsAndKeywords([], initiativeDocId);
    fsAbstracts = fsData.abstracts;
  } catch (err) {
    await emitEvent("ethics-fetch-warning", `Future Science fetch failed: ${err instanceof Error ? err.message : String(err)}. Continuing with project log only.`);
  }

  const filteredFs = filterByKeywords(fsAbstracts, keywords)
    .filter(a => !/literature review:/i.test(a.title) && !/ethics.*(report|assessment|commentary|review)/i.test(a.title));
  const filteredProj = filterByKeywords(projectPapers, keywords);

  const prevReport = await buildPrevReport(projectId, journalId);

  // Global deduplication: collect IDs of every paper already audited in any prior completed report for this journal (across all users/projects).
  const priorReports = await storage.getCompletedEthicsReportsByJournal(journalId);
  const previouslyAudited = new Set<string>();
  for (const r of priorReports) {
    for (const id of r.auditedPaperIds || []) {
      if (id) previouslyAudited.add(id);
    }
  }
  const isAlreadyAudited = (documentId: string | undefined | null, title: string): boolean => {
    if (documentId && previouslyAudited.has(`doc:${documentId}`)) return true;
    if (title && previouslyAudited.has(`title:${title.toLowerCase().trim()}`)) return true;
    return false;
  };

  type SamplePaper = { title: string; authors: string; date: string; abstract: string; url: string; documentId?: string };
  const localSeen = new Set<string>();
  const sample: SamplePaper[] = [];
  let skippedAlreadyAudited = 0;
  for (const p of filteredProj) {
    const key = p.title.toLowerCase().trim();
    if (localSeen.has(key)) continue;
    if (isAlreadyAudited(p.sourceDocumentId, p.title)) { skippedAlreadyAudited++; continue; }
    localSeen.add(key);
    const url = p.url || fsPaperUrl(p.sourceDocumentId);
    sample.push({ title: p.title, authors: p.authors, date: p.date, abstract: p.description, url, documentId: p.sourceDocumentId || undefined });
  }
  for (const a of filteredFs) {
    const key = a.title.toLowerCase().trim();
    if (localSeen.has(key)) continue;
    if (isAlreadyAudited(a.documentId, a.title)) { skippedAlreadyAudited++; continue; }
    localSeen.add(key);
    sample.push({ title: a.title, authors: a.authors, date: a.date, abstract: a.abstract, url: fsPaperUrl(a.documentId), documentId: a.documentId });
  }

  if (skippedAlreadyAudited > 0) {
    await emitEvent("ethics-dedup", `Excluded ${skippedAlreadyAudited} paper(s) already audited in prior ethics reports for this journal (global deduplication).`);
  }

  if (sample.length === 0) {
    if (previouslyAudited.size > 0) {
      throw new Error(`All papers matching the selected keywords for this journal have already been audited in prior ethics reports (${previouslyAudited.size} previously audited paper(s) excluded). Wait for new publications or broaden the keywords.`);
    }
    throw new Error("No papers matched the selected keywords for this journal. Try broadening the keywords or removing them.");
  }

  const TARGET = Math.min(sample.length, 35);
  const sampled = sample.slice(0, TARGET);

  const coveragePeriod = prevReport
    ? `${prevReport.date.toISOString().slice(0, 10)} to ${new Date().toISOString().slice(0, 10)} (papers not audited in any prior report)`
    : `Inaugural assessment (all available publications up to ${new Date().toISOString().slice(0, 10)})`;

  await emitEvent("ethics-sample", `Sampled ${sampled.length} paper(s) for audit (${projectPapers.length} project log + ${fsAbstracts.length} FS) covering ${coveragePeriod}.`);

  await emitEvent("ethics-citations", `Fetching full text and verifying citations against Future Science + OpenAlex for ${sampled.length} paper(s)...`);
  const verifications: PaperVerification[] = [];
  let totalCitations = 0;
  let totalVerified = 0;
  for (const p of sampled) {
    let fullText: string | null = null;
    if (p.documentId) {
      fullText = await fetchFsPaperContent(p.documentId, initiativeSlug);
    }
    const sourceText = fullText && fullText.length > 200 ? fullText : "";
    if (sourceText) {
      const citations = extractCitations(sourceText);
      const verified = await verifyCitations(citations, fsAbstracts);
      totalCitations += verified.length;
      totalVerified += verified.filter(v => v.verifiedSource !== "none").length;
      verifications.push({ paperTitle: p.title, hadFullText: true, citations: verified });
    } else {
      verifications.push({ paperTitle: p.title, hadFullText: false, citations: [] });
    }
  }
  await emitEvent("ethics-citations", `Citation verification complete: ${totalVerified}/${totalCitations} citations verified across ${sampled.length} paper(s) (${verifications.filter(v => v.hadFullText).length} had full text available).`);

  const papersContent = sampled.map((p, i) => {
    const v = verifications[i];
    const verificationBlock = formatVerificationReport(v);
    return `## Paper ${i + 1}: ${p.title}\n**Authors:** ${p.authors} (${p.date})\n**URL:** ${p.url || "(none)"}\n**Journal:** ${journalDisplayName}\n\n**Abstract:**\n${(p.abstract || "").slice(0, 4000)}\n\n${verificationBlock}`;
  }).join("\n\n---\n\n");

  const previousReportSection = prevReport
    ? `## PREVIOUS ETHICS REPORT (Baseline)\n\nDate: ${prevReport.date.toISOString().slice(0, 10)}\n\n${prevReport.text.slice(0, 8000)}\n\n---\n\n`
    : `## PREVIOUS ETHICS REPORT\n\nNone available. This is the inaugural field ethics assessment.\n\n---\n\n`;

  const topicSection = topic ? `## AUDIT FOCUS TOPIC\n\nThe orchestrator has highlighted the following topical focus for this audit. Weight your assessment toward ethical issues relevant to this topic, but DO NOT ignore other categories of concern.\n\n> ${topic}\n\n---\n\n` : "";

  // Part 1
  await emitEvent("ethics-part-1", `Part 1/3: Paper-by-paper ethical audit (${sampled.length} papers)...`);
  const user1 = `${previousReportSection}${topicSection}## COVERAGE PERIOD\n\n${coveragePeriod}\n\n---\n\n## PAPERS FOR ETHICAL AUDIT (${sampled.length} papers)\n\n${papersContent}`;
  const r1 = await generateWithConfig(modelConfig, sub1, user1, { maxTokens: 8000, temperature: 0.3 });
  const chunk1 = r1.content;
  await emitEvent("ethics-part-1", `Part 1/3 complete (${chunk1.length} chars).`);

  // Part 2
  await emitEvent("ethics-part-2", `Part 2/3: Systemic patterns and trajectory...`);
  const user2 = `${previousReportSection}## YOUR PART 1 PAPER-BY-PAPER AUDIT\n\n${chunk1}`;
  const r2 = await generateWithConfig(modelConfig, sub2, user2, { maxTokens: 6000, temperature: 0.3 });
  const chunk2 = r2.content;
  await emitEvent("ethics-part-2", `Part 2/3 complete (${chunk2.length} chars).`);

  // Part 3
  await emitEvent("ethics-part-3", `Part 3/3: Synthesis, flags consolidation, and clearance...`);
  const user3 = `## YOUR PART 1 PAPER-BY-PAPER AUDIT\n\n${chunk1}\n\n---\n\n## YOUR PART 2 SYSTEMIC ANALYSIS\n\n${chunk2}`;
  const r3 = await generateWithConfig(modelConfig, sub3, user3, { maxTokens: 6000, temperature: 0.3 });
  const chunk3 = r3.content;
  await emitEvent("ethics-part-3", `Part 3/3 complete (${chunk3.length} chars).`);

  const ethicsText = `${chunk1}\n\n---\n\n${chunk2}\n\n---\n\n${chunk3}`;

  const flagsList = extractFlags(chunk3);
  const recommendations = extractRecommendations(chunk3);
  const clearanceStatement = extractClearanceStatement(chunk3);
  const clearanceStatus = extractClearanceStatus(chunk3);
  const durationSeconds = Math.round((Date.now() - startTime) / 1000);

  const reportDateLabel = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const reportTitle = `Field Ethics Report on ${journalDisplayName}: ${reportDateLabel}`;

  const critCount = flagsList.filter(f => f.severity === "CRITICAL").length;
  const majorCount = flagsList.filter(f => f.severity === "MAJOR").length;
  const minorCount = flagsList.filter(f => f.severity === "MINOR").length;
  const comparisonNote = prevReport
    ? ` This report compares findings against a previous assessment dated ${prevReport.date.toISOString().slice(0, 10)} to evaluate whether ethical standards have improved, worsened, or remained stable.`
    : " This is the inaugural field ethics assessment for this journal.";
  const reportAbstract = `This report presents a systematic field-level research-ethics audit of ${journalDisplayName}. A total of ${sampled.length} studies (covering ${coveragePeriod}) were audited across eight ethics categories: citation fraud, data fabrication, selective reporting, plagiarism, undisclosed conflicts of interest or AI involvement, replication-blocking non-disclosure, scope misrepresentation, and irresponsible safety disclosure.${comparisonNote} The audit identified ${flagsList.length} ethics concern(s): ${critCount} critical, ${majorCount} major, and ${minorCount} minor. Overall field clearance status: ${clearanceStatus.replace(/_/g, " ")}.`;

  // Stable identifiers for global deduplication on the next run. We store both the documentId (when available) and a normalised title key as a fallback so project-log papers without a FS link are also tracked.
  const auditedPaperIds: string[] = [];
  for (const p of sampled) {
    if (p.documentId) auditedPaperIds.push(`doc:${p.documentId}`);
    auditedPaperIds.push(`title:${p.title.toLowerCase().trim()}`);
  }

  return {
    ethicsText, chunk1, chunk2, chunk3, flagsList, recommendations,
    clearanceStatement, clearanceStatus, reportTitle, reportAbstract, durationSeconds,
    papersUsed: sampled.map(p => ({ title: p.title, authors: p.authors, date: p.date, documentId: p.documentId })),
    auditedPaperIds,
  };
}

async function runSinglePaperEthicsReport(opts: RunOptions): Promise<EthicsReviewOutput> {
  const startTime = Date.now();
  const { projectId, journalId, initiativeDocId, initiativeSlug, journalDisplayName, modelConfig, emitEvent, documentId, paperTitle } = opts;
  const journalName = opts.journalName || journalDisplayName || journalId;
  const promptRaw = opts.singlePaperPrompt && opts.singlePaperPrompt.trim() ? opts.singlePaperPrompt : H_SINGLE_PAPER_PROMPT;
  const systemPrompt = applyJournalName(promptRaw, journalName);

  if (!documentId) throw new Error("documentId is required for single-paper audit");

  await emitEvent("ethics-init", `Starting single-paper ethics audit on "${paperTitle || documentId}" in ${journalDisplayName}.`);

  // Load FS abstracts (used as a citation-verification corpus AND to find this paper's metadata)
  let fsAbstracts: FutureScienceAbstract[] = [];
  try {
    const fsData = await fetchAbstractsAndKeywords([], initiativeDocId);
    fsAbstracts = fsData.abstracts;
  } catch (err) {
    await emitEvent("ethics-fetch-warning", `Future Science fetch failed: ${err instanceof Error ? err.message : String(err)}.`);
  }

  // Resolve paper metadata: prefer FS, fall back to project log, then to caller-supplied title.
  const fsHit = fsAbstracts.find(a => a.documentId === documentId);
  const projHit = (await storage.getProjectPapers(projectId)).find(p => p.sourceDocumentId === documentId);
  const title = paperTitle || fsHit?.title || projHit?.title || `Paper ${documentId}`;
  const authors = fsHit?.authors || projHit?.authors || "(unknown)";
  const date = fsHit?.date || projHit?.date || "";
  const abstract = fsHit?.abstract || projHit?.description || "";
  const url = `https://future-science.org/${initiativeSlug}/${documentId}`;

  // Fetch full text
  await emitEvent("ethics-fulltext", `Fetching full text for "${title}"...`);
  const fullText = await fetchFsPaperContent(documentId, initiativeSlug);
  const hadFullText = !!(fullText && fullText.length > 200);

  // Citation verification (FS + OpenAlex; OpenAlex covers arXiv via search)
  let verification: PaperVerification = { paperTitle: title, hadFullText, citations: [] };
  let urlReport = "**Link analysis:** Skipped (no full text available).";
  let bibReport = "**In-text vs bibliography cross-check:** Skipped (no full text available).";
  if (hadFullText) {
    await emitEvent("ethics-citations", `Extracting and verifying citations against Future Science, OpenAlex, and arXiv (two-source agreement enforced for arXiv IDs)...`);
    const citations = extractCitations(fullText!);
    const verified = await verifyCitations(citations, fsAbstracts);
    verification = { paperTitle: title, hadFullText: true, citations: verified };
    const verifiedCount = verified.filter(v => v.verifiedSource !== "none").length;
    await emitEvent("ethics-citations", `Citation verification complete: ${verifiedCount}/${verified.length} citations verified (two-source rule prevents single-lookup mismatch flags).`);

    await emitEvent("ethics-bib", `Cross-checking in-text (Author, Year) references against bibliography entries...`);
    const bibAnalysis = analyzeInTextVsBibliography(fullText!);
    bibReport = formatBibliographyAnalysis(bibAnalysis);
    await emitEvent("ethics-bib", `Bibliography cross-check complete: ${bibAnalysis.inTextCount} in-text, ${bibAnalysis.bibliographyCount} bibliography, ${bibAnalysis.inTextOnly.length} in-text-only.`);

    await emitEvent("ethics-links", `Extracting and checking all URLs in the paper (with body inspection on 403/401 + Wayback fallback)...`);
    const urls = extractUrls(fullText!);
    const urlsVerified = await verifyUrls(urls);
    urlReport = formatUrlVerificationReport(urlsVerified);
    const okUrls = urlsVerified.filter(u => u.classification === "ok").length;
    const brokenUrls = urlsVerified.filter(u => u.classification === "broken").length;
    const botBlocked = urlsVerified.filter(u => u.classification === "bot-blocked").length;
    await emitEvent("ethics-links", `Link check complete: ${okUrls} OK, ${brokenUrls} broken (host says gone), ${botBlocked} bot-blocked (auditor challenged — not flagged), ${urlsVerified.length - okUrls - brokenUrls - botBlocked} other.`);
  } else {
    await emitEvent("ethics-citations", `Full text could not be retrieved — proceeding with abstract-only audit (Sections A and D will be marked as auditor tool limitations).`);
  }

  const citationBlock = formatVerificationReport(verification);
  const paperBlock = `# TARGET PAPER\n\n**Title:** ${title}\n**Authors:** ${authors}\n**Date:** ${date}\n**Journal:** ${journalDisplayName}\n**URL:** ${url}\n\n## Abstract\n${(abstract || "(no abstract available)").slice(0, 6000)}\n\n## Full Text${hadFullText ? "" : " (NOT AVAILABLE — auditor could not retrieve)"}\n${hadFullText ? (fullText!.slice(0, 30000)) : "(The auditor's automated full-text fetcher returned no usable body content. This is a tool limitation, not evidence of misconduct.)"}\n\n---\n\n## VERIFICATION REPORTS\n\n${citationBlock}\n\n${bibReport}\n\n${urlReport}`;

  await emitEvent("ethics-llm", `Sending audit prompt to ${modelConfig.modelName || modelConfig.provider}...`);
  const result = await generateWithConfig(modelConfig, systemPrompt, paperBlock, { maxTokens: 8000, temperature: 0.3 });
  const ethicsText = result.content;

  const flagsList = extractFlags(ethicsText);
  const recommendations = extractRecommendations(ethicsText);
  const clearanceStatement = extractClearanceStatement(ethicsText);
  const clearanceStatus = extractClearanceStatus(ethicsText);
  const durationSeconds = Math.round((Date.now() - startTime) / 1000);

  const reportTitle = `Single-Paper Ethics Audit: "${title}"`;

  const critCount = flagsList.filter(f => f.severity === "CRITICAL").length;
  const majorCount = flagsList.filter(f => f.severity === "MAJOR").length;
  const minorCount = flagsList.filter(f => f.severity === "MINOR").length;
  const reportAbstract = `This report presents a focused research-ethics audit of the paper "${title}" by ${authors} (${date}), published in ${journalDisplayName}. The audit covers eight ethics categories plus a dedicated link-integrity check, and is grounded in automated verification of every citation (against Future Science and OpenAlex) and every URL (reachability + arXiv-ID validity) extracted from the paper's full text. ${hadFullText ? "Full text was retrieved by the auditor and used as the evidentiary basis for the categories that depend on it (A, D, F, I)." : "Full text could not be retrieved by the auditor; abstract-only assessment was performed for the categories that allow it, and Sections A and D were marked as auditor tool limitations rather than ethics findings."} ${flagsList.length} ethics concern(s) were identified: ${critCount} critical, ${majorCount} major, and ${minorCount} minor. Overall paper clearance: ${clearanceStatus.replace(/_/g, " ")}.`;

  const auditedPaperIds = [`doc:${documentId}`, `title:${title.toLowerCase().trim()}`];

  return {
    ethicsText,
    chunk1: ethicsText,
    chunk2: "",
    chunk3: "",
    flagsList,
    recommendations,
    clearanceStatement,
    clearanceStatus,
    reportTitle,
    reportAbstract,
    durationSeconds,
    papersUsed: [{ title, authors, date, documentId }],
    auditedPaperIds,
  };
}
