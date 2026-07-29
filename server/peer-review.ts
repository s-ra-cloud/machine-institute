import { storage } from "./storage";
import { generateWithConfig, type ModelProviderConfig } from "./model-service";
import { loadPaperContext } from "./ethics-review";
import {
  getPeerReviewPrompt,
  extractRecommendation,
  reconcileRecommendation,
  extractRevisions,
  extractReviewSummary,
  buildPeerReviewAbstract,
  buildVerificationSection,
  derivePeerReviewKeywords,
  type PeerReviewPersona,
} from "./prompts/peer-review";
import type { EthicsReviewOutput } from "./ethics-review";
import { detectAuthoringModel } from "./model-detection";

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
  /** Model detected as having authored the target paper (recorded even in model-blind mode). */
  targetModel: string | null;
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
  /** Author-blind (model-blind) review: withhold the target paper's author/model identity from the evaluator. */
  modelBlind?: boolean;
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
  const { title, authors, date, abstract, url, fullText, hadFullText, fsAbstracts, agentDescription } = ctx;

  // Detect the model that authored the target paper from its metadata (author
  // name convention codes, agent description if present). Recorded regardless
  // of blind mode; only COMMUNICATED to the evaluator in non-blind mode.
  const modelBlind = !!opts.modelBlind;
  const targetModel = detectAuthoringModel(authors, agentDescription);
  if (targetModel) {
    await emitEvent("peer-review-target-model", `Target paper authoring model identified from metadata: ${targetModel}${modelBlind ? " (withheld from evaluator — model-blind review)" : " (communicated to evaluator)"}.`);
  } else {
    await emitEvent("peer-review-target-model", "No authoring model could be identified from the target paper's metadata.");
  }

  // In model-blind mode, withhold author identity (which encodes the model by
  // convention) and any detected model info from everything the evaluator sees.
  // Redaction is token-based and case-insensitive: full author names AND each
  // distinctive name token (e.g. "Autointerp", "CS45bR-N1") are stripped, so
  // surname-only or reformatted mentions in the abstract/full text are caught.
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const redactionTargets: string[] = [];
  if (authors) {
    for (const name of authors.split(/[,;]/).map(s => s.trim()).filter(Boolean)) {
      if (name.length >= 4) redactionTargets.push(name);
      for (const token of name.split(/\s+/)) {
        if (token.length >= 4 && !/^(the|and|of|for)$/i.test(token)) redactionTargets.push(token);
      }
    }
  }
  if (targetModel) redactionTargets.push(targetModel);
  // Longest first so full names are replaced before their tokens.
  redactionTargets.sort((a, b) => b.length - a.length);
  const redactAuthors = (text: string): string => {
    if (!modelBlind || redactionTargets.length === 0) return text;
    let out = text;
    for (const target of redactionTargets) {
      out = out.replace(new RegExp(escapeRe(target), "gi"), "[withheld]");
    }
    return out;
  };

  const authorsLine = modelBlind ? "(withheld — model-blind review)" : authors;
  const modelLine = !modelBlind
    ? `\n**Authoring model (from document metadata):** ${targetModel || "(not identifiable)"}`
    : "";
  const paperBody = `# SUBMITTED PAPER\n\n**Title:** ${title}\n**Authors:** ${authorsLine}${modelLine}\n**Date:** ${date}\n**Journal:** ${journalDisplayName}\n**URL:** ${modelBlind ? "(withheld — model-blind review)" : url}\n\n## Abstract\n${redactAuthors((abstract || "(no abstract available)").slice(0, 6000))}\n\n## Full Text${hadFullText ? "" : " (NOT AVAILABLE — reviewer could not retrieve)"}\n${hadFullText ? redactAuthors(fullText!.slice(0, 30000)) : "(The reviewer's automated full-text fetcher returned no usable body content. Review proceeds on abstract only — note this limitation in your assessment.)"}`;

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
    // The ethics audit can quote author/model-identifying details from the
    // paper; in model-blind mode this block must be redacted too.
    ethicsBlock = redactAuthors(`\n\n---\n\n${buildEthicsCoauthorBlock(ethicsResult)}`);
    ethicsSummary = `Ethics co-author (H): ${ethicsResult.clearanceStatus.replace(/_/g, " ")} — ${ethicsResult.flagsList.filter(f => f.severity === "CRITICAL").length} critical, ${ethicsResult.flagsList.filter(f => f.severity === "MAJOR").length} major, ${ethicsResult.flagsList.filter(f => f.severity === "MINOR").length} minor flags.`;
    await emitEvent("peer-review-ethics-merge", `Integrating ethics co-author findings into review. ${ethicsSummary}`);
  }

  const blindNote = modelBlind
    ? `\n\n---\n\n# REVIEW CONFIGURATION\nThis is a MODEL-BLIND (author-blind) review: the identity of the author and the model that produced the submitted paper have been deliberately withheld. Evaluate the work strictly on its content. Do not speculate about which model or agent wrote it.`
    : "";
  const userInput = `${paperBody}${blindNote}\n\n---\n\n# PUBLICATIONS (Prior work from ${journalDisplayName})\n\n${priorLitBlock}${ethicsBlock}`;

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

  // Build a substantive abstract that summarises the review's actual findings.
  // The reviewer is instructed to emit a leading "## Review Summary" section; we
  // parse it out (no extra model call) and fall back to a deterministic summary
  // composed from the recommendation + extracted revisions when it is absent.
  const reviewSummary = extractReviewSummary(reviewText);
  const reviewAbstract = buildPeerReviewAbstract({
    title,
    persona,
    recommendation: recommendationParsed,
    summary: reviewSummary,
    majorRevisions,
    minorRevisions,
    ethicsSummary,
  });

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
    targetModel,
  };
}
