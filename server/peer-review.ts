import { storage } from "./storage";
import { generateWithConfig, type ModelProviderConfig } from "./model-service";
import { loadPaperContext } from "./ethics-review";
import {
  getPeerReviewChunkPrompts,
  extractRecommendation,
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
  durationSeconds: number;
  paperUsed: { title: string; authors: string; date: string; documentId: string };
  ethicsSummary?: string;
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
  prompt1: string;
  prompt2: string;
  prompt3: string;
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
    `# ETHICS CO-AUTHOR BLOCK (parallel ethics audit by H-persona Ethicist)`,
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
  const { projectId, persona, journalDisplayName, initiativeDocId, initiativeSlug, documentId, paperTitle, modelConfig, emitEvent, prompt1, prompt2, prompt3, ethicsPromise } = opts;
  let { ethicsResult } = opts;

  await emitEvent("peer-review-init", `Starting ${persona} peer review on "${paperTitle || documentId}" in ${journalDisplayName}.`);

  const ctx = await loadPaperContext({ projectId, documentId, initiativeDocId, initiativeSlug, paperTitle: paperTitle || undefined, emitEvent, eventPrefix: "paper" });
  const { title, authors, date, abstract, url, fullText, hadFullText, fsAbstracts } = ctx;

  const paperBody = `# SUBMITTED PAPER\n\n**Title:** ${title}\n**Authors:** ${authors}\n**Date:** ${date}\n**Journal:** ${journalDisplayName}\n**URL:** ${url}\n\n## Abstract\n${(abstract || "(no abstract available)").slice(0, 6000)}\n\n## Full Text${hadFullText ? "" : " (NOT AVAILABLE — reviewer could not retrieve)"}\n${hadFullText ? (fullText!.slice(0, 30000)) : "(The reviewer's automated full-text fetcher returned no usable body content. Review proceeds on abstract only — note this limitation in your assessment.)"}`;

  await emitEvent("peer-review-llm-1", `Sending Part 1 (sections 1–4) to ${modelConfig.modelName || modelConfig.provider}...`);
  const chunk1Result = await generateWithConfig(modelConfig, prompt1, paperBody, { maxTokens: 6000, temperature: 0.4 });
  const chunk1 = chunk1Result.content;
  await emitEvent("peer-review-llm-1", `Part 1 complete (${chunk1.length} chars).`);

  const priorLitBlock = buildPriorLiteratureBlock(fsAbstracts, documentId);
  const part2Input = `${paperBody}\n\n---\n\n# PUBLICATIONS (Prior work from ${journalDisplayName})\n\n${priorLitBlock}`;
  await emitEvent("peer-review-llm-2", `Sending Part 2 (sections 5–6) with ${fsAbstracts.length} prior-literature abstracts...`);
  const chunk2Result = await generateWithConfig(modelConfig, prompt2, part2Input, { maxTokens: 5000, temperature: 0.4 });
  const chunk2 = chunk2Result.content;
  await emitEvent("peer-review-llm-2", `Part 2 complete (${chunk2.length} chars).`);

  if (!ethicsResult && ethicsPromise) {
    await emitEvent("peer-review-ethics-await", "Parts 1 & 2 complete; awaiting parallel ethics co-author audit before final synthesis...");
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
    await emitEvent("peer-review-ethics-merge", `Integrating ethics co-author findings into final synthesis. ${ethicsSummary}`);
  }

  const part3Input = `# PART 1 (Sections 1–4)\n\n${chunk1}\n\n---\n\n# PART 2 (Sections 5–6)\n\n${chunk2}${ethicsBlock}`;
  await emitEvent("peer-review-llm-3", `Sending Part 3 (sections 7–9 + bibliography) for synthesis${ethicsResult ? " with ethics integration" : ""}...`);
  const chunk3Result = await generateWithConfig(modelConfig, prompt3, part3Input, { maxTokens: 5000, temperature: 0.4 });
  const chunk3 = chunk3Result.content;
  await emitEvent("peer-review-llm-3", `Part 3 complete (${chunk3.length} chars).`);

  const reviewText = `${chunk1}\n\n${chunk2}\n\n${chunk3}`;
  const recommendationParsed = extractRecommendation(chunk3) || "Major Revision";
  const personaLabel = persona === "bR" ? "Basic" : persona === "aR" ? "Adversarial" : "Innovation";
  const reviewTitle = `${personaLabel} Peer Review: "${title}"`;

  const reviewAbstract = `This document is a structured peer review of "${title}" by ${authors} (${date}), published in ${journalDisplayName}. The review was produced by a ${personaLabel} peer-review agent (${persona}) and follows a 9-section format: paper summary, readability, methodology, interpretation, comparison with prior literature, strengths, weaknesses, required revisions, and a final recommendation. ${hadFullText ? "Full paper text was retrieved and used as the primary evidentiary basis." : "Full paper text could not be retrieved; the review proceeds on the abstract only."} ${ethicsResult ? `An ethics co-author (H-persona Ethicist) ran in parallel and contributed findings (clearance: ${ethicsResult.clearanceStatus.replace(/_/g, " ")}). ` : ""}Final recommendation: ${recommendationParsed}.`;

  const durationSeconds = Math.round((Date.now() - startTime) / 1000);

  return {
    reviewText,
    chunk1,
    chunk2,
    chunk3,
    reviewTitle,
    reviewAbstract,
    recommendation: recommendationParsed,
    durationSeconds,
    paperUsed: { title, authors, date, documentId },
    ethicsSummary,
  };
}
