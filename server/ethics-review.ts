import { storage } from "./storage";
import { generateWithConfig, type ModelProviderConfig } from "./model-service";
import {
  H_SOLO_REPORT_CHUNK_1_PROMPT,
  H_SOLO_REPORT_CHUNK_2_PROMPT,
  H_SOLO_REPORT_CHUNK_3_PROMPT,
  applyJournalName,
} from "./prompts/h-solo";
import { fetchAbstractsAndKeywords, type FutureScienceAbstract } from "./future-science";
import {
  fetchFsPaperContent,
  extractCitations,
  verifyCitations,
  formatVerificationReport,
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
  papersUsed: { title: string; authors: string; date: string }[];
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
  const startTime = Date.now();
  const { projectId, journalId, initiativeDocId, initiativeSlug, journalDisplayName, keywords, topic, prompt1, prompt2, prompt3, modelConfig, emitEvent } = opts;
  const journalName = opts.journalName || journalDisplayName || journalId;
  const sub1 = applyJournalName(prompt1, journalName);
  const sub2 = applyJournalName(prompt2, journalName);
  const sub3 = applyJournalName(prompt3, journalName);
  const fsPaperUrl = (docId: string | undefined | null): string =>
    docId ? `https://future-science.org/${initiativeSlug}/papers/${docId}` : "";

  await emitEvent("ethics-init", `Starting field ethics report on ${journalId}${topic ? ` — topic "${topic}"` : ""} (${keywords.length} keyword filter(s)).`);

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

  const seen = new Set<string>();
  type SamplePaper = { title: string; authors: string; date: string; abstract: string; url: string; documentId?: string };
  function buildSample(applyCutoff: boolean): SamplePaper[] {
    const cutoff = applyCutoff ? (prevReport?.date || null) : null;
    const localSeen = new Set<string>();
    const out: SamplePaper[] = [];
    for (const p of filteredProj) {
      const key = p.title.toLowerCase().trim();
      if (localSeen.has(key)) continue;
      if (cutoff && p.date && new Date(p.date) <= cutoff) continue;
      localSeen.add(key);
      const url = p.url || fsPaperUrl(p.sourceDocumentId);
      out.push({ title: p.title, authors: p.authors, date: p.date, abstract: p.description, url, documentId: p.sourceDocumentId || undefined });
    }
    for (const a of filteredFs) {
      const key = a.title.toLowerCase().trim();
      if (localSeen.has(key)) continue;
      if (cutoff && a.date && new Date(a.date) <= cutoff) continue;
      localSeen.add(key);
      out.push({ title: a.title, authors: a.authors, date: a.date, abstract: a.abstract, url: fsPaperUrl(a.documentId), documentId: a.documentId });
    }
    return out;
  }

  let sample = buildSample(true);
  let cutoffWasRelaxed = false;
  if (sample.length === 0 && prevReport) {
    sample = buildSample(false);
    if (sample.length > 0) {
      cutoffWasRelaxed = true;
      await emitEvent("ethics-cutoff-relaxed", `No new papers since previous report (${prevReport.date.toISOString().slice(0, 10)}); auditing the full keyword-matched corpus instead.`);
    }
  }
  void seen;

  if (sample.length === 0) {
    throw new Error("No papers matched the selected keywords for this journal. Try broadening the keywords or removing them.");
  }

  const TARGET = Math.min(sample.length, 35);
  const sampled = sample.slice(0, TARGET);

  const coveragePeriod = prevReport && !cutoffWasRelaxed
    ? `${prevReport.date.toISOString().slice(0, 10)} to ${new Date().toISOString().slice(0, 10)}`
    : prevReport && cutoffWasRelaxed
      ? `Full corpus re-audit (no new papers since ${prevReport.date.toISOString().slice(0, 10)}; previous report retained as baseline)`
      : `Inaugural assessment (all available publications up to ${new Date().toISOString().slice(0, 10)})`;

  await emitEvent("ethics-sample", `Sampled ${sampled.length} paper(s) for audit (${projectPapers.length} project log + ${fsAbstracts.length} FS) covering ${coveragePeriod}.`);

  await emitEvent("ethics-citations", `Fetching full text and verifying citations against Future Science + OpenAlex for ${sampled.length} paper(s)...`);
  const verifications: PaperVerification[] = [];
  let totalCitations = 0;
  let totalVerified = 0;
  for (const p of sampled) {
    let fullText: string | null = null;
    if (p.documentId) {
      fullText = await fetchFsPaperContent(p.documentId);
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
  const reportTitle = `Field Ethics Report on ${journalId}: ${reportDateLabel}`;

  const critCount = flagsList.filter(f => f.severity === "CRITICAL").length;
  const majorCount = flagsList.filter(f => f.severity === "MAJOR").length;
  const minorCount = flagsList.filter(f => f.severity === "MINOR").length;
  const comparisonNote = prevReport
    ? ` This report compares findings against a previous assessment dated ${prevReport.date.toISOString().slice(0, 10)} to evaluate whether ethical standards have improved, worsened, or remained stable.`
    : " This is the inaugural field ethics assessment for this journal.";
  const reportAbstract = `This report presents a systematic field-level ethical assessment of ${journalId} research. A total of ${sampled.length} studies (covering ${coveragePeriod}) were audited for six ethical concern categories: evidentiary weakness, citation integrity, overinterpretation of model behaviour, inflated novelty claims, anthropomorphic framing, and methodological opacity.${comparisonNote} The audit identified ${flagsList.length} ethical concern(s): ${critCount} critical, ${majorCount} major, and ${minorCount} minor. Overall field clearance status: ${clearanceStatus.replace(/_/g, " ")}.`;

  return {
    ethicsText, chunk1, chunk2, chunk3, flagsList, recommendations,
    clearanceStatement, clearanceStatus, reportTitle, reportAbstract, durationSeconds,
    papersUsed: sampled.map(p => ({ title: p.title, authors: p.authors, date: p.date })),
  };
}
