import { storage } from "./storage";
import { generateWithConfig, type ModelProviderConfig } from "./model-service";
import { loadPaperContext } from "./ethics-review";
import {
  getPeerReviewPrompt,
  extractRecommendation,
  reconcileRecommendation,
  extractRevisions,
  buildVerificationSection,
  derivePeerReviewKeywords,
  type PeerReviewPersona,
} from "./prompts/peer-review";
import type { EthicsReviewOutput } from "./ethics-review";

export interface PeerReviewOutput {
  reviewText: string;
  chunk1: string;
  chunk2: string;
  chunk3: string;
  reviewTitle: string;
  reviewAbstract: string;
  recommendation: string;
  majorRevisions: Array<{ description: string }>;
  minorRevisions: Array<{ description: string }>;
  durationSeconds: number;
  paperUsed: { title: string; authors: string; date: string; documentId: string };
  keywords: string[];
  ethicsSummary?: string;
  ethicsUsed: boolean;
}

interface RunPeerReviewOptions {
  reviewId: string;
  projectId: string;
  persona: PeerReviewPersona;
  agentName: string;
  journalId: string;
  initiativeDocId: string;
  initiativeSlug: string;
  journalDisplayName: string;
  documentId: string;
  paperTitle?: string | null;
  prompt: string;
  modelConfig: ModelProviderConfig;
  emitEvent: (phase: string, message: string) => Promise<void>;
  ethicsResult?: EthicsReviewOutput | null;
  ethicsPromise?: Promise<EthicsReviewOutput | null>;
}

function buildPriorLiteratureBlock(fsAbstracts: Array<{ title: string; authors: string; date: string; abstract: string; documentId: string }>, currentDocumentId: string): string {
  const others = fsAbstracts.filter(a => a.documentId !== currentDocumentId).slice(0, 30);
  if (others.length === 0) return "(No prior literature available from this journal.)";
  return others.map((a, i) => {
    const yearMatch = (a.date || "").match(/\d{4}/);
    const year = yearMatch ? yearMatch[0] : "n.d.";
    const firstAuthor = (a.authors || "Unknown").split(/[,;]/)[0].trim();
    return `[${i + 1}] ${firstAuthor} (${year}). "${a.title}".\n    Abstract: ${(a.abstract || "").slice(0, 800)}`;
  }).join("\n\n");
}

function buildEthicsCoauthorBlock(ethics: EthicsReviewOutput): string {
  const flagsByLevel = (sev: "CRITICAL" | "MAJOR" | "MINOR") =>
    ethics.flagsList.filter(f => f.severity === sev).map(f => `  - ${f.summary}`).join("\n") || "  (none)";
  return [
    `# ETHICS CO-AUTHOR BLOCK (parallel publication audit by H-persona Research Standards Verification Agent)`,
    ``,
    `**Clearance status:** ${ethics.clearanceStatus.replace(/_/g, " ")}`,
    `**Clearance statement:** ${ethics.clearanceStatement.slice(0, 1000)}`,
    ``,
    `**CRITICAL ethics findings:**`,
    flagsByLevel("CRITICAL"),
    ``,
    `**MAJOR ethics findings:**`,
    flagsByLevel("MAJOR"),
    ``,
    `**MINOR ethics findings:**`,
    flagsByLevel("MINOR"),
    ``,
    `**Top ethics recommendations:**`,
    ethics.recommendations.slice(0, 8).map(r => `  - ${r}`).join("\n") || "  (none)",
  ].join("\n");
}

export async function runPeerReview(opts: RunPeerReviewOptions): Promise<PeerReviewOutput> {
  const startTime = Date.now();
  const { projectId, persona, journalDisplayName, initiativeDocId, initiativeSlug, documentId, paperTitle, modelConfig, emitEvent, prompt, ethicsPromise } = opts;
  let { ethicsResult } = opts;

  await emitEvent("peer-review-init", `Starting ${persona} peer review on "${paperTitle || documentId}" in ${journalDisplayName}.`);

  const ctx = await loadPaperContext({ projectId, documentId, initiativeDocId, initiativeSlug, paperTitle: paperTitle || undefined, emitEvent, eventPrefix: "paper" });
  const { title, authors, date, abstract, url, fullText, hadFullText, fsAbstracts } = ctx;

  const paperBody = `# SUBMITTED PAPER\n\n**Title:** ${title}\n**Authors:** ${authors}\n**Date:** ${date}\n**Journal:** ${journalDisplayName}\n**URL:** ${url}\n\n## Abstract\n${(abstract || "(no abstract available)").slice(0, 6000)}\n\n## Full Text${hadFullText ? "" : " (NOT AVAILABLE — reviewer could not retrieve)"}\n${hadFullText ? (fullText!.slice(0, 30000)) : "(The reviewer's automated full-text fetcher returned no usable body content. Review proceeds on abstract only — note this limitation in your assessment.)"}`;

  const priorLitBlock = buildPriorLiteratureBlock(fsAbstracts, documentId);

  if (!ethicsResult && ethicsPromise) {
    await emitEvent("peer-review-ethics-await", "Awaiting parallel ethics co-author audit before final synthesis...");
    try {
      ethicsResult = await ethicsPromise;
      if (!ethicsResult) {
        await emitEvent("peer-review-ethics-skipped", "Ethics co-author audit returned no result; proceeding without ethics integration. The peer review will be published without H listed as co-author.");
      }
    } catch (err) {
      console.error("[PeerReview] ethicsPromise rejected:", err);
      ethicsResult = null;
      const msg = err instanceof Error ? err.message : String(err);
      await emitEvent("peer-review-ethics-failed", `Parallel ethics co-author audit failed: ${msg}. The peer review will be published WITHOUT H listed as co-author.`);
    }
  }

  let ethicsBlock = "";
  let ethicsSummary: string | undefined;
  if (ethicsResult) {
    ethicsBlock = `\n\n---\n\n${buildEthicsCoauthorBlock(ethicsResult)}`;
    ethicsSummary = `Ethics co-author (H): ${ethicsResult.clearanceStatus.replace(/_/g, " ")} — ${ethicsResult.flagsList.filter(f => f.severity === "CRITICAL").length} critical, ${ethicsResult.flagsList.filter(f => f.severity === "MAJOR").length} major, ${ethicsResult.flagsList.filter(f => f.severity === "MINOR").length} minor flags.`;
    await emitEvent("peer-review-ethics-merge", `Integrating ethics co-author findings into review. ${ethicsSummary}`);
  }

  const userInput = `${paperBody}\n\n---\n\n# PUBLICATIONS (Prior work from ${journalDisplayName})\n\n${priorLitBlock}${ethicsBlock}`;

  await emitEvent("peer-review-llm", `Sending peer review to ${modelConfig.modelName || modelConfig.provider}${ethicsResult ? " with ethics integration" : ""}...`);
  const result = await generateWithConfig(modelConfig, prompt, userInput, { maxTokens: 8000, temperature: 0.4 });
  const reviewText = result.content;
  await emitEvent("peer-review-llm", `Peer review complete (${reviewText.length} chars).`);

  // Parse recommendation/revisions from the raw LLM output BEFORE appending the
  // deterministic verification section, so that section can never be mistaken
  // for the reviewer's own revision lists.
  const { major: majorRevisions, minor: minorRevisions } = extractRevisions(reviewText);
  // Reconcile the verdict with the body: a review that lists one or more Major
  // Revisions can never conclude "Accept" or "Minor Revision".
  const recommendationParsed = reconcileRecommendation(
    extractRecommendation(reviewText) || "Major Revision",
    majorRevisions.length,
  );
  const personaLabel = persona === "bR" ? "Basic" : persona === "aR" ? "Adversarial" : persona === "iR" ? "Innovation" : "Rigorous";
  const reviewTitle = `${personaLabel} Peer Review: "${title}"`;

  // When an H co-author audit ran, always append a dedicated, deterministic
  // "Research Standards Verification" section documenting its scope, method, and
  // findings — regardless of what the LLM chose to write about it.
  let finalReviewText = reviewText;
  if (ethicsResult) {
    const verificationSection = buildVerificationSection({
      clearanceStatus: ethicsResult.clearanceStatus,
      clearanceStatement: ethicsResult.clearanceStatement,
      flags: ethicsResult.flagsList,
      recommendations: ethicsResult.recommendations,
    });
    finalReviewText = `${reviewText.trimEnd()}\n\n---\n\n${verificationSection}\n`;
  }

  const reviewAbstract = `This document is a peer review of "${title}" by ${authors} (${date}), published in ${journalDisplayName}. The review was produced by a ${personaLabel} peer-review agent (${persona}). ${hadFullText ? "Full paper text was retrieved and used as the primary evidentiary basis." : "Full paper text could not be retrieved; the review proceeds on the abstract only."} ${ethicsResult ? `A Research Standards Verification Agent co-author (H-persona) ran a parallel publication audit (clearance: ${ethicsResult.clearanceStatus.replace(/_/g, " ")}); see the Research Standards Verification section for its scope, methodology, and findings. ` : ""}Final recommendation: ${recommendationParsed}.`;

  // Derive meaningful Future Science keywords from the audited paper itself.
  const paperKeywords = fsAbstracts.find((a) => a.documentId === documentId)?.keywords ?? [];
  const keywords = derivePeerReviewKeywords({ paperKeywords, paperTitle: title, persona });

  const durationSeconds = Math.round((Date.now() - startTime) / 1000);

  return {
    reviewText: finalReviewText,
    chunk1: finalReviewText,
    chunk2: "",
    chunk3: "",
    reviewTitle,
    reviewAbstract,
    recommendation: recommendationParsed,
    majorRevisions,
    minorRevisions,
    durationSeconds,
    paperUsed: { title, authors, date, documentId },
    keywords,
    ethicsSummary,
    ethicsUsed: !!ethicsResult,
  };
}
