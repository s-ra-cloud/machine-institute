import { describe, it, expect, vi, beforeEach } from "vitest";

const generateWithConfigMock = vi.fn();
const loadPaperContextMock = vi.fn();

vi.mock("../model-service", () => ({
  generateWithConfig: (...args: any[]) => generateWithConfigMock(...args),
}));

vi.mock("../ethics-review", () => ({
  loadPaperContext: (...args: any[]) => loadPaperContextMock(...args),
}));

vi.mock("../storage", () => ({
  storage: {},
}));

import { runPeerReview } from "../peer-review";
import type { EthicsReviewOutput } from "../ethics-review";

const baseCtx = {
  title: "A Test Paper",
  authors: "Alice Researcher",
  date: "2025-01-15",
  abstract: "This is the abstract.",
  url: "https://future-science.org/mirror/doc-1",
  fullText: "Body of the paper. ".repeat(50),
  hadFullText: true,
  fsAbstracts: [
    { title: "Other A", authors: "Bob", date: "2024-03-01", abstract: "abs A", documentId: "other-1" },
    { title: "Other B", authors: "Carol", date: "2024-05-10", abstract: "abs B", documentId: "other-2" },
    { title: "Self", authors: "Alice", date: "2025-01-15", abstract: "self", documentId: "doc-1" },
  ],
};

const baseOpts = {
  reviewId: "rev-1",
  projectId: "proj-1",
  persona: "bR" as const,
  agentName: "MachInstit DS32bR-N1",
  journalId: "mirror",
  initiativeDocId: "init-doc",
  initiativeSlug: "mirror",
  journalDisplayName: "Mirror",
  documentId: "doc-1",
  paperTitle: "A Test Paper",
  prompt: "PEER-PROMPT",
  modelConfig: { providerMode: "platform" as const, provider: "openrouter", modelName: "deepseek/deepseek-chat" },
  emitEvent: async (_phase: string, _msg: string) => {},
};

function makeEthics(overrides: Partial<EthicsReviewOutput> = {}): EthicsReviewOutput {
  return {
    ethicsText: "ethics report body",
    chunk1: "ec1",
    chunk2: "ec2",
    chunk3: "ec3",
    flagsList: [
      { severity: "CRITICAL", summary: "Fabricated citation in §2" },
      { severity: "MAJOR", summary: "Selective reporting in Table 3" },
      { severity: "MINOR", summary: "Missing license disclosure" },
    ],
    recommendations: ["Verify citations", "Disclose license"],
    clearanceStatement: "Cleared with conditions pending citation fixes.",
    clearanceStatus: "CLEARED_WITH_CONDITIONS",
    reportTitle: "Ethics Report",
    reportAbstract: "abs",
    durationSeconds: 1,
    papersUsed: [{ title: "A Test Paper", authors: "Alice", date: "2025-01-15", documentId: "doc-1" }],
    auditedPaperIds: ["doc:doc-1"],
    ...overrides,
  };
}

describe("runPeerReview — end-to-end with stubbed LLM", () => {
  beforeEach(() => {
    generateWithConfigMock.mockReset();
    loadPaperContextMock.mockReset();
    loadPaperContextMock.mockResolvedValue(baseCtx);
  });

  it("makes exactly one LLM call with the single prompt and combined input, parses recommendation", async () => {
    const calls: Array<{ prompt: string; user: string }> = [];
    generateWithConfigMock.mockImplementation(async (_cfg, prompt, user) => {
      calls.push({ prompt, user });
      return { content: "Final assessment\nRecommendation: Minor Revision\n" };
    });

    const out = await runPeerReview(baseOpts);

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toBe("PEER-PROMPT");

    // The single user message contains the paper body…
    expect(calls[0].user).toContain("# SUBMITTED PAPER");
    expect(calls[0].user).toContain("A Test Paper");

    // …and the prior-literature block (other documents, not self)…
    expect(calls[0].user).toContain("# PUBLICATIONS (Prior work from Mirror)");
    expect(calls[0].user).toContain("Other A");
    expect(calls[0].user).toContain("Other B");
    expect(calls[0].user).not.toContain('"Self"');

    // …and NO ethics block when no ethics supplied.
    expect(calls[0].user).not.toContain("ETHICS CO-AUTHOR BLOCK");

    expect(out.recommendation).toBe("Minor Revision");
    expect(out.ethicsUsed).toBe(false);
    expect(out.ethicsSummary).toBeUndefined();

    // For backward compatibility with storage, the full text lives in chunk1.
    expect(out.chunk1).toBe(out.reviewText);
    expect(out.chunk2).toBe("");
    expect(out.chunk3).toBe("");
  });

  it("includes the ethics co-author block in the single LLM call when ethicsPromise resolves", async () => {
    const calls: Array<{ prompt: string; user: string }> = [];
    generateWithConfigMock.mockImplementation(async (_cfg, prompt, user) => {
      calls.push({ prompt, user });
      return { content: "Recommendation: Major Revision\n" };
    });

    const ethics = makeEthics();
    const out = await runPeerReview({ ...baseOpts, ethicsPromise: Promise.resolve(ethics) });

    expect(calls).toHaveLength(1);
    const userInput = calls[0].user;
    expect(userInput).toContain("ETHICS CO-AUTHOR BLOCK");
    expect(userInput).toContain("CLEARED WITH CONDITIONS");
    expect(userInput).toContain("Fabricated citation in §2");
    expect(userInput).toContain("Selective reporting in Table 3");
    expect(userInput).toContain("Missing license disclosure");

    expect(out.ethicsUsed).toBe(true);
    expect(out.ethicsSummary).toMatch(/CLEARED WITH CONDITIONS/);
    expect(out.ethicsSummary).toMatch(/1 critical, 1 major, 1 minor/);
    expect(out.recommendation).toBe("Major Revision");
  });

  it("does NOT include the ethics block when ethicsPromise rejects (ethics-failure gating)", async () => {
    const calls: Array<{ prompt: string; user: string }> = [];
    generateWithConfigMock.mockImplementation(async (_cfg, prompt, user) => {
      calls.push({ prompt, user });
      return { content: "Recommendation: Reject\n" };
    });

    const out = await runPeerReview({
      ...baseOpts,
      ethicsPromise: Promise.reject(new Error("ethics LLM down")),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].user).not.toContain("ETHICS CO-AUTHOR BLOCK");
    expect(out.ethicsUsed).toBe(false);
    expect(out.ethicsSummary).toBeUndefined();
    expect(out.recommendation).toBe("Reject");
  });

  it("falls back to 'Major Revision' when output has no recognisable recommendation token", async () => {
    generateWithConfigMock.mockImplementation(async () => ({ content: "no verdict here" }));
    const out = await runPeerReview(baseOpts);
    expect(out.recommendation).toBe("Major Revision");
  });
});
