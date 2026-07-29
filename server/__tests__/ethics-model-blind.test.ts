/**
 * Model-blind H audit leakage guard: proves the H Research Standards
 * Verification Agent never receives the target paper's author name, agent
 * code, detected model, or URL when modelBlind=true — and that the audit's
 * OUTPUTS (ethics text, clearance statement, flags, recommendations, report
 * abstract) are redacted so nothing identifying flows back into the published
 * peer review's verification section.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateWithConfigMock = vi.fn();

vi.mock("../model-service", () => ({
  generateWithConfig: (...args: any[]) => generateWithConfigMock(...args),
}));

vi.mock("../storage", () => ({
  storage: {
    getProjectPapers: vi.fn(async () => []),
    getEthicsReportsByProject: vi.fn(async () => []),
  },
}));

const AUTHOR = "MachInstit CS45bR-N1";
const PAPER_URL = "https://future-science.org/mirror/doc-1";

vi.mock("../future-science", () => ({
  fetchAbstractsAndKeywords: vi.fn(async () => ({
    abstracts: [{
      title: "Emergent Coordination in Agent Collectives",
      abstract: "We, MachInstit CS45bR-N1, study coordination. Drafted by Claude Sonnet 4.5 (also written claude-sonnet-4.5, ClaudeSonnet45).",
      authors: AUTHOR,
      date: "2026-05-01",
      keywords: ["agents"],
      documentId: "doc-1",
      agentDescription: "This agent ran Claude Sonnet 4.5.",
    }],
    allKeywords: [],
  })),
  FutureScienceFetchError: class FutureScienceFetchError extends Error {},
}));

vi.mock("../citation-verifier", () => ({
  fetchFsPaperContent: vi.fn(async () =>
    "Full text. Corresponding author: MACHINSTIT CS45BR-N1. Model: Anthropic Claude Sonnet 4.5. " +
    "Padding sentence to exceed the minimum body length. ".repeat(10)),
  extractCitations: vi.fn(() => []),
  verifyCitations: vi.fn(async () => []),
  formatVerificationReport: vi.fn(() => "Citation report mentioning MachInstit CS45bR-N1 self-citation."),
  extractUrls: vi.fn(() => []),
  verifyUrls: vi.fn(async () => []),
  formatUrlVerificationReport: vi.fn(() => "URL report."),
  analyzeInTextVsBibliography: vi.fn(() => ({ inTextCount: 0, bibliographyCount: 0, inTextOnly: [], bibliographyOnly: [], bibliographyDetected: false })),
  formatBibliographyAnalysis: vi.fn(() => "Bib report."),
  buildSemanticGlossPairs: vi.fn(async () => []),
  formatSemanticGlossReport: vi.fn(() => "Gloss report."),
}));

import { runEthicsReport } from "../ethics-review";

const LEAK_PATTERNS: Array<[string, RegExp]> = [
  ["author org token", /machinstit/i],
  ["convention code", /cs45/i],
  ["model label variants", /claude[\s._/-]*sonnet[\s._/-]*4[\s._/-]*5/i],
  ["paper URL", /future-science\.org\/mirror\/doc-1/i],
];

function expectNoLeak(text: string, where: string) {
  for (const [label, re] of LEAK_PATTERNS) {
    expect(text, `${where} leaked ${label} (${re}) in model-blind mode`).not.toMatch(re);
  }
}

const baseOpts = {
  reportId: "rep-1",
  projectId: "proj-1",
  agentId: "H",
  agentName: "MachInstit G5H-N1MB",
  journalId: "mirror",
  initiativeDocId: "init-doc",
  initiativeSlug: "mirror",
  journalDisplayName: "Mirror",
  keywords: [] as string[],
  prompt1: "P1",
  prompt2: "P2",
  prompt3: "P3",
  documentId: "doc-1",
  paperTitle: "Emergent Coordination in Agent Collectives",
  singlePaperPrompt: "AUDIT-PROMPT",
  modelConfig: { providerMode: "platform" as const, provider: "openrouter", modelName: "openai/gpt-5" },
  emitEvent: async () => {},
};

// The H LLM echoes identifying bait back — output redaction must catch it.
const H_OUTPUT = [
  "## Audit",
  "The paper by MachInstit CS45bR-N1 (Claude Sonnet 4.5, also styled ClaudeSonnet45 or claude_sonnet_4_5) was audited.",
  "**CRITICAL:** MachInstit CS45bR-N1 fabricated a citation.",
  "## Recommendations",
  "- Ask machinstit to fix citations.",
  "**Clearance statement:** Cleared with conditions; MachInstit CS45bR-N1 must revise.",
  "CLEARANCE: CLEARED_WITH_CONDITIONS",
].join("\n\n");

describe("model-blind H audit", () => {
  beforeEach(() => {
    generateWithConfigMock.mockReset();
    generateWithConfigMock.mockResolvedValue({ content: H_OUTPUT });
  });

  it("withholds author, agent code, model, and URL from H's LLM input when modelBlind=true", async () => {
    await runEthicsReport({ ...baseOpts, modelBlind: true });

    expect(generateWithConfigMock).toHaveBeenCalledTimes(1);
    const userInput = generateWithConfigMock.mock.calls[0][2] as string;

    expectNoLeak(userInput, "H LLM input");
    expect(userInput).toContain("**Authors:** (withheld — model-blind audit)");
    expect(userInput).toContain("**URL:** (withheld — model-blind audit)");
    expect(userInput).toContain("MODEL-BLIND (author-blind) audit");
    expect(userInput).toContain("[withheld]");
  });

  it("redacts H's outputs so no identity flows back into the verification section", async () => {
    const out = await runEthicsReport({ ...baseOpts, modelBlind: true });

    expectNoLeak(out.ethicsText, "ethicsText");
    expectNoLeak(out.clearanceStatement, "clearanceStatement");
    expectNoLeak(out.reportAbstract, "reportAbstract");
    for (const f of out.flagsList) expectNoLeak(f.summary, "flag summary");
    for (const r of out.recommendations) expectNoLeak(r, "recommendation");
    expect(out.ethicsText).toContain("[withheld]");
  });

  it("control: non-blind audits DO give H the author name and URL", async () => {
    await runEthicsReport({ ...baseOpts, modelBlind: false });

    const userInput = generateWithConfigMock.mock.calls[0][2] as string;
    expect(userInput).toContain(`**Authors:** ${AUTHOR}`);
    expect(userInput).toContain(`**URL:** ${PAPER_URL}`);
    expect(userInput).not.toContain("MODEL-BLIND");
  });
});
