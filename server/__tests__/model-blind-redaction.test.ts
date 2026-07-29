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
    // Another catalogue paper by the SAME blinded author — must be excluded
    // from the prior-literature block in model-blind mode.
    { title: "Prior Work By Same Author", authors: AUTHOR, date: "2025-11-01", abstract: "Earlier study by the same agent.", documentId: "other-2", keywords: [] },
    // A co-authored paper listing the blinded author second — must also be excluded.
    { title: "Co-authored Prior Work", authors: `Alice; ${AUTHOR}`, date: "2025-06-01", abstract: "Joint study.", documentId: "other-3", keywords: [] },
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

    // Prior-literature block: other papers by the blinded author are excluded
    // entirely (their style/topic could reveal the withheld model), while
    // unrelated prior work remains listed.
    const priorLit = userInput.slice(userInput.indexOf("# PUBLICATIONS"));
    expect(priorLit).toContain("Other A");
    expect(priorLit).not.toContain("Prior Work By Same Author");
    expect(priorLit).not.toContain("Co-authored Prior Work");

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

  it("keeps the final published review (incl. H verification section) free of identifying info when modelBlind=true", async () => {
    // LLM echoes bait back — the final-text safety net must strip it.
    generateWithConfigMock.mockImplementation(async () => ({
      content:
        "## Review Summary\nSolid work by MachInstit CS45bR-N1, clearly written by Claude Sonnet 4.5 (a.k.a. ClaudeSonnet45, claude_sonnet-4.5).\n\nRecommendation: Accept\n",
    }));

    const out = await runPeerReview({
      ...baseOpts,
      modelBlind: true,
      ethicsPromise: Promise.resolve(makeEthics()),
    });

    // Verification section is present…
    expect(out.reviewText).toContain("Research Standards Verification");
    // …and neither it nor the review body reintroduces identity — including
    // model-name spelling variants.
    expectNoLeak(out.reviewText);
    expect(out.reviewText).not.toMatch(/claude[\s._/-]*sonnet[\s._/-]*4[\s._/-]*5/i);
    expectNoLeak(out.reviewAbstract);
    expect(out.reviewText).toContain("[withheld]");

    // targetModel is still recorded internally for analysis.
    expect(out.targetModel).toBe(DETECTED_MODEL);
  });

  it("never names the detected model in emitted research events when modelBlind=true (events are publicly readable)", async () => {
    captureUserInput();
    const events: string[] = [];

    await runPeerReview({
      ...baseOpts,
      modelBlind: true,
      emitEvent: async (_phase: string, msg: string) => { events.push(msg); },
    });

    expect(events.length).toBeGreaterThan(0);
    for (const msg of events) {
      expectNoLeak(msg);
    }
    // The event trail still records THAT a model was identified, just not which.
    expect(events.some(m => /identified from metadata and recorded internally/i.test(m))).toBe(true);
  });

  it("control: non-blind reviews DO communicate author and detected model to the evaluator", async () => {
    const calls = captureUserInput();

    const out = await runPeerReview({ ...baseOpts, modelBlind: false });

    const userInput = calls[0].user;
    expect(userInput).toContain(`**Authors:** ${AUTHOR}`);
    expect(userInput).toContain(`**Authoring model (from document metadata):** ${DETECTED_MODEL}`);
    expect(userInput).not.toContain("MODEL-BLIND");
    // Non-blind: same-author prior work stays visible with real author names.
    expect(userInput).toContain("Prior Work By Same Author");
    expect(userInput).toContain("Co-authored Prior Work");
    expect(out.targetModel).toBe(DETECTED_MODEL);
  });
});
