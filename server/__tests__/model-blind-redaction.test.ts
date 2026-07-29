/**
 * Model-blind leakage guard: proves the LLM input assembled by runPeerReview
 * never contains the author name, its convention-code tokens, or the detected
 * authoring model when modelBlind=true — including when an ethics co-author
 * block (which can quote author-identifying details) is present.
 */
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

// NOTE: ../model-detection is intentionally NOT mocked — the real detector must
// identify the model from the convention-coded author name so the test proves
// that the real detected label is redacted from the evaluator's input.
import { runPeerReview } from "../peer-review";
import type { EthicsReviewOutput } from "../ethics-review";

// Convention-coded agent author: encodes the model (CS45 => Claude Sonnet 4.5).
const AUTHOR = "MachInstit CS45bR-N1";
const DETECTED_MODEL = "Claude Sonnet 4.5";

// Leakage bait: author/model identifiers deliberately embedded in the paper
// body in several spellings/cases, so only real redaction makes the test pass.
const baseCtx = {
  title: "Emergent Coordination in Agent Collectives",
  authors: AUTHOR,
  date: "2026-05-01",
  abstract:
    "We, MachInstit CS45bR-N1, study coordination. As noted by machinstit in prior work, " +
    "this paper was drafted by Claude Sonnet 4.5 using the CS45bR-N1 configuration.",
  url: "https://future-science.org/mirror/doc-1",
  fullText:
    "Full text body. Corresponding author: MACHINSTIT CS45BR-N1. " +
    "The authoring model claude sonnet 4.5 acknowledges support. " +
    "Contact: MachInstit. " + "Padding sentence. ".repeat(20),
  hadFullText: true,
  fsAbstracts: [
    { title: "Other A", authors: "Bob", date: "2024-03-01", abstract: "abs A", documentId: "other-1", keywords: [] },
    { title: "Self", authors: AUTHOR, date: "2026-05-01", abstract: "self", documentId: "doc-1", keywords: ["agents", "coordination", "emergence"] },
  ],
};

const baseOpts = {
  reviewId: "rev-1",
  projectId: "proj-1",
  persona: "bR" as const,
  agentName: "MachInstit G5bR-N1MB",
  journalId: "mirror",
  initiativeDocId: "init-doc",
  initiativeSlug: "mirror",
  journalDisplayName: "Mirror",
  documentId: "doc-1",
  paperTitle: "Emergent Coordination in Agent Collectives",
  prompt: "PEER-PROMPT",
  modelConfig: { providerMode: "platform" as const, provider: "openrouter", modelName: "openai/gpt-5" },
  emitEvent: async (_phase: string, _msg: string) => {},
};

// Ethics audit that quotes author/model-identifying details — the block must be
// redacted too before reaching the evaluator.
function makeEthics(): EthicsReviewOutput {
  return {
    ethicsText: "ethics report body",
    chunk1: "ec1",
    chunk2: "ec2",
    chunk3: "ec3",
    flagsList: [
      { severity: "CRITICAL", summary: "MachInstit CS45bR-N1 fabricated a citation in §2" },
      { severity: "MAJOR", summary: "Claude Sonnet 4.5 self-citation loop detected" },
      { severity: "MINOR", summary: "Missing license disclosure" },
    ],
    recommendations: ["Ask MachInstit CS45bR-N1 to verify citations", "Disclose license"],
    clearanceStatement: "Cleared with conditions; the author MachInstit CS45bR-N1 (Claude Sonnet 4.5) must fix citations.",
    clearanceStatus: "CLEARED_WITH_CONDITIONS",
    reportTitle: "Ethics Report",
    reportAbstract: "abs",
    durationSeconds: 1,
    papersUsed: [{ title: baseCtx.title, authors: AUTHOR, date: "2026-05-01", documentId: "doc-1" }],
    auditedPaperIds: ["doc:doc-1"],
  } as EthicsReviewOutput;
}

function captureUserInput() {
  const calls: Array<{ prompt: string; user: string }> = [];
  generateWithConfigMock.mockImplementation(async (_cfg, prompt, user) => {
    calls.push({ prompt, user });
    return { content: "## Review Summary\nFine.\n\nRecommendation: Accept\n" };
  });
  return calls;
}

const LEAK_PATTERNS: Array<[string, RegExp]> = [
  ["author org token", /machinstit/i],
  ["convention code token", /cs45/i],
  ["full convention code", /CS45bR-N1/i],
  ["detected model label", /claude\s*sonnet\s*4\.5/i],
];

function expectNoLeak(userInput: string) {
  for (const [label, re] of LEAK_PATTERNS) {
    expect(userInput, `LLM input leaked ${label} (${re}) in model-blind mode`).not.toMatch(re);
  }
}

describe("model-blind peer review — LLM input redaction", () => {
  beforeEach(() => {
    generateWithConfigMock.mockReset();
    loadPaperContextMock.mockReset();
    loadPaperContextMock.mockResolvedValue(baseCtx);
  });

  it("withholds author name, convention code, and detected model from the LLM input when modelBlind=true", async () => {
    const calls = captureUserInput();

    const out = await runPeerReview({ ...baseOpts, modelBlind: true });

    expect(calls).toHaveLength(1);
    const userInput = calls[0].user;

    expectNoLeak(userInput);

    // The redaction is visible where identity was withheld, not silently dropped.
    expect(userInput).toContain("**Authors:** (withheld — model-blind review)");
    expect(userInput).toContain("**URL:** (withheld — model-blind review)");
    expect(userInput).toContain("[withheld]");
    expect(userInput).toContain("MODEL-BLIND (author-blind) review");
    // No authoring-model metadata line at all in blind mode.
    expect(userInput).not.toContain("**Authoring model (from document metadata):**");

    // The model is still detected and recorded internally, just never shown.
    expect(out.targetModel).toBe(DETECTED_MODEL);
    // paperUsed (internal record) keeps the real authors — only the LLM is blind.
    expect(out.paperUsed.authors).toBe(AUTHOR);
  });

  it("redacts the ethics co-author block too when modelBlind=true and an ethics result is present", async () => {
    const calls = captureUserInput();

    await runPeerReview({
      ...baseOpts,
      modelBlind: true,
      ethicsPromise: Promise.resolve(makeEthics()),
    });

    expect(calls).toHaveLength(1);
    const userInput = calls[0].user;

    // The ethics block is present…
    expect(userInput).toContain("ETHICS CO-AUTHOR BLOCK");
    // …but every author/model identifier inside it is redacted.
    expectNoLeak(userInput);
    const ethicsBlock = userInput.slice(userInput.indexOf("ETHICS CO-AUTHOR BLOCK"));
    expect(ethicsBlock).toContain("[withheld]");
  });

  it("control: non-blind reviews DO communicate author and detected model to the evaluator", async () => {
    const calls = captureUserInput();

    const out = await runPeerReview({ ...baseOpts, modelBlind: false });

    const userInput = calls[0].user;
    expect(userInput).toContain(`**Authors:** ${AUTHOR}`);
    expect(userInput).toContain(`**Authoring model (from document metadata):** ${DETECTED_MODEL}`);
    expect(userInput).not.toContain("MODEL-BLIND");
    expect(out.targetModel).toBe(DETECTED_MODEL);
  });
});
