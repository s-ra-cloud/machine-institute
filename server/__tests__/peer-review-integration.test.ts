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
  prompt1: "PROMPT-1",
  prompt2: "PROMPT-2",
  prompt3: "PROMPT-3",
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

  it("passes prompt1→chunk1, prompt2→chunk2, prompt3→chunk3 (in order) and parses recommendation from chunk 3", async () => {
    const calls: Array<{ prompt: string; user: string }> = [];
    generateWithConfigMock.mockImplementation(async (_cfg, prompt, user) => {
      calls.push({ prompt, user });
      if (prompt === "PROMPT-1") return { content: "### 1. Paper Summary\nC1 body" };
      if (prompt === "PROMPT-2") return { content: "### 5. Comparison\nC2 body" };
      if (prompt === "PROMPT-3") return { content: "### 9. Final Recommendation\nRecommendation: Minor Revision\n" };
      throw new Error("unexpected prompt");
    });

    const out = await runPeerReview(baseOpts);

    expect(calls).toHaveLength(3);
    expect(calls[0].prompt).toBe("PROMPT-1");
    expect(calls[1].prompt).toBe("PROMPT-2");
    expect(calls[2].prompt).toBe("PROMPT-3");

    // chunk 1 input is the paper body
    expect(calls[0].user).toContain("# SUBMITTED PAPER");
    expect(calls[0].user).toContain("A Test Paper");

    // chunk 2 input includes prior-literature block (other documents, not self)
    expect(calls[1].user).toContain("# PUBLICATIONS (Prior work from Mirror)");
    expect(calls[1].user).toContain("Other A");
    expect(calls[1].user).toContain("Other B");
    expect(calls[1].user).not.toContain('"Self"');

    // chunk 3 input is the synthesis of chunks 1 and 2
    expect(calls[2].user).toContain("# PART 1 (Sections 1–4)");
    expect(calls[2].user).toContain("C1 body");
    expect(calls[2].user).toContain("# PART 2 (Sections 5–6)");
    expect(calls[2].user).toContain("C2 body");

    expect(out.recommendation).toBe("Minor Revision");
    expect(out.ethicsUsed).toBe(false);
    expect(out.ethicsSummary).toBeUndefined();
    // chunk 3 must NOT contain ethics block when no ethics supplied
    expect(calls[2].user).not.toContain("ETHICS CO-AUTHOR BLOCK");
  });

  it("prepends the ethics co-author block into the chunk-3 input when ethicsPromise resolves", async () => {
    const calls: Array<{ prompt: string; user: string }> = [];
    generateWithConfigMock.mockImplementation(async (_cfg, prompt, user) => {
      calls.push({ prompt, user });
      if (prompt === "PROMPT-1") return { content: "C1" };
      if (prompt === "PROMPT-2") return { content: "C2" };
      return { content: "Recommendation: Major Revision\n" };
    });

    const ethics = makeEthics();
    const out = await runPeerReview({ ...baseOpts, ethicsPromise: Promise.resolve(ethics) });

    const chunk3Input = calls[2].user;
    expect(chunk3Input).toContain("ETHICS CO-AUTHOR BLOCK");
    expect(chunk3Input).toContain("CLEARED WITH CONDITIONS");
    expect(chunk3Input).toContain("Fabricated citation in §2");
    expect(chunk3Input).toContain("Selective reporting in Table 3");
    expect(chunk3Input).toContain("Missing license disclosure");

    expect(out.ethicsUsed).toBe(true);
    expect(out.ethicsSummary).toMatch(/CLEARED WITH CONDITIONS/);
    expect(out.ethicsSummary).toMatch(/1 critical, 1 major, 1 minor/);
    expect(out.recommendation).toBe("Major Revision");
  });

  it("does NOT include the ethics block when ethicsPromise rejects (ethics-failure gating)", async () => {
    const calls: Array<{ prompt: string; user: string }> = [];
    generateWithConfigMock.mockImplementation(async (_cfg, prompt, user) => {
      calls.push({ prompt, user });
      if (prompt === "PROMPT-1") return { content: "C1" };
      if (prompt === "PROMPT-2") return { content: "C2" };
      return { content: "Recommendation: Reject\n" };
    });

    const out = await runPeerReview({
      ...baseOpts,
      ethicsPromise: Promise.reject(new Error("ethics LLM down")),
    });

    expect(calls[2].user).not.toContain("ETHICS CO-AUTHOR BLOCK");
    expect(out.ethicsUsed).toBe(false);
    expect(out.ethicsSummary).toBeUndefined();
    expect(out.recommendation).toBe("Reject");
  });

  it("falls back to 'Major Revision' when chunk 3 has no recognisable recommendation token", async () => {
    generateWithConfigMock.mockImplementation(async (_cfg, prompt) => {
      if (prompt === "PROMPT-1") return { content: "C1" };
      if (prompt === "PROMPT-2") return { content: "C2" };
      return { content: "no verdict here" };
    });

    const out = await runPeerReview(baseOpts);
    expect(out.recommendation).toBe("Major Revision");
  });
});
